import Stripe from "stripe"
import prisma from "./prisma.js"
import { stripe } from "./stripe.js"

const PAID_BOOKING_PAYMENT_STATUSES = new Set(["paid", "succeeded"])
const ALREADY_REFUNDED_STATUSES = new Set(["refunded"])
const PASSENGER_BOOKING_REFUND_WINDOW_MS = 2 * 60 * 60 * 1000

export type RefundSource =
  | "passenger_cancel_booking"
  | "driver_cancel_booking"
  | "driver_cancel_ride"
  | "passenger_cancel_ride_request"
  | "jit_request_expired"

export interface InitiateBookingRefundInput {
  bookingId: string
  paymentStatus: string
  stripePaymentIntentId: string | null
  source: RefundSource
  rideStartTime?: Date | null
}

export interface InitiateRideRequestRefundInput {
  rideRequestId: string
  stripePaymentIntentId: string | null
  source: Extract<
    RefundSource,
    "passenger_cancel_ride_request" | "jit_request_expired"
  >
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
  rideStartTime,
}: InitiateBookingRefundInput) {
  if (ALREADY_REFUNDED_STATUSES.has(paymentStatus)) {
    return { refunded: false, reason: "already_refunded" as const }
  }

  if (!PAID_BOOKING_PAYMENT_STATUSES.has(paymentStatus)) {
    return { refunded: false, reason: "not_paid" as const }
  }

  if (source === "passenger_cancel_booking") {
    if (!rideStartTime) {
      throw new Error(
        `Booking ${bookingId} passenger refund check requires rideStartTime`
      )
    }

    const startsInMs = rideStartTime.getTime() - Date.now()
    if (startsInMs <= PASSENGER_BOOKING_REFUND_WINDOW_MS) {
      console.info(
        "[payments] Refund skipped for late passenger cancellation",
        JSON.stringify({
          bookingId,
          rideStartTime: rideStartTime.toISOString(),
          startsInMs,
          source,
        })
      )

      return {
        refunded: false,
        reason: "outside_refund_window" as const,
      }
    }
  }

  if (!stripePaymentIntentId) {
    throw new Error(
      `Booking ${bookingId} is paid but missing stripePaymentIntentId`
    )
  }

  const [existingPayment, existingRideRequestPayment] = await Promise.all([
    prisma.payment.findUnique({
      where: { paymentIntentId: stripePaymentIntentId },
      select: { status: true },
    }),
    prisma.rideRequestPayment.findUnique({
      where: { paymentIntentId: stripePaymentIntentId },
      select: { status: true },
    }),
  ])

  if (
    existingPayment?.status === "refunded" ||
    existingRideRequestPayment?.status === "refunded"
  ) {
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

export async function initiateRideRequestRefund({
  rideRequestId,
  stripePaymentIntentId,
  source,
}: InitiateRideRequestRefundInput) {
  if (!stripePaymentIntentId) {
    return { refunded: false, reason: "missing_payment_intent" as const }
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
          rideRequestId,
          source,
        },
      },
      {
        idempotencyKey: `ride_request:${rideRequestId}:refund:${source}`,
      }
    )

    console.info(
      "[payments] Ride request refund initiated",
      JSON.stringify({
        rideRequestId,
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
        "[payments] Ride request refund already processed",
        JSON.stringify({
          rideRequestId,
          paymentIntentId: stripePaymentIntentId,
          source,
        })
      )

      return { refunded: false, reason: "already_refunded" as const }
    }

    throw err
  }
}
