import Stripe from "stripe"

const stripeSecretKey = process.env.STRIPE_SECRET_KEY

if (!stripeSecretKey) {
  throw new Error("STRIPE_SECRET_KEY is not set")
}

export const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2024-06-20",
})

export function getStripeWebhookSecret() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set")
  }
  return secret
}

export function getStripePlatformFeePct() {
  const raw = process.env.STRIPE_PLATFORM_FEE_PCT
  if (!raw) {
    throw new Error("STRIPE_PLATFORM_FEE_PCT is not set")
  }

  const pct = Number(raw)
  if (!Number.isFinite(pct) || pct < 0 || pct > 1) {
    throw new Error("STRIPE_PLATFORM_FEE_PCT must be a number between 0 and 1")
  }

  return pct
}
