// src/controllers/rideRequest.controller.ts
import { createHash } from "node:crypto"
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"
import { notifyUsersByRole } from "../lib/notifications.js"
import { resolveSeatPrice } from "../lib/pricing.js"
import { initiateRideRequestRefund } from "../lib/refunds.js"
import { getPlatformFeePct, stripe } from "../lib/stripe.js"
import {
  dispatchRideRequest,
  dispatchRideRequestCancel,
  getRealtimeToApiSecret,
} from "../lib/realtime.js"

interface CreateRideRequestBody {
  fromCity?: string
  fromLat?: number
  fromLng?: number
  toCity?: string
  toLat?: number
  toLng?: number
  preferredDate?: string // ISO
  preferredTime?: string
  arrivalTime?: string
  seatsNeeded?: number
  rideType?: string
  tripType?: string
  returnDate?: string // ISO (optional)
  returnTime?: string
}

interface CreateJitRideRequestIntentBody extends CreateRideRequestBody {
  basePricePerSeat?: number
}

interface UpdateRideRequestBody {
  fromCity?: string
  fromLat?: number
  fromLng?: number
  toCity?: string
  toLat?: number
  toLng?: number
  preferredDate?: string
  preferredTime?: string
  arrivalTime?: string | null
  seatsNeeded?: number
  rideType?: string
  tripType?: string
  returnDate?: string | null
  returnTime?: string | null
}

interface AcceptRideRequestBody {
  driverId?: string
  rideId?: string | null
  seatsOffered?: number
  pricePerSeat?: number
}

const DEFAULT_RADIUS_KM = 25
const MAX_RADIUS_KM = 100
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const JIT_WINDOW_HOURS = 2
const DEFAULT_JIT_BASE_PRICE_PER_SEAT = 20

const ACTIVE_REQUEST_STATUSES = new Set(["PENDING", "OFFERING", "pending"])
const ACCEPTED_REQUEST_STATUSES = new Set(["ACCEPTED", "matched"])
const TERMINAL_REQUEST_STATUSES = new Set([
  "CANCELLED",
  "EXPIRED",
  "cancelled",
  "expired",
])

function validateAndParsePreferredDate(preferredDate: string | undefined): {
  date: Date | undefined
  error: string | null
} {
  if (!preferredDate) {
    return { date: undefined, error: null }
  }
  const d = new Date(preferredDate)
  if (Number.isNaN(d.getTime())) {
    return { date: undefined, error: "preferredDate must be a valid ISO date" }
  }
  return { date: d, error: null }
}

function isValidLatitude(value: number) {
  return Number.isFinite(value) && value >= -90 && value <= 90
}

function isValidLongitude(value: number) {
  return Number.isFinite(value) && value >= -180 && value <= 180
}

function parseNumber(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function getHoursUntil(date: Date, reference = new Date()) {
  return (date.getTime() - reference.getTime()) / (1000 * 60 * 60)
}

function getJitBasePricePerSeat() {
  const raw = process.env.JIT_BASE_PRICE_PER_SEAT
  if (!raw) {
    return DEFAULT_JIT_BASE_PRICE_PER_SEAT
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("JIT_BASE_PRICE_PER_SEAT must be a positive number")
  }

  return parsed
}

function buildJitIntentIdempotencyKey(input: {
  passengerId: string
  amountCents: number
  currency: string
  metadata: Record<string, string>
}) {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        amountCents: input.amountCents,
        currency: input.currency,
        metadata: input.metadata,
      })
    )
    .digest("hex")

  return `jit:${input.passengerId}:${fingerprint}`
}

/**
 * POST /api/ride-requests
 * Create a ride request (passenger)
 */
export async function createRide(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const body = (req.body ?? {}) as CreateRideRequestBody

    const {
      fromCity,
      fromLat,
      fromLng,
      toCity,
      toLat,
      toLng,
      preferredDate,
      preferredTime,
      arrivalTime,
      seatsNeeded,
      rideType,
      tripType,
      returnDate,
      returnTime,
    } = body

    // Basic validation
    if (
      !fromCity ||
      typeof fromLat !== "number" ||
      typeof fromLng !== "number" ||
      !toCity ||
      typeof toLat !== "number" ||
      typeof toLng !== "number" ||
      !preferredDate ||
      typeof seatsNeeded !== "number" ||
      !rideType ||
      !tripType
    ) {
      return res.status(400).json({
        error:
          "fromCity, fromLat, fromLng, toCity, toLat, toLng, preferredDate, seatsNeeded, rideType, and tripType are required",
      })
    }

    if (!isValidLatitude(fromLat) || !isValidLongitude(fromLng)) {
      return res.status(400).json({
        error: "fromLat must be between -90 and 90, fromLng between -180 and 180",
      })
    }

    if (!isValidLatitude(toLat) || !isValidLongitude(toLng)) {
      return res.status(400).json({
        error: "toLat must be between -90 and 90, toLng between -180 and 180",
      })
    }

    if (!Number.isFinite(seatsNeeded) || seatsNeeded <= 0) {
      return res
        .status(400)
        .json({ error: "seatsNeeded must be a positive integer" })
    }

    const preferredDateValue = new Date(preferredDate)
    if (Number.isNaN(preferredDateValue.getTime())) {
      return res
        .status(400)
        .json({ error: "preferredDate must be a valid ISO date" })
    }

    const hoursUntilDeparture = getHoursUntil(preferredDateValue)
    if (hoursUntilDeparture >= 0 && hoursUntilDeparture <= JIT_WINDOW_HOURS) {
      return res.status(400).json({
        error:
          "Use POST /api/ride-requests/jit/intent for ride requests within 2 hours",
      })
    }

    let returnDateValue: Date | null = null
    if (returnDate) {
      const d = new Date(returnDate)
      if (Number.isNaN(d.getTime())) {
        return res
          .status(400)
          .json({ error: "returnDate must be a valid ISO date" })
      }
      returnDateValue = d
    }

    const request = await prisma.rideRequest.create({
      data: {
        passengerId: req.userId,
        fromCity,
        fromLat,
        fromLng,
        toCity,
        toLat,
        toLng,
        preferredDate: preferredDateValue,
        preferredTime: preferredTime ?? null,
        arrivalTime: arrivalTime ?? null,
        seatsNeeded,
        rideType,
        tripType,
        returnDate: returnDateValue,
        returnTime: returnTime ?? null,
        mode: "OFFER",
        status: "PENDING",
      },
      include: {
        passenger: {
          select: {
            id: true,
            name: true,
            email: true,
            providerAvatarUrl: true,
          },
        },
      },
    })

    const offeringRequest = await prisma.rideRequest.update({
      where: { id: request.id },
      data: { status: "OFFERING" },
      include: {
        passenger: {
          select: {
            id: true,
            name: true,
            email: true,
            providerAvatarUrl: true,
          },
        },
      },
    })

    try {
      await dispatchRideRequest({
        rideRequestId: request.id,
        pickupName: request.fromCity,
        pickupLat: request.fromLat,
        pickupLng: request.fromLng,
        dropoffName: request.toCity,
        dropoffLat: request.toLat,
        dropoffLng: request.toLng,
      })
      console.info(
        "[realtime] dispatch request sent",
        JSON.stringify({ rideRequestId: request.id })
      )
    } catch (dispatchErr) {
      console.error(
        "[realtime] dispatch request failed",
        JSON.stringify({ rideRequestId: request.id }),
        dispatchErr
      )
    }

    await notifyUsersByRole({
      role: "driver",
      excludeUserId: req.userId,
      title: "New ride request",
      body: `${request.fromCity} → ${request.toCity} request posted`,
      type: "ride_update",
      data: {
        rideRequestId: request.id,
        kind: "ride_request_created",
      },
    })

    return res.status(201).json(offeringRequest)
  } catch (err) {
    console.error("POST /ride-requests error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/ride-requests/jit/intent
 * Passenger creates a payment intent for a just-in-time request (within 2 hours).
 * The actual ride request is created by webhook after successful payment.
 */
export async function createJitRideRequestPaymentIntent(
  req: AuthRequest,
  res: Response
) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const body = (req.body ?? {}) as CreateJitRideRequestIntentBody
    const {
      fromCity,
      fromLat,
      fromLng,
      toCity,
      toLat,
      toLng,
      preferredDate,
      preferredTime,
      arrivalTime,
      seatsNeeded,
      rideType,
      tripType,
      returnDate,
      returnTime,
      basePricePerSeat,
    } = body

    if (
      !fromCity ||
      typeof fromLat !== "number" ||
      typeof fromLng !== "number" ||
      !toCity ||
      typeof toLat !== "number" ||
      typeof toLng !== "number" ||
      !preferredDate ||
      typeof seatsNeeded !== "number" ||
      !rideType ||
      !tripType
    ) {
      return res.status(400).json({
        error:
          "fromCity, fromLat, fromLng, toCity, toLat, toLng, preferredDate, seatsNeeded, rideType, and tripType are required",
      })
    }

    if (!isValidLatitude(fromLat) || !isValidLongitude(fromLng)) {
      return res.status(400).json({
        error: "fromLat must be between -90 and 90, fromLng between -180 and 180",
      })
    }

    if (!isValidLatitude(toLat) || !isValidLongitude(toLng)) {
      return res.status(400).json({
        error: "toLat must be between -90 and 90, toLng between -180 and 180",
      })
    }

    if (!Number.isFinite(seatsNeeded) || seatsNeeded <= 0) {
      return res
        .status(400)
        .json({ error: "seatsNeeded must be a positive integer" })
    }

    const preferredDateValue = new Date(preferredDate)
    if (Number.isNaN(preferredDateValue.getTime())) {
      return res
        .status(400)
        .json({ error: "preferredDate must be a valid ISO date" })
    }

    const hoursUntilDeparture = getHoursUntil(preferredDateValue)
    if (hoursUntilDeparture < 0) {
      return res.status(400).json({
        error: "preferredDate must be in the future",
      })
    }
    if (hoursUntilDeparture > JIT_WINDOW_HOURS) {
      return res.status(400).json({
        error:
          "JIT request payment intent is only available for departures within 2 hours",
      })
    }

    let returnDateValue: Date | null = null
    if (returnDate) {
      const d = new Date(returnDate)
      if (Number.isNaN(d.getTime())) {
        return res
          .status(400)
          .json({ error: "returnDate must be a valid ISO date" })
      }
      returnDateValue = d
    }

    const fallbackBasePricePerSeat = getJitBasePricePerSeat()
    const resolvedBasePricePerSeat =
      basePricePerSeat != null
        ? Number(basePricePerSeat)
        : fallbackBasePricePerSeat

    if (
      !Number.isFinite(resolvedBasePricePerSeat) ||
      resolvedBasePricePerSeat <= 0
    ) {
      return res
        .status(400)
        .json({ error: "basePricePerSeat must be a positive number" })
    }

    const pricing = await resolveSeatPrice({
      fromCity,
      toCity,
      fromLat,
      fromLng,
      toLat,
      toLng,
      seats: seatsNeeded,
      basePricePerSeat: resolvedBasePricePerSeat,
      departureTime: preferredDateValue,
      bookedAt: new Date(),
      sameDestination: true,
    })

    const amountCents = Math.round(pricing.pricePerSeat * seatsNeeded * 100)
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: "Invalid JIT fare amount" })
    }

    const metadata = {
      flow: "ride_request_jit",
      mode: "JIT",
      passengerId: req.userId,
      fromCity,
      fromLat: String(fromLat),
      fromLng: String(fromLng),
      toCity,
      toLat: String(toLat),
      toLng: String(toLng),
      preferredDate: preferredDateValue.toISOString(),
      preferredTime: preferredTime ?? "",
      arrivalTime: arrivalTime ?? "",
      seatsNeeded: String(seatsNeeded),
      rideType,
      tripType,
      returnDate: returnDateValue?.toISOString() ?? "",
      returnTime: returnTime ?? "",
      quotedPricePerSeat: pricing.pricePerSeat.toFixed(2),
    }

    const idempotencyKey = buildJitIntentIdempotencyKey({
      passengerId: req.userId,
      amountCents,
      currency: "cad",
      metadata,
    })

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: "cad",
        automatic_payment_methods: { enabled: true },
        metadata,
      },
      { idempotencyKey }
    )

    if (!paymentIntent.client_secret) {
      return res.status(500).json({ error: "Payment intent missing client secret" })
    }

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      quotedPricePerSeat: pricing.pricePerSeat,
      requestMode: "JIT",
    })
  } catch (err) {
    console.error("POST /ride-requests/jit/intent error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function updateRide(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    const body = (req.body ?? {}) as UpdateRideRequestBody

    const {
      fromCity,
      fromLat,
      fromLng,
      toCity,
      toLat,
      toLng,
      preferredDate,
      preferredTime,
      arrivalTime,
      seatsNeeded,
      rideType,
      tripType,
      returnDate,
      returnTime,
    } = body

    const request = await prisma.rideRequest.findUnique({
      where: { id },
    })

    if (!request) {
      return res.status(404).json({ error: "Ride request not found" })
    }

    if (request.passengerId !== req.userId) {
      return res.status(403).json({
        error: "You can only update your own ride requests",
      })
    }

    const preferredDateResult = validateAndParsePreferredDate(preferredDate)
    if (preferredDateResult.error) {
      return res.status(400).json({ error: preferredDateResult.error })
    }

    if (fromLat !== undefined || fromLng !== undefined) {
      const parsedFromLat =
        typeof fromLat === "number" ? fromLat : parseNumber(fromLat)
      const parsedFromLng =
        typeof fromLng === "number" ? fromLng : parseNumber(fromLng)

      if (parsedFromLat == null || parsedFromLng == null) {
        return res
          .status(400)
          .json({ error: "fromLat and fromLng must be numbers" })
      }

      if (!isValidLatitude(parsedFromLat) || !isValidLongitude(parsedFromLng)) {
        return res.status(400).json({
          error:
            "fromLat must be between -90 and 90, fromLng between -180 and 180",
        })
      }
    }

    if (toLat !== undefined || toLng !== undefined) {
      const parsedToLat =
        typeof toLat === "number" ? toLat : parseNumber(toLat)
      const parsedToLng =
        typeof toLng === "number" ? toLng : parseNumber(toLng)

      if (parsedToLat == null || parsedToLng == null) {
        return res
          .status(400)
          .json({ error: "toLat and toLng must be numbers" })
      }

      if (!isValidLatitude(parsedToLat) || !isValidLongitude(parsedToLng)) {
        return res.status(400).json({
          error: "toLat must be between -90 and 90, toLng between -180 and 180",
        })
      }
    }

    if (seatsNeeded !== undefined) {
      if (!Number.isFinite(seatsNeeded) || seatsNeeded <= 0) {
        return res
          .status(400)
          .json({ error: "seatsNeeded must be a positive integer" })
      }
    }

    let returnDateValue: Date | null | undefined
    if (returnDate !== undefined) {
      if (returnDate === null || returnDate === "") {
        returnDateValue = null
      } else {
        const d = new Date(returnDate)
        if (Number.isNaN(d.getTime())) {
          return res
            .status(400)
            .json({ error: "returnDate must be a valid ISO date" })
        }
        returnDateValue = d
      }
    }

    const updated = await prisma.rideRequest.update({
      where: { id },
      data: {
        fromCity: fromCity ?? request.fromCity,
        fromLat: fromLat ?? request.fromLat,
        fromLng: fromLng ?? request.fromLng,
        toCity: toCity ?? request.toCity,
        toLat: toLat ?? request.toLat,
        toLng: toLng ?? request.toLng,
        preferredDate: preferredDateResult.date ?? request.preferredDate,
        preferredTime:
          preferredTime !== undefined ? preferredTime : request.preferredTime,
        arrivalTime: arrivalTime !== undefined ? arrivalTime : request.arrivalTime,
        seatsNeeded: seatsNeeded ?? request.seatsNeeded,
        rideType: rideType ?? request.rideType,
        tripType: tripType ?? request.tripType,
        returnDate: returnDateValue ?? request.returnDate,
        returnTime: returnTime !== undefined ? returnTime : request.returnTime,
      },
      include: {
        passenger: {
          select: {
            id: true,
            name: true,
            email: true,
            providerAvatarUrl: true,
          },
        },
      },
    })

    return res.json(updated)
  } catch (err) {
    console.error("PUT /ride-requests/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/ride-requests
 * Public list / search of ride requests
 */
export async function listRideRequests(req: AuthRequest, res: Response) {
  try {
    const {
      fromCity,
      toCity,
      status,
      fromLat,
      fromLng,
      lat,
      lng,
      toLat,
      toLng,
      radiusKm,
      limit,
      cursor,
    } = req.query as {
      fromCity?: string
      toCity?: string
      status?: string
      fromLat?: string
      fromLng?: string
      lat?: string
      lng?: string
      toLat?: string
      toLng?: string
      radiusKm?: string
      limit?: string
      cursor?: string
    }

    const pickupLat = parseNumber(lat ?? fromLat)
    const pickupLng = parseNumber(lng ?? fromLng)
    const parsedToLat = parseNumber(toLat)
    const parsedToLng = parseNumber(toLng)
    const parsedRadiusKm =
      typeof radiusKm === "string"
        ? Number(radiusKm)
        : radiusKm === undefined
          ? DEFAULT_RADIUS_KM
          : parseNumber(radiusKm) ?? DEFAULT_RADIUS_KM

    const requestedLimit = parseNumber(limit)
    const safeLimit = Math.min(
      requestedLimit && requestedLimit > 0 ? requestedLimit : DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE
    )

    if (
      (lat && pickupLat == null) ||
      (lng && pickupLng == null) ||
      (fromLat && pickupLat == null) ||
      (fromLng && pickupLng == null) ||
      (toLat && parsedToLat == null) ||
      (toLng && parsedToLng == null) ||
      (radiusKm && Number.isNaN(parsedRadiusKm))
    ) {
      return res
        .status(400)
        .json({ error: "Invalid lat/lng or radiusKm parameter" })
    }

    if ((lat && !lng) || (!lat && lng)) {
      return res
        .status(400)
        .json({ error: "Both lat and lng are required" })
    }

    if ((fromLat && !fromLng) || (!fromLat && fromLng)) {
      return res
        .status(400)
        .json({ error: "Both fromLat and fromLng are required" })
    }

    if ((toLat && !toLng) || (!toLat && toLng)) {
      return res.status(400).json({ error: "Both toLat and toLng are required" })
    }

    if (parsedRadiusKm <= 0 || parsedRadiusKm > MAX_RADIUS_KM) {
      return res.status(400).json({
        error: `radiusKm must be between 0 and ${MAX_RADIUS_KM}`,
      })
    }

    if (pickupLat != null && !isValidLatitude(pickupLat)) {
      return res
        .status(400)
        .json({ error: "lat must be between -90 and 90" })
    }

    if (pickupLng != null && !isValidLongitude(pickupLng)) {
      return res
        .status(400)
        .json({ error: "lng must be between -180 and 180" })
    }

    if (parsedToLat != null && !isValidLatitude(parsedToLat)) {
      return res
        .status(400)
        .json({ error: "toLat must be between -90 and 90" })
    }

    if (parsedToLng != null && !isValidLongitude(parsedToLng)) {
      return res
        .status(400)
        .json({ error: "toLng must be between -180 and 180" })
    }

    const where: any = {}

    if (fromCity) {
      where.fromCity = { contains: fromCity, mode: "insensitive" }
    }
    if (toCity) {
      where.toCity = { contains: toCity, mode: "insensitive" }
    }
    const validStatuses = [
      "PENDING",
      "OFFERING",
      "ACCEPTED",
      "CANCELLED",
      "EXPIRED",
      "pending",
      "matched",
      "cancelled",
      "expired",
    ]
    if (status && validStatuses.includes(status)) {
      where.status = status
    } else {
      where.status = {
        in: ["OFFERING", "PENDING", "pending"],
      }
    }

    const hasPickupCoords = pickupLat != null && pickupLng != null
    const hasToCoords =
      parsedToLat != null &&
      !Number.isNaN(parsedToLat) &&
      parsedToLng != null &&
      !Number.isNaN(parsedToLng)

    const fromLocationClauses: any[] = []
    if (fromCity && typeof fromCity === "string") {
      fromLocationClauses.push({
        fromCity: { contains: fromCity, mode: "insensitive" },
      })
    }
    if (hasPickupCoords) {
      const bounds = buildBounds(pickupLat!, pickupLng!, parsedRadiusKm)
      fromLocationClauses.push({
        fromLat: { gte: bounds.minLat, lte: bounds.maxLat },
        fromLng: { gte: bounds.minLng, lte: bounds.maxLng },
      })
    }

    if (fromLocationClauses.length === 1) {
      Object.assign(where, fromLocationClauses[0])
    } else if (fromLocationClauses.length > 1) {
      where.AND = [...(where.AND ?? []), { OR: fromLocationClauses }]
    }

    const toLocationClauses: any[] = []
    if (toCity && typeof toCity === "string") {
      toLocationClauses.push({
        toCity: { contains: toCity, mode: "insensitive" },
      })
    }
    if (hasToCoords) {
      const bounds = buildBounds(parsedToLat, parsedToLng, parsedRadiusKm)
      toLocationClauses.push({
        toLat: { gte: bounds.minLat, lte: bounds.maxLat },
        toLng: { gte: bounds.minLng, lte: bounds.maxLng },
      })
    }

    if (toLocationClauses.length === 1) {
      Object.assign(where, toLocationClauses[0])
    } else if (toLocationClauses.length > 1) {
      where.AND = [...(where.AND ?? []), { OR: toLocationClauses }]
    }

    let requests = await prisma.rideRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        passenger: {
          select: {
            id: true,
            name: true,
            email: true,
            providerAvatarUrl: true,
          },
        },
      },
    })

    if (hasPickupCoords) {
      requests = requests.filter((request) =>
        isWithinRadius(pickupLat!, pickupLng!, request.fromLat, request.fromLng, parsedRadiusKm)
      )
    }

    if (hasToCoords) {
      requests = requests.filter((request) =>
        isWithinRadius(
          parsedToLat!,
          parsedToLng!,
          request.toLat,
          request.toLng,
          parsedRadiusKm
        )
      )
    }

    if (hasPickupCoords) {
      requests = requests
        .map((request) => ({
          request,
          distanceKm: calculateDistanceKm(
            pickupLat!,
            pickupLng!,
            request.fromLat,
            request.fromLng
          ),
        }))
        .sort((a, b) => {
          if (a.distanceKm !== b.distanceKm) {
            return a.distanceKm - b.distanceKm
          }
          return (
            new Date(b.request.createdAt).getTime() -
            new Date(a.request.createdAt).getTime()
          )
        })
        .map((item) => item.request)
    }

    if (cursor && typeof cursor === "string") {
      const cursorIndex = requests.findIndex((request) => request.id === cursor)
      if (cursorIndex >= 0) {
        requests = requests.slice(cursorIndex + 1)
      }
    }

    const pagedRequests = requests.slice(0, safeLimit)
    const nextCursor =
      requests.length > safeLimit ? pagedRequests[pagedRequests.length - 1]?.id : null

    return res.json({ requests: pagedRequests, nextCursor })
  } catch (err) {
    console.error("GET /ride-requests error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

function buildBounds(lat: number, lng: number, radiusKm: number) {
  const latKm = 110.574
  const lngKm = 111.320 * Math.cos((lat * Math.PI) / 180)
  const deltaLat = radiusKm / latKm
  const deltaLng = radiusKm / Math.max(lngKm, 0.0001)

  return {
    minLat: lat - deltaLat,
    maxLat: lat + deltaLat,
    minLng: lng - deltaLng,
    maxLng: lng + deltaLng,
  }
}

function isWithinRadius(
  originLat: number,
  originLng: number,
  targetLat: number,
  targetLng: number,
  radiusKm: number
) {
  const distanceKm = calculateDistanceKm(
    originLat,
    originLng,
    targetLat,
    targetLng
  )

  return distanceKm <= radiusKm
}

function calculateDistanceKm(
  originLat: number,
  originLng: number,
  targetLat: number,
  targetLng: number
) {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const earthRadiusKm = 6371
  const dLat = toRad(targetLat - originLat)
  const dLng = toRad(targetLng - originLng)
  const lat1 = toRad(originLat)
  const lat2 = toRad(targetLat)

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  const distanceKm = earthRadiusKm * c

  return distanceKm
}

/**
 * GET /api/ride-requests/me/list
 * Passenger's own ride requests
 */
export async function getMyRideRequests(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const requests = await prisma.rideRequest.findMany({
      where: { passengerId: req.userId },
      orderBy: { createdAt: "desc" },
      include: {
        passenger: {
          select: {
            id: true,
            name: true,
            email: true,
            providerAvatarUrl: true,
          },
        },
      },
    })

    return res.json(requests)
  } catch (err) {
    console.error("GET /ride-requests/me/list error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/ride-requests/:id
 * Public single ride request
 */
export async function getRideRequestById(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "id is required" })
    }

    const request = await prisma.rideRequest.findUnique({
      where: { id },
      include: {
        passenger: {
          select: {
            id: true,
            name: true,
            email: true,
            providerAvatarUrl: true,
          },
        },
      },
    })

    if (!request) {
      return res.status(404).json({ error: "Ride request not found" })
    }

    return res.json(request)
  } catch (err) {
    console.error("GET /ride-requests/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * DELETE /api/ride-requests/:id
 * Passenger cancels their own request
 */
export async function deleteRideRequest(req: AuthRequest, res: Response) {
  return cancelRideRequest(req, res)
}

/**
 * POST /api/ride-requests/:id/cancel
 * Passenger cancels their own request.
 */
export async function cancelRideRequest(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "id is required" })
    }

    const existing = await prisma.rideRequest.findUnique({
      where: { id },
    })

    if (!existing) {
      return res.status(404).json({ error: "Ride request not found" })
    }

    if (existing.passengerId !== req.userId) {
      return res.status(403).json({
        error: "You can only delete your own ride requests",
      })
    }

    if (existing.status === "CANCELLED" || existing.status === "cancelled") {
      return res.status(200).json(existing)
    }

    if (TERMINAL_REQUEST_STATUSES.has(existing.status)) {
      return res.status(400).json({
        error: "Ride request is already closed",
      })
    }

    if (!ACTIVE_REQUEST_STATUSES.has(existing.status)) {
      return res.status(400).json({
        error: "Only active ride requests can be cancelled",
      })
    }

    if (existing.mode === "JIT") {
      try {
        await initiateRideRequestRefund({
          rideRequestId: existing.id,
          stripePaymentIntentId: existing.jitPaymentIntentId,
          source: "passenger_cancel_ride_request",
        })
      } catch (refundErr) {
        console.error("Refund initiation failed for ride request cancellation", {
          rideRequestId: existing.id,
          paymentIntentId: existing.jitPaymentIntentId,
          err: refundErr,
        })
        return res.status(502).json({
          error: "Unable to initiate refund for this cancellation. Please retry.",
        })
      }
    }

    const updated = await prisma.rideRequest.update({
      where: { id },
      data: { status: "CANCELLED" },
    })

    try {
      await dispatchRideRequestCancel({ rideRequestId: existing.id })
      console.info(
        "[realtime] cancel callback triggered",
        JSON.stringify({ rideRequestId: existing.id })
      )
    } catch (cancelErr) {
      console.error(
        "[realtime] cancel dispatch failed",
        JSON.stringify({ rideRequestId: existing.id }),
        cancelErr
      )
    }

    return res.status(200).json(updated)
  } catch (err) {
    console.error("POST /ride-requests/:id/cancel error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/ride-requests/:id/accept
 * Secure server-to-server callback from realtime dispatcher.
 */
export async function acceptRideRequest(req: AuthRequest, res: Response) {
  try {
    const headerSecret = req.header("X-REALTIME-SECRET")
    const expectedSecret = getRealtimeToApiSecret()

    if (!headerSecret || headerSecret !== expectedSecret) {
      return res.status(403).json({ error: "Forbidden" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "id is required" })
    }

    const { driverId, rideId, seatsOffered, pricePerSeat } =
      (req.body ?? {}) as AcceptRideRequestBody

    console.info(
      "[realtime] accept callback received",
      JSON.stringify({ rideRequestId: id })
    )

    if (!driverId) {
      return res.status(400).json({ error: "driverId is required" })
    }

    const rideRequest = await prisma.rideRequest.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        mode: true,
        driverId: true,
        passengerId: true,
        fromCity: true,
        fromLat: true,
        fromLng: true,
        toCity: true,
        toLat: true,
        toLng: true,
        preferredDate: true,
        seatsNeeded: true,
        jitPaymentIntentId: true,
        jitAmountCents: true,
        jitCurrency: true,
        quotedPricePerSeat: true,
      },
    })

    if (!rideRequest) {
      return res.status(404).json({ error: "Ride request not found" })
    }

    if (ACCEPTED_REQUEST_STATUSES.has(rideRequest.status)) {
      return res.status(200).json({
        ok: true,
        idempotent: true,
        rideRequestId: rideRequest.id,
        status: "ACCEPTED",
        driverId: rideRequest.driverId,
      })
    }

    if (TERMINAL_REQUEST_STATUSES.has(rideRequest.status)) {
      return res.status(409).json({
        error: "Ride request is closed",
        status: rideRequest.status,
      })
    }

    if (!ACTIVE_REQUEST_STATUSES.has(rideRequest.status)) {
      return res.status(409).json({
        error: "Ride request is not in an acceptable state",
        status: rideRequest.status,
      })
    }

    if (rideId) {
      const ride = await prisma.ride.findUnique({
        where: { id: rideId },
        select: { id: true, driverId: true },
      })

      if (!ride || ride.driverId !== driverId) {
        return res.status(400).json({
          error: "rideId is invalid for the provided driverId",
        })
      }
    }

    const resolvedSeatsOffered =
      seatsOffered != null ? Number(seatsOffered) : rideRequest.seatsNeeded
    if (!Number.isFinite(resolvedSeatsOffered) || resolvedSeatsOffered <= 0) {
      return res
        .status(400)
        .json({ error: "seatsOffered must be a positive number" })
    }

    const fallbackPricePerSeat =
      rideRequest.quotedPricePerSeat != null
        ? Number(rideRequest.quotedPricePerSeat)
        : rideRequest.jitAmountCents != null
          ? Number(
              (
                rideRequest.jitAmountCents /
                Math.max(rideRequest.seatsNeeded, 1) /
                100
              ).toFixed(2)
            )
          : 0

    const resolvedPricePerSeat =
      pricePerSeat != null ? Number(pricePerSeat) : fallbackPricePerSeat

    if (rideRequest.mode === "JIT") {
      if (!Number.isFinite(resolvedPricePerSeat) || resolvedPricePerSeat <= 0) {
        return res
          .status(400)
          .json({ error: "pricePerSeat must be a positive number" })
      }

      if (resolvedSeatsOffered < rideRequest.seatsNeeded) {
        return res.status(400).json({
          error:
            "seatsOffered must be at least seatsNeeded for JIT ride requests",
        })
      }

      const [updatedRideRequest, createdRide, booking, acceptedOffer] =
        await prisma.$transaction(async (tx) => {
          const updatedRequest = await tx.rideRequest.update({
            where: { id: rideRequest.id },
            data: {
              status: "ACCEPTED",
              driverId,
            },
          })

          const ride = await tx.ride.create({
            data: {
              driverId,
              fromCity: rideRequest.fromCity,
              fromLat: rideRequest.fromLat,
              fromLng: rideRequest.fromLng,
              toCity: rideRequest.toCity,
              toLat: rideRequest.toLat,
              toLng: rideRequest.toLng,
              startTime: rideRequest.preferredDate,
              pricePerSeat: resolvedPricePerSeat,
              seatsTotal: resolvedSeatsOffered,
              seatsAvailable: Math.max(
                resolvedSeatsOffered - rideRequest.seatsNeeded,
                0
              ),
              status: "open",
            },
          })

          const createdBooking = await tx.booking.create({
            data: {
              rideId: ride.id,
              passengerId: rideRequest.passengerId,
              seatsBooked: rideRequest.seatsNeeded,
              passengerPickupName: rideRequest.fromCity,
              passengerPickupLat: rideRequest.fromLat,
              passengerPickupLng: rideRequest.fromLng,
              passengerDropoffName: rideRequest.toCity,
              passengerDropoffLat: rideRequest.toLat,
              passengerDropoffLng: rideRequest.toLng,
              status: "CONFIRMED",
              paymentStatus: "paid",
              stripePaymentIntentId: rideRequest.jitPaymentIntentId,
            },
          })

          if (rideRequest.jitPaymentIntentId) {
            const amountCents =
              rideRequest.jitAmountCents ??
              Math.round(
                resolvedPricePerSeat * rideRequest.seatsNeeded * 100
              )
            const platformFeeCents = Math.round(
              amountCents * getPlatformFeePct()
            )
            await tx.payment.upsert({
              where: { paymentIntentId: rideRequest.jitPaymentIntentId },
              create: {
                bookingId: createdBooking.id,
                paymentIntentId: rideRequest.jitPaymentIntentId,
                amountCents,
                platformFeeCents,
                currency: rideRequest.jitCurrency ?? "cad",
                status: "succeeded",
              },
              update: {
                bookingId: createdBooking.id,
                amountCents,
                platformFeeCents,
                currency: rideRequest.jitCurrency ?? "cad",
                status: "succeeded",
              },
            })
          }

          const offer = await tx.rideRequestOffer.upsert({
            where: {
              rideRequestId_driverId: {
                rideRequestId: rideRequest.id,
                driverId,
              },
            },
            create: {
              rideRequestId: rideRequest.id,
              driverId,
              rideId: ride.id,
              seatsOffered: resolvedSeatsOffered,
              pricePerSeat: resolvedPricePerSeat,
              status: "ACCEPTED",
            },
            update: {
              rideId: ride.id,
              seatsOffered: resolvedSeatsOffered,
              pricePerSeat: resolvedPricePerSeat,
              status: "ACCEPTED",
            },
          })

          await tx.rideRequestOffer.updateMany({
            where: {
              rideRequestId: rideRequest.id,
              driverId: { not: driverId },
              status: { in: ["SENT", "pending"] },
            },
            data: { status: "REJECTED" },
          })

          return [updatedRequest, ride, createdBooking, offer] as const
        })

      return res.status(200).json({
        ok: true,
        idempotent: false,
        rideRequest: updatedRideRequest,
        ride: createdRide,
        booking,
        offer: acceptedOffer,
      })
    }

    if (!Number.isFinite(resolvedPricePerSeat) || resolvedPricePerSeat < 0) {
      return res
        .status(400)
        .json({ error: "pricePerSeat must be a non-negative number" })
    }

    const [updatedRideRequest, acceptedOffer] = await prisma.$transaction([
      prisma.rideRequest.update({
        where: { id: rideRequest.id },
        data: {
          status: "ACCEPTED",
          driverId,
        },
      }),
      prisma.rideRequestOffer.upsert({
        where: {
          rideRequestId_driverId: {
            rideRequestId: rideRequest.id,
            driverId,
          },
        },
        create: {
          rideRequestId: rideRequest.id,
          driverId,
          rideId: rideId ?? null,
          seatsOffered: resolvedSeatsOffered,
          pricePerSeat: resolvedPricePerSeat,
          status: "ACCEPTED",
        },
        update: {
          rideId: rideId ?? null,
          seatsOffered: resolvedSeatsOffered,
          pricePerSeat: resolvedPricePerSeat,
          status: "ACCEPTED",
        },
      }),
      prisma.rideRequestOffer.updateMany({
        where: {
          rideRequestId: rideRequest.id,
          driverId: { not: driverId },
          status: { in: ["SENT", "pending"] },
        },
        data: { status: "REJECTED" },
      }),
    ])

    return res.status(200).json({
      ok: true,
      idempotent: false,
      rideRequest: updatedRideRequest,
      offer: acceptedOffer,
    })
  } catch (err) {
    console.error("POST /ride-requests/:id/accept error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
