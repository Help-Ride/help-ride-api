import type { Request, Response } from "express"
import Stripe from "stripe"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"
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

  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object as Stripe.PaymentIntent
    if (!intent?.id) {
      return res.status(400).send("Invalid PaymentIntent")
    }
    await handlePaymentIntentUpdate(intent.id, "succeeded", "CONFIRMED")
  }

  if (event.type === "payment_intent.payment_failed") {
    const intent = event.data.object as Stripe.PaymentIntent
    if (!intent?.id) {
      return res.status(400).send("Invalid PaymentIntent")
    }
    await handlePaymentIntentUpdate(intent.id, "failed", "ACCEPTED")
  }

  return res.json({ received: true })
}

async function handlePaymentIntentUpdate(
  paymentIntentId: string,
  paymentStatus: "succeeded" | "failed",
  bookingStatus: "CONFIRMED" | "ACCEPTED"
) {
  const payment = await prisma.payment.findUnique({
    where: { paymentIntentId },
    select: { id: true, bookingId: true, status: true },
  })

  if (!payment) {
    return
  }

  if (payment.status === paymentStatus) {
    return
  }

  await prisma.$transaction([
    prisma.payment.update({
      where: { id: payment.id },
      data: { status: paymentStatus },
    }),
    prisma.booking.update({
      where: { id: payment.bookingId },
      data: { status: bookingStatus, paymentStatus },
    }),
  ])
}
