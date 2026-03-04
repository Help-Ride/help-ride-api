import type { Request, Response } from "express"
import jwt from "jsonwebtoken"
import Stripe from "stripe"
import prisma from "../lib/prisma.js"
import type { AuthRequest } from "../middleware/auth.js"
import { notifyNearbyDriversForRideRequest } from "../lib/nearbyDriverNotifications.js"
import { notifyUser } from "../lib/notifications.js"
import { dispatchRideRequest } from "../lib/realtime.js"
import { getStripeWebhookSecret, stripe } from "../lib/stripe.js"

const DEFAULT_CONNECT_COUNTRY = "CA"
const CONNECT_STATE_EXPIRES_IN = "2h"

type ConnectStatePayload = {
  sub: string
  acct: string
  kind: "connect_onboarding"
}

type ConnectStatusSummary =
  | "ready"
  | "pending_verification"
  | "requires_information"
  | "restricted"
  | "restricted_payouts"
  | "rejected"
  | "not_onboarded"

interface ResetStripeConnectBody {
  confirm?: string
}

function getConnectCountry() {
  const country = process.env.STRIPE_CONNECT_COUNTRY?.trim().toUpperCase()
  if (country && country.length === 2) {
    return country
  }
  return DEFAULT_CONNECT_COUNTRY
}

function getConnectBusinessProfile() {
  const url = process.env.STRIPE_CONNECT_BUSINESS_PROFILE_URL?.trim()
  const productDescription =
    process.env.STRIPE_CONNECT_BUSINESS_PROFILE_DESCRIPTION?.trim() ??
    "Ride-sharing transportation services through HelpRide app"
  const mccRaw = process.env.STRIPE_CONNECT_BUSINESS_PROFILE_MCC?.trim()
  const mcc = mccRaw && /^\d{4}$/.test(mccRaw) ? mccRaw : null

  return {
    ...(mcc ? { mcc } : {}),
    ...(url ? { url } : {}),
    ...(productDescription ? { product_description: productDescription } : {}),
  }
}

function getConnectOnboardingUrls() {
  const refreshUrlRaw = process.env.STRIPE_CONNECT_REFRESH_URL?.trim()
  const returnUrlRaw = process.env.STRIPE_CONNECT_RETURN_URL?.trim()

  if (!refreshUrlRaw || !returnUrlRaw) {
    throw new Error(
      "STRIPE_CONNECT_REFRESH_URL and STRIPE_CONNECT_RETURN_URL must be set"
    )
  }

  let refreshUrl: URL
  let returnUrl: URL
  try {
    refreshUrl = new URL(refreshUrlRaw)
    returnUrl = new URL(returnUrlRaw)
  } catch {
    throw new Error(
      "STRIPE_CONNECT_REFRESH_URL and STRIPE_CONNECT_RETURN_URL must be valid absolute URLs"
    )
  }

  if (refreshUrl.protocol !== "http:" && refreshUrl.protocol !== "https:") {
    throw new Error("STRIPE_CONNECT_REFRESH_URL must use http or https")
  }
  if (returnUrl.protocol !== "http:" && returnUrl.protocol !== "https:") {
    throw new Error("STRIPE_CONNECT_RETURN_URL must use http or https")
  }

  return {
    refreshUrl: refreshUrl.toString(),
    returnUrl: returnUrl.toString(),
  }
}

function getConnectStateSecret() {
  const secret =
    process.env.STRIPE_CONNECT_STATE_SECRET?.trim() ??
    process.env.JWT_ACCESS_SECRET?.trim()

  if (!secret) {
    throw new Error(
      "STRIPE_CONNECT_STATE_SECRET (or JWT_ACCESS_SECRET fallback) must be set"
    )
  }

  return secret
}

function isStripeConnectResetEnabled() {
  return process.env.STRIPE_CONNECT_RESET_ENABLED?.trim().toLowerCase() === "true"
}

function isUsingTestStripeKey() {
  return process.env.STRIPE_SECRET_KEY?.trim().startsWith("sk_test_") ?? false
}

function signConnectStateToken(payload: ConnectStatePayload) {
  return jwt.sign(payload, getConnectStateSecret(), {
    expiresIn: CONNECT_STATE_EXPIRES_IN,
  })
}

function verifyConnectStateToken(token: string): ConnectStatePayload {
  const payload = jwt.verify(token, getConnectStateSecret()) as
    | Partial<ConnectStatePayload>
    | undefined

  if (
    !payload ||
    payload.kind !== "connect_onboarding" ||
    typeof payload.sub !== "string" ||
    payload.sub.trim().length === 0 ||
    typeof payload.acct !== "string" ||
    payload.acct.trim().length === 0
  ) {
    throw new Error("Invalid connect state token")
  }

  return {
    kind: "connect_onboarding",
    sub: payload.sub,
    acct: payload.acct,
  }
}

function withConnectState(baseUrl: string, stateToken: string) {
  const url = new URL(baseUrl)
  url.searchParams.set("state", stateToken)
  return url.toString()
}

function getConnectStateFromQuery(req: Request) {
  if (typeof req.query.state !== "string" || req.query.state.trim().length === 0) {
    return null
  }
  return req.query.state.trim()
}

async function createStripeConnectAccountLink(args: {
  accountId: string
  userId: string
}) {
  const stateToken = signConnectStateToken({
    sub: args.userId,
    acct: args.accountId,
    kind: "connect_onboarding",
  })

  const { refreshUrl, returnUrl } = getConnectOnboardingUrls()

  return stripe.accountLinks.create({
    account: args.accountId,
    refresh_url: withConnectState(refreshUrl, stateToken),
    return_url: withConnectState(returnUrl, stateToken),
    type: "account_onboarding",
    collection_options: {
      fields: "currently_due",
    },
  })
}

function mapConnectStatusForMissingAccount(disabledReason: string | null) {
  return {
    statusSummary: "not_onboarded" as ConnectStatusSummary,
    hasStripeAccount: false,
    onboardingComplete: false,
    payoutsEnabled: false,
    chargesEnabled: false,
    detailsSubmitted: false,
    requirementsCurrentlyDue: [],
    requirementsPendingVerification: [],
    requirementsErrors: [],
    requirementsEventuallyDue: [],
    disabledReason,
  }
}

function renderConnectReturnHtml(payload: {
  statusSummary: ConnectStatusSummary
  onboardingComplete: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  stripeAccountId: string | null
}) {
  const statusLabel =
    payload.statusSummary === "ready"
      ? "Stripe setup complete"
      : payload.statusSummary === "pending_verification"
        ? "Stripe verification in progress"
        : "Stripe setup still needs action"
  const detailLabel =
    payload.statusSummary === "ready"
      ? "You can return to the app."
      : payload.statusSummary === "pending_verification"
        ? "No action needed right now. Stripe is reviewing submitted details."
        : "Please return to the app and continue onboarding."

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>HelpRide Stripe Setup</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #f5f7fb; color: #0f172a; }
      .card { max-width: 520px; margin: 24px auto; background: #ffffff; border-radius: 12px; padding: 24px; box-shadow: 0 8px 30px rgba(15, 23, 42, 0.08); }
      h1 { margin: 0 0 12px; font-size: 22px; }
      p { margin: 8px 0; line-height: 1.45; }
      .meta { margin-top: 16px; color: #475569; font-size: 14px; }
      .pill { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 13px; background: #e2e8f0; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${statusLabel}</h1>
      <p>${detailLabel}</p>
      <p class="meta">Payouts enabled: <span class="pill">${payload.payoutsEnabled}</span></p>
      <p class="meta">Details submitted: <span class="pill">${payload.detailsSubmitted}</span></p>
      <p class="meta">Stripe account: <span class="pill">${payload.stripeAccountId ?? "N/A"}</span></p>
    </div>
  </body>
</html>`
}

function wantsJsonResponse(req: Request) {
  if (typeof req.query.format === "string" && req.query.format.toLowerCase() === "json") {
    return true
  }
  const accepted = req.accepts(["html", "json"])
  return accepted === "json"
}

function getConnectAppReturnUrl() {
  const raw = process.env.STRIPE_CONNECT_APP_RETURN_URL?.trim()
  if (!raw) {
    return null
  }
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

function mapStripeStatusSummary(account: Stripe.Account): ConnectStatusSummary {
  const disabledReason = account.requirements?.disabled_reason ?? null
  const currentlyDue = account.requirements?.currently_due ?? []
  const pendingVerification = account.requirements?.pending_verification ?? []

  if (
    account.payouts_enabled &&
    account.details_submitted &&
    currentlyDue.length === 0 &&
    pendingVerification.length === 0 &&
    disabledReason == null
  ) {
    return "ready"
  }

  if (
    disabledReason === "requirements.pending_verification" ||
    pendingVerification.length > 0
  ) {
    return "pending_verification"
  }

  if (
    disabledReason === "requirements.past_due" ||
    currentlyDue.length > 0
  ) {
    return "requires_information"
  }

  if (disabledReason?.startsWith("rejected.")) {
    return "rejected"
  }

  if (!account.payouts_enabled && account.charges_enabled) {
    return "restricted_payouts"
  }

  return "restricted"
}

async function getStripeAccountStatusById(stripeAccountId: string) {
  try {
    const account = await stripe.accounts.retrieve(stripeAccountId)
    if ("deleted" in account && account.deleted) {
      return mapConnectStatusForMissingAccount("account_deleted")
    }
    return {
      hasStripeAccount: true,
      ...mapStripeAccountStatus(account),
    }
  } catch (err) {
    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
      return mapConnectStatusForMissingAccount("account_not_found")
    }
    throw err
  }
}

async function getConnectStatusPayloadForUser(user: {
  stripeAccountId: string | null
}) {
  if (!user.stripeAccountId) {
    return mapConnectStatusForMissingAccount(null)
  }

  return getStripeAccountStatusById(user.stripeAccountId)
}

async function resolveConnectUserFromState(stateToken: string) {
  const state = verifyConnectStateToken(stateToken)
  const user = await prisma.user.findUnique({
    where: { id: state.sub },
    select: {
      id: true,
      name: true,
      email: true,
      stripeAccountId: true,
      driverProfile: {
        select: { id: true },
      },
    },
  })

  if (!user) {
    return { state, user: null }
  }

  if (!user.driverProfile) {
    return { state, user: null }
  }

  return { state, user }
}

function buildAppReturnUrl(baseUrl: string, payload: {
  onboardingComplete: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  stripeAccountId: string | null
}) {
  const url = new URL(baseUrl)
  url.searchParams.set("onboardingComplete", String(payload.onboardingComplete))
  url.searchParams.set("payoutsEnabled", String(payload.payoutsEnabled))
  url.searchParams.set("detailsSubmitted", String(payload.detailsSubmitted))
  if (payload.stripeAccountId) {
    url.searchParams.set("stripeAccountId", payload.stripeAccountId)
  }
  return url.toString()
}

function mapStripeAccountStatus(account: Stripe.Account) {
  return {
    statusSummary: mapStripeStatusSummary(account),
    stripeAccountId: account.id,
    detailsSubmitted: account.details_submitted,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    onboardingComplete: account.details_submitted && account.payouts_enabled,
    requirementsCurrentlyDue: account.requirements?.currently_due ?? [],
    requirementsPendingVerification:
      account.requirements?.pending_verification ?? [],
    requirementsErrors: account.requirements?.errors ?? [],
    requirementsEventuallyDue: account.requirements?.eventually_due ?? [],
    disabledReason: account.requirements?.disabled_reason ?? null,
    defaultCurrency: account.default_currency ?? null,
  }
}

async function createConnectAccountForUser(args: {
  userId: string
  email: string
  name: string
}) {
  const createdAccount = await stripe.accounts.create({
    type: "express",
    country: getConnectCountry(),
    email: args.email,
    business_type: "individual",
    business_profile: getConnectBusinessProfile(),
    capabilities: {
      transfers: {
        requested: true,
      },
    },
    metadata: {
      userId: args.userId,
      userName: args.name,
      source: "help_ride_driver",
    },
  })

  await prisma.user.update({
    where: { id: args.userId },
    data: { stripeAccountId: createdAccount.id },
  })

  return createdAccount
}

async function getOrCreateConnectAccountForUser(args: {
  userId: string
  email: string
  name: string
  stripeAccountId: string | null
}) {
  if (args.stripeAccountId) {
    try {
      const existingAccount = await stripe.accounts.retrieve(args.stripeAccountId)
      if ("deleted" in existingAccount && existingAccount.deleted) {
        console.warn(
          "[stripe][connect] Existing connected account is deleted, creating a new one",
          JSON.stringify({
            userId: args.userId,
            stripeAccountId: args.stripeAccountId,
          })
        )
      } else {
        try {
          return await stripe.accounts.update(existingAccount.id, {
            business_profile: getConnectBusinessProfile(),
          })
        } catch (updateErr) {
          console.warn(
            "[stripe][connect] Failed to sync business profile on existing account",
            JSON.stringify({
              userId: args.userId,
              stripeAccountId: existingAccount.id,
            }),
            updateErr
          )
          return existingAccount
        }
      }
    } catch (err) {
      if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) {
        throw err
      }
      console.warn(
        "[stripe][connect] Existing connected account not found, creating a new one",
        JSON.stringify({
          userId: args.userId,
          stripeAccountId: args.stripeAccountId,
        })
      )
    }
  }

  return createConnectAccountForUser({
    userId: args.userId,
    email: args.email,
    name: args.name,
  })
}

/**
 * POST /api/stripe/connect/onboard
 * Creates (or reuses) a Stripe Connect account and returns onboarding link.
 */
export async function createStripeOnboardingLink(
  req: AuthRequest,
  res: Response
) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        name: true,
        email: true,
        stripeAccountId: true,
        driverProfile: {
          select: { id: true },
        },
      },
    })

    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    if (!user.driverProfile) {
      return res.status(403).json({
        error: "Driver profile is required before Stripe onboarding",
      })
    }

    const account = await getOrCreateConnectAccountForUser({
      userId: user.id,
      email: user.email,
      name: user.name,
      stripeAccountId: user.stripeAccountId,
    })

    const accountLink = await createStripeConnectAccountLink({
      accountId: account.id,
      userId: user.id,
    })

    return res.json({
      onboardingUrl: accountLink.url,
      expiresAt: accountLink.expires_at,
      ...mapStripeAccountStatus(account),
    })
  } catch (err) {
    console.error("POST /stripe/connect/onboard error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/stripe/connect/status
 * Driver checks Stripe Connect account readiness.
 */
export async function getStripeConnectStatus(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        stripeAccountId: true,
        driverProfile: {
          select: { id: true },
        },
      },
    })

    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    if (!user.driverProfile) {
      return res.status(403).json({
        error: "Driver profile is required for Stripe Connect status",
      })
    }

    const status = await getConnectStatusPayloadForUser(user)
    return res.json(status)
  } catch (err) {
    console.error("GET /stripe/connect/status error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/stripe/connect/dashboard-link
 * Returns a Stripe Express login link for the driver.
 */
export async function createStripeDashboardLink(
  req: AuthRequest,
  res: Response
) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        stripeAccountId: true,
        driverProfile: {
          select: { id: true },
        },
      },
    })

    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    if (!user.driverProfile) {
      return res.status(403).json({
        error: "Driver profile is required for Stripe dashboard access",
      })
    }

    if (!user.stripeAccountId) {
      return res.status(409).json({
        error: "Driver has no Stripe connected account. Complete onboarding first.",
      })
    }

    const loginLink = await stripe.accounts.createLoginLink(user.stripeAccountId)
    return res.json({ url: loginLink.url })
  } catch (err) {
    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
      return res.status(409).json({
        error: "Stripe dashboard is not available yet for this account",
      })
    }
    console.error("POST /stripe/connect/dashboard-link error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/stripe/connect/reset
 * Test-mode helper: deletes current connected account and creates a fresh onboarding link.
 */
export async function resetStripeConnectAccount(
  req: AuthRequest,
  res: Response
) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    if (!isStripeConnectResetEnabled()) {
      return res.status(403).json({
        error:
          "Stripe Connect reset endpoint is disabled. Set STRIPE_CONNECT_RESET_ENABLED=true to allow.",
      })
    }

    if (!isUsingTestStripeKey()) {
      return res.status(403).json({
        error: "Stripe Connect reset is allowed only with Stripe test API keys",
      })
    }

    const { confirm } = (req.body ?? {}) as ResetStripeConnectBody
    if (confirm !== "RESET_STRIPE_CONNECT") {
      return res.status(400).json({
        error: "confirm must be exactly RESET_STRIPE_CONNECT",
      })
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        name: true,
        email: true,
        stripeAccountId: true,
        driverProfile: {
          select: { id: true },
        },
      },
    })

    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    if (!user.driverProfile) {
      return res.status(403).json({
        error: "Driver profile is required before Stripe onboarding",
      })
    }

    const previousStripeAccountId = user.stripeAccountId
    let deletedFromStripe = false
    let deleteSkippedReason: string | null = null

    if (previousStripeAccountId) {
      try {
        const deleted = await stripe.accounts.del(previousStripeAccountId)
        deletedFromStripe = Boolean("deleted" in deleted && deleted.deleted)
      } catch (err) {
        if (err instanceof Stripe.errors.StripeInvalidRequestError) {
          deleteSkippedReason = "account_not_found_in_stripe"
        } else {
          throw err
        }
      }
    } else {
      deleteSkippedReason = "no_existing_connected_account"
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { stripeAccountId: null },
    })

    const newAccount = await createConnectAccountForUser({
      userId: user.id,
      email: user.email,
      name: user.name,
    })

    const accountLink = await createStripeConnectAccountLink({
      accountId: newAccount.id,
      userId: user.id,
    })

    return res.json({
      previousStripeAccountId,
      deletedFromStripe,
      deleteSkippedReason,
      onboardingUrl: accountLink.url,
      expiresAt: accountLink.expires_at,
      ...mapStripeAccountStatus(newAccount),
    })
  } catch (err) {
    console.error("POST /stripe/connect/reset error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/stripe/connect/refresh?state=...
 * Public refresh endpoint used by Stripe Account Link.
 */
export async function refreshStripeConnectOnboarding(
  req: Request,
  res: Response
) {
  try {
    const stateToken = getConnectStateFromQuery(req)
    if (!stateToken) {
      return res.status(400).json({ error: "Missing state token" })
    }

    const { user } = await resolveConnectUserFromState(stateToken)
    if (!user) {
      return res.status(404).json({ error: "Driver account not found" })
    }

    const account = await getOrCreateConnectAccountForUser({
      userId: user.id,
      email: user.email,
      name: user.name,
      stripeAccountId: user.stripeAccountId,
    })

    const accountLink = await createStripeConnectAccountLink({
      accountId: account.id,
      userId: user.id,
    })

    return res.redirect(accountLink.url)
  } catch (err) {
    if (
      err instanceof jwt.JsonWebTokenError ||
      err instanceof jwt.TokenExpiredError ||
      (err instanceof Error && err.message === "Invalid connect state token")
    ) {
      return res.status(400).json({ error: "Invalid or expired state token" })
    }
    console.error("GET /stripe/connect/refresh error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/stripe/connect/return?state=...
 * Public return endpoint used by Stripe Account Link.
 */
export async function handleStripeConnectReturn(
  req: Request,
  res: Response
) {
  try {
    const stateToken = getConnectStateFromQuery(req)
    if (!stateToken) {
      return res.status(400).json({ error: "Missing state token" })
    }

    const { user } = await resolveConnectUserFromState(stateToken)
    if (!user) {
      return res.status(404).json({ error: "Driver account not found" })
    }

    const connectStatus = await getConnectStatusPayloadForUser(user)
    const responsePayload = {
      statusSummary: connectStatus.statusSummary,
      onboardingComplete: Boolean(connectStatus.onboardingComplete),
      payoutsEnabled: Boolean(connectStatus.payoutsEnabled),
      detailsSubmitted: Boolean(connectStatus.detailsSubmitted),
      stripeAccountId:
        "stripeAccountId" in connectStatus
          ? connectStatus.stripeAccountId
          : null,
      status: connectStatus,
    }

    if (wantsJsonResponse(req)) {
      return res.json(responsePayload)
    }

    const appReturnUrl = getConnectAppReturnUrl()
    if (appReturnUrl) {
      return res.redirect(buildAppReturnUrl(appReturnUrl, responsePayload))
    }

    return res.type("html").send(renderConnectReturnHtml(responsePayload))
  } catch (err) {
    if (
      err instanceof jwt.JsonWebTokenError ||
      err instanceof jwt.TokenExpiredError ||
      (err instanceof Error && err.message === "Invalid connect state token")
    ) {
      return res.status(400).json({ error: "Invalid or expired state token" })
    }
    console.error("GET /stripe/connect/return error", err)
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

const DISPATCHABLE_RIDE_REQUEST_STATUSES = new Set([
  "PENDING",
  "OFFERING",
  "pending",
])

type DispatchableJitRideRequest = {
  id: string
  status: string
  driverId: string | null
  fromCity: string
  fromLat: number
  fromLng: number
  toCity: string
  toLat: number
  toLng: number
}

function canRedispatchRideRequest(request: DispatchableJitRideRequest) {
  return (
    DISPATCHABLE_RIDE_REQUEST_STATUSES.has(request.status) &&
    request.driverId == null
  )
}

async function dispatchJitRideRequest({
  eventId,
  paymentIntentId,
  rideRequest,
  source,
}: {
  eventId: string
  paymentIntentId: string
  rideRequest: DispatchableJitRideRequest
  source: "created" | "existing"
}) {
  try {
    await dispatchRideRequest({
      rideRequestId: rideRequest.id,
      pickupName: rideRequest.fromCity,
      pickupLat: rideRequest.fromLat,
      pickupLng: rideRequest.fromLng,
      dropoffName: rideRequest.toCity,
      dropoffLat: rideRequest.toLat,
      dropoffLng: rideRequest.toLng,
    })
    console.info(
      "[webhooks][stripe] JIT ride request dispatched",
      JSON.stringify({
        eventId,
        paymentIntentId,
        rideRequestId: rideRequest.id,
        source,
      })
    )
  } catch (dispatchErr) {
    console.error(
      "[webhooks][stripe] Failed to dispatch JIT ride request",
      JSON.stringify({
        eventId,
        paymentIntentId,
        rideRequestId: rideRequest.id,
        source,
      }),
      dispatchErr
    )
  }
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
    select: {
      id: true,
      status: true,
      driverId: true,
      fromCity: true,
      fromLat: true,
      fromLng: true,
      toCity: true,
      toLat: true,
      toLng: true,
    },
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

    if (canRedispatchRideRequest(existing)) {
      await dispatchJitRideRequest({
        eventId,
        paymentIntentId: intent.id,
        rideRequest: existing,
        source: "existing",
      })
    } else {
      console.info(
        "[webhooks][stripe] JIT ride request redispatch skipped",
        JSON.stringify({
          eventId,
          paymentIntentId: intent.id,
          rideRequestId: existing.id,
          status: existing.status,
          hasDriver: Boolean(existing.driverId),
        })
      )
    }

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

  await notifyUser({
    userId: passengerId,
    title: "Ride request created",
    body: `${createdRequest.fromCity} → ${createdRequest.toCity} request is now searching for drivers`,
    type: "ride_update",
    data: {
      rideRequestId: createdRequest.id,
      kind: "ride_request_created_jit",
    },
  })

  await dispatchJitRideRequest({
    eventId,
    paymentIntentId: intent.id,
    rideRequest: createdRequest,
    source: "created",
  })

  try {
    const nearbyNotification = await notifyNearbyDriversForRideRequest({
      rideRequestId: createdRequest.id,
      passengerId,
      pickupCity: createdRequest.fromCity,
      pickupLat: createdRequest.fromLat,
      pickupLng: createdRequest.fromLng,
      dropoffCity: createdRequest.toCity,
    })
    console.info(
      "[webhooks][stripe] nearby driver notification completed",
      JSON.stringify({
        eventId,
        paymentIntentId: intent.id,
        rideRequestId: createdRequest.id,
        matchedDrivers: nearbyNotification.matchedDrivers,
        notifiedDrivers: nearbyNotification.notifiedDrivers,
        radiusKm: nearbyNotification.radiusKm,
        maxLocationAgeMinutes: nearbyNotification.locationMaxAgeMinutes,
      })
    )
  } catch (notifyErr) {
    console.error(
      "[webhooks][stripe] nearby driver notification failed",
      JSON.stringify({
        eventId,
        paymentIntentId: intent.id,
        rideRequestId: createdRequest.id,
      }),
      notifyErr
    )
  }
}

type PaymentStatusUpdate = "succeeded" | "failed" | "refunded"
type BookingStatusUpdate = "CONFIRMED" | "ACCEPTED"
type BookingPaymentStatusUpdate = "paid" | "failed" | "refunded"

async function notifyBookingPaymentUpdate(payload: {
  paymentStatus: PaymentStatusUpdate
  bookingId: string
  rideId: string
  passengerId: string
  driverId: string
  fromCity: string
  toCity: string
}) {
  const routeLabel = `${payload.fromCity} → ${payload.toCity}`

  if (payload.paymentStatus === "succeeded") {
    await Promise.all([
      notifyUser({
        userId: payload.passengerId,
        title: "Payment successful",
        body: `${routeLabel} booking is confirmed`,
        type: "payment",
        data: {
          bookingId: payload.bookingId,
          rideId: payload.rideId,
          kind: "booking_payment_succeeded",
        },
      }),
      notifyUser({
        userId: payload.driverId,
        title: "Booking confirmed",
        body: `${routeLabel} payment was received`,
        type: "payment",
        data: {
          bookingId: payload.bookingId,
          rideId: payload.rideId,
          kind: "driver_booking_paid",
        },
      }),
    ])
    return
  }

  if (payload.paymentStatus === "failed") {
    await Promise.all([
      notifyUser({
        userId: payload.passengerId,
        title: "Payment failed",
        body: `${routeLabel} payment failed. Please retry.`,
        type: "payment",
        data: {
          bookingId: payload.bookingId,
          rideId: payload.rideId,
          kind: "booking_payment_failed",
        },
      }),
      notifyUser({
        userId: payload.driverId,
        title: "Passenger payment failed",
        body: `${routeLabel} payment did not complete`,
        type: "payment",
        data: {
          bookingId: payload.bookingId,
          rideId: payload.rideId,
          kind: "driver_booking_payment_failed",
        },
      }),
    ])
    return
  }

  await Promise.all([
    notifyUser({
      userId: payload.passengerId,
      title: "Refund processed",
      body: `${routeLabel} refund was processed`,
      type: "payment",
      data: {
        bookingId: payload.bookingId,
        rideId: payload.rideId,
        kind: "booking_refunded",
      },
    }),
    notifyUser({
      userId: payload.driverId,
      title: "Booking refunded",
      body: `${routeLabel} payment was refunded`,
      type: "payment",
      data: {
        bookingId: payload.bookingId,
        rideId: payload.rideId,
        kind: "driver_booking_refunded",
      },
    }),
  ])
}

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
          passengerId: true,
          ride: {
            select: {
              id: true,
              driverId: true,
              fromCity: true,
              toCity: true,
            },
          },
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

  await notifyBookingPaymentUpdate({
    paymentStatus,
    bookingId: payment.booking.id,
    rideId: payment.booking.ride.id,
    passengerId: payment.booking.passengerId,
    driverId: payment.booking.ride.driverId,
    fromCity: payment.booking.ride.fromCity,
    toCity: payment.booking.ride.toCity,
  })
}
