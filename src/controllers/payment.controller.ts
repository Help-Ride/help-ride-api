import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"
import { calculateBookingFareCents } from "../lib/payments.js"
import { getStripePlatformFeePct, stripe } from "../lib/stripe.js"

interface CreatePaymentIntentBody {
  bookingId?: string
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
        seatsBooked: true,
        passengerId: true,
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
                stripeAccountId: true,
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

    if (booking.status !== "ACCEPTED") {
      return res.status(400).json({
        error: "Booking must be accepted before payment",
      })
    }

    const driverStripeAccountId = booking.ride.driver.stripeAccountId
    if (!driverStripeAccountId) {
      return res.status(400).json({
        error: "Driver has not completed Stripe onboarding",
      })
    }

    const pricePerSeat = Number(booking.ride.pricePerSeat)
    if (!Number.isFinite(pricePerSeat)) {
      return res.status(400).json({ error: "Invalid ride pricing" })
    }

    const { distanceKm, fareCents } = calculateBookingFareCents({
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

    const platformFeePct = getStripePlatformFeePct()
    const platformFeeCents = Math.round(fareCents * platformFeePct)

    if (platformFeeCents < 0 || platformFeeCents > fareCents) {
      return res.status(400).json({ error: "Invalid platform fee" })
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: fareCents,
      currency: "cad",
      automatic_payment_methods: { enabled: true },
      application_fee_amount: platformFeeCents,
      transfer_data: {
        destination: driverStripeAccountId,
      },
      metadata: {
        bookingId: booking.id,
        passengerId: booking.passengerId,
        driverId: booking.ride.driver.id,
        distanceKm: distanceKm.toFixed(2),
      },
    })

    if (!paymentIntent.client_secret) {
      return res.status(500).json({ error: "Payment intent missing client secret" })
    }

    await prisma.$transaction([
      prisma.payment.create({
        data: {
          bookingId: booking.id,
          paymentIntentId: paymentIntent.id,
          amountCents: fareCents,
          platformFeeCents,
          currency: "cad",
          status: "pending",
        },
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

    return res.json({ clientSecret: paymentIntent.client_secret })
  } catch (err) {
    console.error("POST /payments/intent error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
