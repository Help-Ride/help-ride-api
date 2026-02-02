import type { Request, Response } from "express"
import Stripe from "stripe"
import prisma from "../lib/prisma.js"
import type { AuthRequest } from "../middleware/auth.js"
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
      await handlePaymentIntentUpdate({
        eventId: event.id,
        paymentIntentId: intent.id,
        paymentStatus: "succeeded",
        bookingStatus: "CONFIRMED",
        bookingPaymentStatus: "paid",
      })
    }

    if (event.type === "payment_intent.payment_failed") {
      const intent = event.data.object as Stripe.PaymentIntent
      if (!intent?.id) {
        return res.status(400).send("Invalid PaymentIntent")
      }
      await handlePaymentIntentUpdate({
        eventId: event.id,
        paymentIntentId: intent.id,
        paymentStatus: "failed",
        bookingStatus: "ACCEPTED",
        bookingPaymentStatus: "failed",
      })
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
