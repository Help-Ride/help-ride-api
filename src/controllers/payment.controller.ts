import type { Response } from "express"
import Stripe from "stripe"
import prisma from "../lib/prisma.js"
import type { AuthRequest } from "../middleware/auth.js"
import { calculateBookingFareCents } from "../lib/payments.js"
import { getPlatformFeePct, stripe } from "../lib/stripe.js"

interface CreatePaymentIntentBody {
  bookingId?: string
}

const CURRENCY = "cad"
const ALREADY_PAID_STATUSES = new Set(["paid", "succeeded"])

function mapIntentStatusToPaymentStatus(
  status: Stripe.PaymentIntent.Status
): "pending" | "succeeded" | "failed" {
  if (status === "succeeded") {
    return "succeeded"
  }
  if (status === "canceled") {
    return "failed"
  }
  return "pending"
}

function upsertPaymentRecordFromIntent({
  bookingId,
  paymentIntent,
  fallbackAmountCents,
  platformFeeCents,
}: {
  bookingId: string
  paymentIntent: Stripe.PaymentIntent
  fallbackAmountCents: number
  platformFeeCents: number
}) {
  const amountCents = paymentIntent.amount ?? fallbackAmountCents
  const currency = paymentIntent.currency ?? CURRENCY
  const status = mapIntentStatusToPaymentStatus(paymentIntent.status)

  return prisma.payment.upsert({
    where: { paymentIntentId: paymentIntent.id },
    create: {
      bookingId,
      paymentIntentId: paymentIntent.id,
      amountCents,
      platformFeeCents,
      currency,
      status,
    },
    update: {
      bookingId,
      amountCents,
      platformFeeCents,
      currency,
      status,
    },
  })
}

function canAccessBookingPayment(
  userId: string,
  booking: {
    passengerId: string
    ride: { driverId: string }
  }
) {
  return booking.passengerId === userId || booking.ride.driverId === userId
}

/**
 * POST /api/payments/intent
 * Passenger creates a PaymentIntent for an accepted booking
 */
export async function createPaymentIntent(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { bookingId } = (req.body ?? {}) as CreatePaymentIntentBody

    if (!bookingId) {
      return res.status(400).json({ error: "bookingId is required" })
    }

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        seatsBooked: true,
        passengerId: true,
        stripePaymentIntentId: true,
        ride: {
          select: {
            id: true,
            fromLat: true,
            fromLng: true,
            toLat: true,
            toLng: true,
            pricePerSeat: true,
            driver: {
              select: {
                id: true,
              },
            },
          },
        },
      },
    })

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" })
    }

    if (booking.passengerId !== req.userId) {
      return res.status(403).json({
        error: "You can only pay for your own bookings",
      })
    }

    if (ALREADY_PAID_STATUSES.has(booking.paymentStatus)) {
      return res.status(409).json({
        error: "Booking is already paid",
        paymentIntentId: booking.stripePaymentIntentId,
      })
    }

    if (booking.status !== "ACCEPTED" && booking.status !== "PAYMENT_PENDING") {
      return res.status(400).json({
        error: "Booking must be accepted before payment intent creation",
      })
    }

    const pricePerSeat = Number(booking.ride.pricePerSeat)
    if (!Number.isFinite(pricePerSeat)) {
      return res.status(400).json({ error: "Invalid ride pricing" })
    }

    const { distanceKm, fareCents, breakdown } = calculateBookingFareCents({
      fromLat: booking.ride.fromLat,
      fromLng: booking.ride.fromLng,
      toLat: booking.ride.toLat,
      toLng: booking.ride.toLng,
      pricePerSeat,
      seatsBooked: booking.seatsBooked,
    })

    if (!Number.isFinite(fareCents) || fareCents <= 0) {
      return res.status(400).json({ error: "Invalid fare amount" })
    }

    const platformFeePct = getPlatformFeePct()
    const platformFeeCents = Math.round(fareCents * platformFeePct)
    const driverEarningsCents = fareCents - platformFeeCents

    if (platformFeeCents < 0 || platformFeeCents > fareCents) {
      return res.status(400).json({ error: "Invalid platform fee" })
    }

    if (booking.stripePaymentIntentId) {
      try {
        const existingIntent = await stripe.paymentIntents.retrieve(
          booking.stripePaymentIntentId
        )

        if (existingIntent.status !== "canceled") {
          const existingAmountCents = existingIntent.amount ?? fareCents
          const existingPlatformFeeCents = Math.round(
            existingAmountCents * platformFeePct
          )

          await prisma.$transaction([
            upsertPaymentRecordFromIntent({
              bookingId: booking.id,
              paymentIntent: existingIntent,
              fallbackAmountCents: fareCents,
              platformFeeCents: existingPlatformFeeCents,
            }),
            ...(existingIntent.status === "succeeded"
              ? []
              : [
                  prisma.booking.update({
                    where: { id: booking.id },
                    data: {
                      status: "PAYMENT_PENDING",
                      paymentStatus: "pending",
                      stripePaymentIntentId: existingIntent.id,
                    },
                  }),
                ]),
          ])

          console.info(
            "[payments] Reusing existing payment intent",
            JSON.stringify({
              bookingId: booking.id,
              paymentIntentId: existingIntent.id,
              stripeStatus: existingIntent.status,
            })
          )

          return res.json({
            clientSecret: existingIntent.client_secret,
            paymentIntentId: existingIntent.id,
            amount: existingAmountCents,
            currency: existingIntent.currency ?? CURRENCY,
            helpRideFeeCents: existingPlatformFeeCents,
            driverEarningsCents: existingAmountCents - existingPlatformFeeCents,
          })
        }
      } catch (err) {
        console.warn(
          "[payments] Existing payment intent could not be reused, creating a new one",
          JSON.stringify({
            bookingId: booking.id,
            paymentIntentId: booking.stripePaymentIntentId,
          }),
          err
        )
      }
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: fareCents,
      currency: CURRENCY,
      automatic_payment_methods: { enabled: true },
      metadata: {
        bookingId: booking.id,
        passengerId: booking.passengerId,
        driverId: booking.ride.driver.id,
        distanceKm: distanceKm.toFixed(2),
        seatSubtotalCents: String(breakdown.seatSubtotalCents),
        baseFareCents: String(breakdown.baseFareCents),
        distanceCents: String(breakdown.distanceCents),
        serviceFeeCents: String(breakdown.serviceFeeCents),
        taxCents: String(breakdown.taxCents),
        helpRideFeeCents: String(platformFeeCents),
        driverEarningsCents: String(driverEarningsCents),
      },
    }, {
      idempotencyKey: `booking:${booking.id}:intent`,
    })

    if (!paymentIntent.client_secret) {
      return res.status(500).json({ error: "Payment intent missing client secret" })
    }

    await prisma.$transaction([
      upsertPaymentRecordFromIntent({
        bookingId: booking.id,
        paymentIntent,
        fallbackAmountCents: fareCents,
        platformFeeCents,
      }),
      prisma.booking.update({
        where: { id: booking.id },
        data: {
          status: "PAYMENT_PENDING",
          paymentStatus: "pending",
          stripePaymentIntentId: paymentIntent.id,
        },
      }),
    ])

    console.info(
      "[payments] Created payment intent",
      JSON.stringify({
        bookingId: booking.id,
        paymentIntentId: paymentIntent.id,
        amountCents: paymentIntent.amount,
      })
    )

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      helpRideFeeCents: platformFeeCents,
      driverEarningsCents,
    })
  } catch (err) {
    console.error("POST /payments/intent error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/payments/intent/:id
 * Passenger or driver can inspect a payment intent status for their booking.
 */
export async function getPaymentIntentById(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id: paymentIntentId } = req.params

    if (!paymentIntentId) {
      return res.status(400).json({ error: "payment intent id is required" })
    }

    const payment = await prisma.payment.findUnique({
      where: { paymentIntentId },
      select: {
        paymentIntentId: true,
        amountCents: true,
        platformFeeCents: true,
        currency: true,
        status: true,
        booking: {
          select: {
            id: true,
            status: true,
            paymentStatus: true,
            passengerId: true,
            ride: {
              select: {
                id: true,
                driverId: true,
              },
            },
          },
        },
      },
    })

    if (!payment) {
      return res.status(404).json({ error: "Payment intent not found" })
    }

    if (!canAccessBookingPayment(req.userId, payment.booking)) {
      return res.status(403).json({
        error: "You are not allowed to access this payment intent",
      })
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId)

    return res.json({
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      amount: paymentIntent.amount ?? payment.amountCents,
      currency: paymentIntent.currency ?? payment.currency,
      stripeStatus: paymentIntent.status,
      localStatus: payment.status,
      helpRideFeeCents: payment.platformFeeCents,
      driverEarningsCents: payment.amountCents - payment.platformFeeCents,
      bookingId: payment.booking.id,
      bookingStatus: payment.booking.status,
      bookingPaymentStatus: payment.booking.paymentStatus,
      rideId: payment.booking.ride.id,
    })
  } catch (err) {
    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
      return res.status(404).json({ error: "Payment intent not found in Stripe" })
    }
    console.error("GET /payments/intent/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
