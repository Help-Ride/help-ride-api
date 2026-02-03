import type { Request, Response } from "express"
import Stripe from "stripe"
import prisma from "../lib/prisma.js"
import type { AuthRequest } from "../middleware/auth.js"
import { dispatchRideRequest } from "../lib/realtime.js"
import { getStripeWebhookSecret, stripe } from "../lib/stripe.js"

/**
 * POST /api/stripe/connect/onboard
 * Disabled in Phase 1 (platform-only Stripe collection).
 */
export async function createStripeOnboardingLink(
  _req: AuthRequest,
  res: Response
) {
  return res.status(410).json({
    error:
      "Stripe Connect onboarding is disabled in Phase 1. Driver earnings are tracked in HelpRide only.",
  })
}

/**
 * POST /api/webhooks/stripe
 * Stripe webhook handler (raw body)
 */
export async function handleStripeWebhook(req: Request, res: Response) {
  const signature = req.headers["stripe-signature"]

  if (!signature || Array.isArray(signature)) {
    return res.status(400).send("Missing Stripe signature")
  }

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      getStripeWebhookSecret()
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error("Stripe webhook signature verification failed", err)
    return res.status(400).send(`Webhook Error: ${message}`)
  }

  try {
    console.info(
      "[webhooks][stripe] Received event",
      JSON.stringify({ eventId: event.id, type: event.type })
    )

    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object as Stripe.PaymentIntent
      if (!intent?.id) {
        return res.status(400).send("Invalid PaymentIntent")
      }
      if (intent.metadata?.flow === "ride_request_jit") {
        await handleJitRideRequestIntentSucceeded({
          eventId: event.id,
          intent,
        })
      } else {
        await handlePaymentIntentUpdate({
          eventId: event.id,
          paymentIntentId: intent.id,
          paymentStatus: "succeeded",
          bookingStatus: "CONFIRMED",
          bookingPaymentStatus: "paid",
        })
      }
    }

    if (event.type === "payment_intent.payment_failed") {
      const intent = event.data.object as Stripe.PaymentIntent
      if (!intent?.id) {
        return res.status(400).send("Invalid PaymentIntent")
      }
      if (intent.metadata?.flow !== "ride_request_jit") {
        await handlePaymentIntentUpdate({
          eventId: event.id,
          paymentIntentId: intent.id,
          paymentStatus: "failed",
          bookingStatus: "ACCEPTED",
          bookingPaymentStatus: "failed",
        })
      }
    }

    if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge
      const paymentIntentId =
        typeof charge.payment_intent === "string"
          ? charge.payment_intent
          : charge.payment_intent?.id

      if (!paymentIntentId) {
        return res.status(400).send("Invalid charge payment intent")
      }

      await handlePaymentIntentUpdate({
        eventId: event.id,
        paymentIntentId,
        paymentStatus: "refunded",
        bookingPaymentStatus: "refunded",
      })
    }
  } catch (err) {
    console.error("Stripe webhook processing failed", err)
    return res.status(500).send("Webhook processing failed")
  }

  return res.json({ received: true })
}

function requireMetadataString(
  metadata: Stripe.Metadata,
  key: string
): string {
  const value = metadata[key]
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing metadata field: ${key}`)
  }
  return value
}

function parseMetadataNumber(metadata: Stripe.Metadata, key: string): number {
  const value = requireMetadataString(metadata, key)
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid metadata number: ${key}`)
  }
  return parsed
}

async function handleJitRideRequestIntentSucceeded({
  eventId,
  intent,
}: {
  eventId: string
  intent: Stripe.PaymentIntent
}) {
  const existing = await prisma.rideRequest.findUnique({
    where: { jitPaymentIntentId: intent.id },
    select: { id: true, status: true, driverId: true },
  })

  if (existing) {
    console.info(
      "[webhooks][stripe] JIT ride request already created",
      JSON.stringify({
        eventId,
        paymentIntentId: intent.id,
        rideRequestId: existing.id,
      })
    )
    return
  }

  const metadata = intent.metadata ?? {}
  const passengerId = requireMetadataString(metadata, "passengerId")
  const fromCity = requireMetadataString(metadata, "fromCity")
  const fromLat = parseMetadataNumber(metadata, "fromLat")
  const fromLng = parseMetadataNumber(metadata, "fromLng")
  const toCity = requireMetadataString(metadata, "toCity")
  const toLat = parseMetadataNumber(metadata, "toLat")
  const toLng = parseMetadataNumber(metadata, "toLng")
  const preferredDateRaw = requireMetadataString(metadata, "preferredDate")
  const seatsNeeded = parseMetadataNumber(metadata, "seatsNeeded")
  const rideType = requireMetadataString(metadata, "rideType")
  const tripType = requireMetadataString(metadata, "tripType")

  const preferredDate = new Date(preferredDateRaw)
  if (Number.isNaN(preferredDate.getTime())) {
    throw new Error("Invalid metadata date: preferredDate")
  }

  const returnDateRaw = metadata.returnDate?.trim()
  const returnDate =
    returnDateRaw && returnDateRaw.length > 0 ? new Date(returnDateRaw) : null
  if (returnDate && Number.isNaN(returnDate.getTime())) {
    throw new Error("Invalid metadata date: returnDate")
  }

  const amountCents = intent.amount_received || intent.amount || 0
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error("Invalid payment amount for JIT ride request")
  }

  const quotedPriceFromMetadata = Number(metadata.quotedPricePerSeat ?? "")
  const quotedPricePerSeat =
    Number.isFinite(quotedPriceFromMetadata) && quotedPriceFromMetadata > 0
      ? quotedPriceFromMetadata
      : Number((amountCents / Math.max(seatsNeeded, 1) / 100).toFixed(2))

  const passenger = await prisma.user.findUnique({
    where: { id: passengerId },
    select: { id: true },
  })
  if (!passenger) {
    throw new Error("Passenger not found for JIT ride request payment")
  }

  const createdRequest = await prisma.rideRequest.create({
    data: {
      passengerId,
      mode: "JIT",
      jitPaymentIntentId: intent.id,
      jitAmountCents: amountCents,
      jitCurrency: intent.currency ?? "cad",
      quotedPricePerSeat,
      fromCity,
      fromLat,
      fromLng,
      toCity,
      toLat,
      toLng,
      preferredDate,
      preferredTime: metadata.preferredTime?.trim() || null,
      arrivalTime: metadata.arrivalTime?.trim() || null,
      seatsNeeded,
      rideType,
      tripType,
      returnDate,
      returnTime: metadata.returnTime?.trim() || null,
      status: "OFFERING",
    },
  })

  try {
    await dispatchRideRequest({
      rideRequestId: createdRequest.id,
      pickupName: createdRequest.fromCity,
      pickupLat: createdRequest.fromLat,
      pickupLng: createdRequest.fromLng,
      dropoffName: createdRequest.toCity,
      dropoffLat: createdRequest.toLat,
      dropoffLng: createdRequest.toLng,
    })
    console.info(
      "[webhooks][stripe] JIT ride request dispatched",
      JSON.stringify({
        eventId,
        paymentIntentId: intent.id,
        rideRequestId: createdRequest.id,
      })
    )
  } catch (dispatchErr) {
    console.error(
      "[webhooks][stripe] Failed to dispatch JIT ride request",
      JSON.stringify({
        eventId,
        paymentIntentId: intent.id,
        rideRequestId: createdRequest.id,
      }),
      dispatchErr
    )
  }
}

type PaymentStatusUpdate = "succeeded" | "failed" | "refunded"
type BookingStatusUpdate = "CONFIRMED" | "ACCEPTED"
type BookingPaymentStatusUpdate = "paid" | "failed" | "refunded"

async function handlePaymentIntentUpdate(
  args: {
    eventId: string
    paymentIntentId: string
    paymentStatus: PaymentStatusUpdate
    bookingPaymentStatus: BookingPaymentStatusUpdate
    bookingStatus?: BookingStatusUpdate
  }
) {
  const {
    eventId,
    paymentIntentId,
    paymentStatus,
    bookingPaymentStatus,
    bookingStatus,
  } = args

  const payment = await prisma.payment.findUnique({
    where: { paymentIntentId },
    select: {
      id: true,
      bookingId: true,
      status: true,
      booking: {
        select: {
          id: true,
          status: true,
          paymentStatus: true,
        },
      },
    },
  })

  if (!payment) {
    console.warn(
      "[webhooks][stripe] Payment not found for payment intent",
      JSON.stringify({ eventId, paymentIntentId })
    )
    return
  }

  const shouldUpdatePayment = payment.status !== paymentStatus
  const shouldUpdateBookingPayment =
    payment.booking.paymentStatus !== bookingPaymentStatus
  const hasBookingStatusUpdate =
    Boolean(bookingStatus) && payment.booking.status !== bookingStatus

  if (!shouldUpdatePayment && !shouldUpdateBookingPayment && !hasBookingStatusUpdate) {
    console.info(
      "[webhooks][stripe] Duplicate payment status event ignored",
      JSON.stringify({ eventId, paymentIntentId, status: paymentStatus })
    )
    return
  }

  const terminalBookingStatuses = new Set([
    "cancelled_by_passenger",
    "cancelled_by_driver",
    "completed",
  ])

  const canUpdateBookingStatus =
    Boolean(bookingStatus) && !terminalBookingStatuses.has(payment.booking.status)

  if (hasBookingStatusUpdate && !canUpdateBookingStatus) {
    console.info(
      "[webhooks][stripe] Booking status transition skipped for terminal booking",
      JSON.stringify({
        eventId,
        paymentIntentId,
        bookingId: payment.booking.id,
        bookingStatusCurrent: payment.booking.status,
        bookingStatusRequested: bookingStatus,
      })
    )
  }

  const bookingData: {
    status?: BookingStatusUpdate
    paymentStatus: BookingPaymentStatusUpdate
  } = {
    paymentStatus: bookingPaymentStatus,
  }

  if (bookingStatus && canUpdateBookingStatus) {
    bookingData.status = bookingStatus
  }

  const shouldPersistBooking =
    shouldUpdateBookingPayment || (hasBookingStatusUpdate && canUpdateBookingStatus)

  await prisma.$transaction([
    ...(shouldUpdatePayment
      ? [
          prisma.payment.update({
            where: { id: payment.id },
            data: { status: paymentStatus },
          }),
        ]
      : []),
    ...(shouldPersistBooking
      ? [
          prisma.booking.update({
            where: { id: payment.bookingId },
            data: bookingData,
          }),
        ]
      : []),
  ])

  console.info(
    "[webhooks][stripe] Payment status updated",
    JSON.stringify({
      eventId,
      paymentIntentId,
      paymentStatusFrom: payment.status,
      paymentStatusTo: paymentStatus,
      bookingStatusFrom: payment.booking.status,
      bookingStatusTo: bookingData.status ?? payment.booking.status,
      bookingPaymentStatusFrom: payment.booking.paymentStatus,
      bookingPaymentStatusTo: bookingPaymentStatus,
    })
  )
}
