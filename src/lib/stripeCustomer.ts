import Stripe from "stripe"
import { Prisma } from "../generated/prisma/client.js"
import prisma from "./prisma.js"
import { STRIPE_API_VERSION, stripe } from "./stripe.js"

export type PaymentSheetCustomerContext = {
  customerId: string
  customerEphemeralKeySecret: string
}

type StripeCustomerOwner = {
  id: string
  name: string
  email: string | null
  phone: string | null
  stripeCustomerId: string | null
}

function normalizeOptionalString(value: string | null | undefined) {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : undefined
}

function isDeletedCustomer(
  customer: Stripe.Customer | Stripe.DeletedCustomer
): customer is Stripe.DeletedCustomer {
  return "deleted" in customer && customer.deleted === true
}

function buildCustomerParams(user: StripeCustomerOwner) {
  return {
    name: normalizeOptionalString(user.name),
    email: normalizeOptionalString(user.email),
    phone: normalizeOptionalString(user.phone),
    metadata: {
      userId: user.id,
    },
  }
}

async function loadStripeCustomerOwner(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      stripeCustomerId: true,
    },
  })

  if (!user) {
    throw new Error("User not found")
  }

  return user
}

async function persistStripeCustomerId(args: {
  userId: string
  stripeCustomerId: string
}) {
  try {
    await prisma.user.update({
      where: { id: args.userId },
      data: { stripeCustomerId: args.stripeCustomerId },
    })
    return args.stripeCustomerId
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const existing = await prisma.user.findUnique({
        where: { id: args.userId },
        select: { stripeCustomerId: true },
      })

      if (existing?.stripeCustomerId) {
        return existing.stripeCustomerId
      }
    }

    throw err
  }
}

async function createStripeCustomer(user: StripeCustomerOwner) {
  const customer = await stripe.customers.create(buildCustomerParams(user))
  return persistStripeCustomerId({
    userId: user.id,
    stripeCustomerId: customer.id,
  })
}

async function syncStripeCustomer(customerId: string, user: StripeCustomerOwner) {
  try {
    await stripe.customers.update(customerId, buildCustomerParams(user))
  } catch (err) {
    console.warn(
      "[stripe][customer] Failed to sync Stripe customer details",
      JSON.stringify({
        userId: user.id,
        stripeCustomerId: customerId,
      }),
      err
    )
  }
}

export function extractCustomerId(
  customer:
    | string
    | Stripe.Customer
    | Stripe.DeletedCustomer
    | null
    | undefined
) {
  if (!customer) {
    return null
  }

  if (typeof customer === "string") {
    return customer
  }

  if (isDeletedCustomer(customer)) {
    return null
  }

  return customer.id
}

export async function ensureStripeCustomerIdForUser(userId: string) {
  const user = await loadStripeCustomerOwner(userId)

  if (user.stripeCustomerId) {
    try {
      const existing = await stripe.customers.retrieve(user.stripeCustomerId)
      if (!isDeletedCustomer(existing)) {
        await syncStripeCustomer(existing.id, user)
        return existing.id
      }
    } catch (err) {
      if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) {
        throw err
      }
    }
  }

  return createStripeCustomer(user)
}

export async function createPaymentSheetCustomerContext(
  userId: string
): Promise<PaymentSheetCustomerContext> {
  const customerId = await ensureStripeCustomerIdForUser(userId)
  const ephemeralKey = await stripe.ephemeralKeys.create(
    { customer: customerId },
    { apiVersion: STRIPE_API_VERSION }
  )

  if (!ephemeralKey.secret) {
    throw new Error("Stripe ephemeral key is missing a secret")
  }

  return {
    customerId,
    customerEphemeralKeySecret: ephemeralKey.secret,
  }
}
