import Stripe from "stripe"
import prisma from "./prisma.js"
import { stripe } from "./stripe.js"

const PAID_BOOKING_PAYMENT_STATUSES = new Set(["paid", "succeeded"])
const ALREADY_REFUNDED_STATUSES = new Set(["refunded"])

export type RefundSource =
  | "passenger_cancel_booking"
  | "driver_cancel_booking"
  | "driver_cancel_ride"

export interface InitiateBookingRefundInput {
  bookingId: string
  paymentStatus: string
  stripePaymentIntentId: string | null
  source: RefundSource
}

function isAlreadyRefundedStripeError(err: unknown) {
  if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) {
    return false
  }

  const message = (err.message ?? "").toLowerCase()
  return (
    err.code === "charge_already_refunded" ||
    message.includes("already refunded")
  )
}

export async function initiateBookingRefundIfPaid({
  bookingId,
  paymentStatus,
  stripePaymentIntentId,
  source,
}: InitiateBookingRefundInput) {
  if (ALREADY_REFUNDED_STATUSES.has(paymentStatus)) {
    return { refunded: false, reason: "already_refunded" as const }
  }

  if (!PAID_BOOKING_PAYMENT_STATUSES.has(paymentStatus)) {
    return { refunded: false, reason: "not_paid" as const }
  }

  if (!stripePaymentIntentId) {
    throw new Error(
      `Booking ${bookingId} is paid but missing stripePaymentIntentId`
    )
  }

  const existingPayment = await prisma.payment.findUnique({
    where: { paymentIntentId: stripePaymentIntentId },
    select: { status: true },
  })

  if (existingPayment?.status === "refunded") {
    return { refunded: false, reason: "already_refunded" as const }
  }

  try {
    const refund = await stripe.refunds.create(
      {
        payment_intent: stripePaymentIntentId,
        reason: "requested_by_customer",
        metadata: {
          bookingId,
          source,
        },
      },
      {
        idempotencyKey: `booking:${bookingId}:refund:${source}`,
      }
    )

    console.info(
      "[payments] Refund initiated",
      JSON.stringify({
        bookingId,
        paymentIntentId: stripePaymentIntentId,
        refundId: refund.id,
        refundStatus: refund.status,
        source,
      })
    )

    return {
      refunded: true,
      reason: "refund_initiated" as const,
      refundId: refund.id,
    }
  } catch (err) {
    if (isAlreadyRefundedStripeError(err)) {
      console.info(
        "[payments] Refund already processed",
        JSON.stringify({
          bookingId,
          paymentIntentId: stripePaymentIntentId,
          source,
        })
      )

      return { refunded: false, reason: "already_refunded" as const }
    }

    throw err
  }
}
