// src/controllers/rideRequest.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"
import { notifyUsersByRole } from "../lib/notifications.js"

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

const DEFAULT_RADIUS_KM = 25
const MAX_RADIUS_KM = 100
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

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

    return res.status(201).json(request)
  } catch (err) {
    console.error("POST /ride-requests error", err)
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
    const validStatuses = ["pending", "matched", "cancelled", "expired"]
    if (status && validStatuses.includes(status)) {
      where.status = status
    } else {
      where.status = "pending"
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

    if (existing.status !== "pending") {
      return res.status(400).json({
        error: "Only pending ride requests can be deleted",
      })
    }

    const updated = await prisma.rideRequest.update({
      where: { id },
      data: { status: "cancelled" },
    })

    return res.status(200).json(updated)
  } catch (err) {
    console.error("DELETE /ride-requests/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
