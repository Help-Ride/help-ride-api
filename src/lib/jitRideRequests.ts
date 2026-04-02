import prisma from "./prisma.js"
import { notifyUser, notifyUsersByIds } from "./notifications.js"
import { dispatchRideRequestCancel } from "./realtime.js"
import { initiateRideRequestRefund } from "./refunds.js"

const ACTIVE_JIT_REQUEST_STATUSES = ["PENDING", "OFFERING", "pending"] as const
const OPEN_OFFER_STATUSES = ["SENT", "pending"] as const
const DEFAULT_JIT_RIDE_REQUEST_EXPIRY_MINUTES = 20

const scheduledExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

type ExpirableJitRideRequest = {
  id: string
  createdAt: Date
  preferredDate: Date
  jitPaymentIntentId: string | null
  passengerId: string
  fromCity: string
  toCity: string
}

function getJitRideRequestExpiryMinutes() {
  const raw = process.env.JIT_RIDE_REQUEST_EXPIRY_MINUTES?.trim()
  if (!raw) {
    return DEFAULT_JIT_RIDE_REQUEST_EXPIRY_MINUTES
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_JIT_RIDE_REQUEST_EXPIRY_MINUTES
  }

  return Math.round(parsed)
}

export function getJitRideRequestExpiresAt(input: {
  createdAt: Date
  preferredDate: Date
}) {
  const expiryByWindow = new Date(
    input.createdAt.getTime() + getJitRideRequestExpiryMinutes() * 60 * 1000
  )

  return expiryByWindow.getTime() <= input.preferredDate.getTime()
    ? expiryByWindow
    : input.preferredDate
}

export function clearJitRideRequestExpirySchedule(rideRequestId: string) {
  const existing = scheduledExpiryTimers.get(rideRequestId)
  if (!existing) return
  clearTimeout(existing)
  scheduledExpiryTimers.delete(rideRequestId)
}

export function scheduleJitRideRequestExpiry(input: {
  rideRequestId: string
  createdAt: Date
  preferredDate: Date
}) {
  clearJitRideRequestExpirySchedule(input.rideRequestId)

  const expiresAt = getJitRideRequestExpiresAt({
    createdAt: input.createdAt,
    preferredDate: input.preferredDate,
  })
  const delayMs = expiresAt.getTime() - Date.now()

  if (delayMs <= 0) {
    void expireStaleJitRideRequests({
      rideRequestId: input.rideRequestId,
      now: new Date(),
    })
    return expiresAt
  }

  const timer = setTimeout(() => {
    scheduledExpiryTimers.delete(input.rideRequestId)
    void expireStaleJitRideRequests({
      rideRequestId: input.rideRequestId,
      now: new Date(),
    })
  }, delayMs)

  if (typeof timer.unref === "function") {
    timer.unref()
  }

  scheduledExpiryTimers.set(input.rideRequestId, timer)
  return expiresAt
}

export async function expireStaleJitRideRequests(input?: {
  rideRequestId?: string
  now?: Date
}) {
  const now = input?.now ?? new Date()

  const requests = await prisma.rideRequest.findMany({
    where: {
      mode: "JIT",
      driverId: null,
      status: { in: [...ACTIVE_JIT_REQUEST_STATUSES] },
      ...(input?.rideRequestId ? { id: input.rideRequestId } : {}),
    },
    select: {
      id: true,
      createdAt: true,
      preferredDate: true,
      jitPaymentIntentId: true,
      passengerId: true,
      fromCity: true,
      toCity: true,
    },
  })

  const expiredRequests = requests.filter((request) => {
    return (
      getJitRideRequestExpiresAt({
        createdAt: request.createdAt,
        preferredDate: request.preferredDate,
      }).getTime() <= now.getTime()
    )
  })

  const expiredIds: string[] = []
  const failedIds: string[] = []

  for (const request of expiredRequests) {
    try {
      await expireSingleJitRideRequest(request)
      expiredIds.push(request.id)
    } catch (err) {
      failedIds.push(request.id)
      console.error(
        "[jit] Failed to expire stale JIT ride request",
        JSON.stringify({ rideRequestId: request.id }),
        err
      )
    }
  }

  return { expiredIds, failedIds }
}

async function expireSingleJitRideRequest(request: ExpirableJitRideRequest) {
  const pendingOffers = await prisma.rideRequestOffer.findMany({
    where: {
      rideRequestId: request.id,
      status: { in: [...OPEN_OFFER_STATUSES] },
    },
    select: { driverId: true },
  })

  const pendingOfferDriverIds = Array.from(
    new Set(pendingOffers.map((offer) => offer.driverId))
  )

  const [expiredRequestResult] = await prisma.$transaction([
    prisma.rideRequest.updateMany({
      where: {
        id: request.id,
        mode: "JIT",
        driverId: null,
        status: { in: [...ACTIVE_JIT_REQUEST_STATUSES] },
      },
      data: { status: "EXPIRED" },
    }),
    prisma.rideRequestOffer.updateMany({
      where: {
        rideRequestId: request.id,
        status: { in: [...OPEN_OFFER_STATUSES] },
      },
      data: { status: "EXPIRED" },
    }),
  ])

  if (expiredRequestResult.count === 0) {
    return
  }

  clearJitRideRequestExpirySchedule(request.id)

  await initiateRideRequestRefund({
    rideRequestId: request.id,
    stripePaymentIntentId: request.jitPaymentIntentId,
    source: "jit_request_expired",
  })

  await notifyUser({
    userId: request.passengerId,
    title: "No driver found in time",
    body: `${request.fromCity} → ${request.toCity} request expired and your refund is being processed`,
    type: "payment",
    data: {
      rideRequestId: request.id,
      kind: "jit_ride_request_expired",
    },
  })

  if (pendingOfferDriverIds.length > 0) {
    await notifyUsersByIds({
      userIds: pendingOfferDriverIds,
      title: "Ride request expired",
      body: `${request.fromCity} → ${request.toCity} request is no longer accepting offers`,
      type: "ride_update",
      data: {
        rideRequestId: request.id,
        kind: "jit_ride_request_expired",
      },
    })
  }

  try {
    await dispatchRideRequestCancel({ rideRequestId: request.id })
  } catch (cancelErr) {
    console.error(
      "[jit] Failed to dispatch ride request cancellation",
      JSON.stringify({ rideRequestId: request.id }),
      cancelErr
    )
  }
}
