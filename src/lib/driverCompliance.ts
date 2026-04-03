import Stripe from "stripe"
import prisma from "./prisma.js"
import { stripe } from "./stripe.js"

export const DEFERRED_DRIVER_COMPLIANCE_RIDE_LIMIT = 5

export type DeferredDriverComplianceRequirement =
  | "stripe_setup"
  | "vehicle_registration"

export interface DeferredDriverComplianceState {
  completedRides: number
  threshold: number
  enforcementRequired: boolean
  missingRequirements: DeferredDriverComplianceRequirement[]
}

export async function getDeferredDriverComplianceState(
  driverId: string
): Promise<DeferredDriverComplianceState> {
  const [completedRides, user, ownershipDocument] = await Promise.all([
    prisma.ride.count({
      where: {
        driverId,
        status: "completed",
      },
    }),
    prisma.user.findUnique({
      where: { id: driverId },
      select: { stripeAccountId: true },
    }),
    prisma.driverDocument.findFirst({
      where: {
        userId: driverId,
        type: "ownership",
        status: { not: "rejected" },
      },
      select: { id: true },
    }),
  ])

  const enforcementRequired =
    completedRides >= DEFERRED_DRIVER_COMPLIANCE_RIDE_LIMIT

  if (!enforcementRequired) {
    return {
      completedRides,
      threshold: DEFERRED_DRIVER_COMPLIANCE_RIDE_LIMIT,
      enforcementRequired,
      missingRequirements: [],
    }
  }

  const missingRequirements: DeferredDriverComplianceRequirement[] = []

  const stripeReady = await hasCompletedStripeSetup(user?.stripeAccountId ?? null)
  if (!stripeReady) {
    missingRequirements.push("stripe_setup")
  }

  if (!ownershipDocument) {
    missingRequirements.push("vehicle_registration")
  }

  return {
    completedRides,
    threshold: DEFERRED_DRIVER_COMPLIANCE_RIDE_LIMIT,
    enforcementRequired,
    missingRequirements,
  }
}

async function hasCompletedStripeSetup(
  stripeAccountId: string | null
): Promise<boolean> {
  if (!stripeAccountId) {
    return false
  }

  try {
    const account = await stripe.accounts.retrieve(stripeAccountId)
    if ("deleted" in account && account.deleted) {
      return false
    }

    return Boolean(account.details_submitted)
  } catch (err) {
    if (
      err instanceof Stripe.errors.StripeInvalidRequestError ||
      (err instanceof Stripe.errors.StripePermissionError &&
        err.code === "account_invalid")
    ) {
      return false
    }

    console.error("[driverCompliance] Failed to read Stripe account status", {
      stripeAccountId,
      err,
    })
    return false
  }
}
