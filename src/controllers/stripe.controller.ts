import type { Request, Response } from "express"
import Stripe from "stripe"
import prisma from "../lib/prisma.js"
import type { AuthRequest } from "../middleware/auth.js"
import { getStripeWebhookSecret, stripe } from "../lib/stripe.js"

interface StripeOnboardBody {
  returnUrl?: string
  refreshUrl?: string
}

/**
 * POST /api/stripe/connect/onboard
 * Driver creates or reuses a Connect Express account and receives onboarding link.
 */
export async function createStripeOnboardingLink(
  req: AuthRequest,
  res: Response
) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    if (req.userRole !== "driver") {
      return res.status(403).json({ error: "Driver access required" })
    }

    const { returnUrl, refreshUrl } = (req.body ?? {}) as StripeOnboardBody

    const resolvedReturnUrl = returnUrl ?? process.env.STRIPE_CONNECT_RETURN_URL
    const resolvedRefreshUrl = refreshUrl ?? process.env.STRIPE_CONNECT_REFRESH_URL

    if (!resolvedReturnUrl || !resolvedRefreshUrl) {
      return res.status(400).json({
        error: "returnUrl and refreshUrl are required",
      })
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true, stripeAccountId: true },
    })

    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    let stripeAccountId = user.stripeAccountId

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        country: "CA",
        email: user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      })

      stripeAccountId = account.id

      await prisma.user.update({
        where: { id: user.id },
        data: { stripeAccountId },
      })
    }

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: resolvedRefreshUrl,
      return_url: resolvedReturnUrl,
      type: "account_onboarding",
    })

    return res.json({ url: accountLink.url })
  } catch (err) {
    console.error("POST /stripe/connect/onboard error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
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
