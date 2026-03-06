// src/controllers/ride.controller.ts
import { randomUUID } from "node:crypto"
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"
import { classifyRideTimingByDeparture, resolveSeatPrice } from "../lib/pricing.js"
import { notifyUser, notifyUsersByIds, notifyUsersByRole } from "../lib/notifications.js"
import { initiateBookingRefundIfPaid } from "../lib/refunds.js"

interface CreateRideBody {
  fromCity: string
  fromLat: number
  fromLng: number
  toCity: string
  toLat: number
  toLng: number
  startTime: string // ISO string from client
  arrivalTime?: string | null
  stops?: string[] | null
  amenities?: RideAmenity[] | null
  additionalNotes?: string | null
  pricePerSeat: number
  seatsTotal: number
  rideType?: string
  recurrenceDays?: string[] | null
  recurrenceEndDate?: string | null
  occurrenceStartTimes?: string[] | null
}

interface RidePricingPreviewBody {
  fromCity?: string
  fromLat?: number
  fromLng?: number
  toCity?: string
  toLat?: number
  toLng?: number
  startTime?: string
  pricePerSeat?: number
  seatsTotal?: number
}

const RIDE_AMENITIES = [
  "ac",
  "music",
  "wifi",
  "pet_friendly",
  "luggage_space",
  "child_seat",
] as const
const RIDE_TYPES = ["one-time", "recurring"] as const
const RIDE_RECURRENCE_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const
const ACTIVE_BOOKING_NOTIFICATION_STATUSES = [
  "pending",
  "confirmed",
  "ACCEPTED",
  "PAYMENT_PENDING",
  "CONFIRMED",
] as const
const MAX_RECURRING_RIDE_OCCURRENCES = 90

type RideAmenity = (typeof RIDE_AMENITIES)[number]
type RideType = (typeof RIDE_TYPES)[number]

const RIDE_AMENITY_SET = new Set<string>(RIDE_AMENITIES)
const RIDE_TYPE_SET = new Set<string>(RIDE_TYPES)
const RIDE_RECURRENCE_DAY_SET = new Set<string>(RIDE_RECURRENCE_DAYS)

function parseArrivalTime(
  value: unknown,
  startTime: Date
): { arrivalTime: Date | null } | { error: string } {
  if (value == null || value === "") {
    return { arrivalTime: null }
  }

  if (typeof value !== "string") {
    return { error: "arrivalTime must be a valid ISO date string" }
  }

  const arrival = new Date(value)
  if (Number.isNaN(arrival.getTime())) {
    return { error: "arrivalTime must be a valid ISO date string" }
  }

  if (arrival <= startTime) {
    return { error: "arrivalTime must be later than startTime" }
  }

  return { arrivalTime: arrival }
}

function parseStops(
  value: unknown
): { stops: string[] } | { error: string } {
  if (value == null) {
    return { stops: [] }
  }

  if (!Array.isArray(value) || !value.every((stop) => typeof stop === "string")) {
    return { error: "stops must be an array of strings" }
  }

  const stops = value.map((stop) => stop.trim()).filter((stop) => stop.length > 0)
  return { stops }
}

function parseAmenities(
  value: unknown
): { amenities: RideAmenity[] } | { error: string } {
  if (value == null) {
    return { amenities: [] }
  }

  if (
    !Array.isArray(value) ||
    !value.every((amenity) => typeof amenity === "string")
  ) {
    return { error: "amenities must be an array of strings" }
  }

  const normalizedAmenities = Array.from(
    new Set(
      value
        .map((amenity) => amenity.trim().toLowerCase())
        .filter((amenity) => amenity.length > 0)
    )
  )

  const invalidAmenities = normalizedAmenities.filter(
    (amenity) => !RIDE_AMENITY_SET.has(amenity)
  )

  if (invalidAmenities.length > 0) {
    return {
      error: `Invalid amenities: ${invalidAmenities.join(", ")}. Allowed values: ${RIDE_AMENITIES.join(", ")}`,
    }
  }

  return {
    amenities: normalizedAmenities as RideAmenity[],
  }
}

function parseAdditionalNotes(
  value: unknown
): { additionalNotes: string | null } | { error: string } {
  if (value == null) {
    return { additionalNotes: null }
  }

  if (typeof value !== "string") {
    return { error: "additionalNotes must be a string" }
  }

  const notes = value.trim()
  return { additionalNotes: notes.length > 0 ? notes : null }
}

function parseRideType(
  value: unknown,
  hasRecurringHints: boolean
): { rideType: RideType } | { error: string } {
  if (value == null || value === "") {
    if (hasRecurringHints) {
      return { rideType: "recurring" }
    }
    return { rideType: "one-time" }
  }

  if (typeof value !== "string") {
    return { error: "rideType must be a string" }
  }

  const rideType = value.trim().toLowerCase()
  if (!RIDE_TYPE_SET.has(rideType)) {
    return {
      error: `rideType must be one of: ${RIDE_TYPES.join(", ")}`,
    }
  }

  if (rideType === "one-time" && hasRecurringHints) {
    return { rideType: "recurring" }
  }

  return { rideType: rideType as RideType }
}

function parseRecurrenceDays(
  value: unknown,
  rideType: RideType
): { recurrenceDays: string[] } | { error: string } {
  if (rideType !== "recurring") {
    return { recurrenceDays: [] }
  }

  if (!Array.isArray(value) || value.length === 0) {
    return { error: "recurrenceDays must be a non-empty array for recurring rides" }
  }

  const normalized = Array.from(
    new Set(
      value
        .map((day) => day?.toString().trim().toLowerCase() ?? "")
        .filter((day) => day.length > 0)
    )
  )

  const invalid = normalized.filter((day) => !RIDE_RECURRENCE_DAY_SET.has(day))
  if (invalid.length > 0) {
    return {
      error: `Invalid recurrenceDays: ${invalid.join(", ")}. Allowed values: ${RIDE_RECURRENCE_DAYS.join(", ")}`,
    }
  }

  return { recurrenceDays: normalized }
}

function parseRecurrenceEndDate(
  value: unknown,
  rideType: RideType,
  firstOccurrence: Date
): { recurrenceEndDate: Date | null } | { error: string } {
  if (rideType !== "recurring") {
    return { recurrenceEndDate: null }
  }

  if (value == null || value === "") {
    return { error: "recurrenceEndDate is required for recurring rides" }
  }

  if (typeof value !== "string") {
    return { error: "recurrenceEndDate must be a valid ISO date string" }
  }

  const recurrenceEndDate = new Date(value)
  if (Number.isNaN(recurrenceEndDate.getTime())) {
    return { error: "recurrenceEndDate must be a valid ISO date string" }
  }

  if (recurrenceEndDate < firstOccurrence) {
    return { error: "recurrenceEndDate must be on or after the first occurrence" }
  }

  return { recurrenceEndDate }
}

function parseOccurrenceStartTimes(
  value: unknown,
  rideType: RideType,
  firstOccurrence: Date,
  recurrenceEndDate: Date | null
): { occurrenceStartTimes: Date[] } | { error: string } {
  if (rideType !== "recurring") {
    return { occurrenceStartTimes: [firstOccurrence] }
  }

  if (!Array.isArray(value) || value.length === 0) {
    return {
      error: "occurrenceStartTimes must be a non-empty array for recurring rides",
    }
  }

  const parsed = value.map((entry) => new Date(entry?.toString() ?? ""))
  if (parsed.some((date) => Number.isNaN(date.getTime()))) {
    return { error: "occurrenceStartTimes must contain valid ISO date strings" }
  }

  const deduped = Array.from(
    new Set(parsed.map((date) => date.toISOString()))
  )
    .map((iso) => new Date(iso))
    .sort((a, b) => a.getTime() - b.getTime())

  if (deduped[0]?.toISOString() !== firstOccurrence.toISOString()) {
    return {
      error:
        "occurrenceStartTimes must start with the same ISO timestamp provided in startTime",
    }
  }

  if (
    recurrenceEndDate != null &&
    deduped.some((date) => date.getTime() > recurrenceEndDate.getTime())
  ) {
    return {
      error: "occurrenceStartTimes can not contain dates after recurrenceEndDate",
    }
  }

  if (deduped.length > MAX_RECURRING_RIDE_OCCURRENCES) {
    return {
      error: `Recurring rides are limited to ${MAX_RECURRING_RIDE_OCCURRENCES} occurrences per series`,
    }
  }

  return { occurrenceStartTimes: deduped }
}

function attachRideTiming<T extends { startTime: Date }>(ride: T) {
  return {
    ...ride,
    rideTiming: classifyRideTimingByDeparture(ride.startTime),
  }
}

export async function previewRidePricing(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const {
      fromCity,
      fromLat,
      fromLng,
      toCity,
      toLat,
      toLng,
      startTime,
      pricePerSeat,
      seatsTotal,
    } = (req.body ?? {}) as RidePricingPreviewBody

    if (
      !fromCity ||
      fromLat == null ||
      fromLng == null ||
      !toCity ||
      toLat == null ||
      toLng == null ||
      !startTime ||
      pricePerSeat == null ||
      seatsTotal == null
    ) {
      return res.status(400).json({ error: "Missing required pricing preview fields" })
    }

    if (
      !Number.isFinite(fromLat) ||
      !Number.isFinite(fromLng) ||
      !Number.isFinite(toLat) ||
      !Number.isFinite(toLng)
    ) {
      return res.status(400).json({ error: "Coordinates must be valid numbers" })
    }

    if (!Number.isFinite(pricePerSeat) || pricePerSeat < 0) {
      return res.status(400).json({ error: "pricePerSeat must be a non-negative number" })
    }

    if (!Number.isInteger(seatsTotal) || seatsTotal <= 0) {
      return res.status(400).json({ error: "seatsTotal must be a positive integer" })
    }

    const start = new Date(startTime)
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid startTime" })
    }

    const preview = await resolveSeatPrice({
      fromCity,
      toCity,
      fromLat,
      fromLng,
      toLat,
      toLng,
      seats: seatsTotal,
      basePricePerSeat: pricePerSeat,
      departureTime: start,
    })

    return res.json(preview)
  } catch (err) {
    console.error("POST /api/rides/pricing-preview error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/rides
 * Only drivers should use this (for now we'll just require an authenticated user;
 * you can later enforce req.userRole === "driver").
 */
export async function createRide(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }
    const driverId = req.userId

    const {
      fromCity,
      fromLat,
      fromLng,
      toCity,
      toLat,
      toLng,
      startTime,
      arrivalTime,
      stops,
      amenities,
      additionalNotes,
      pricePerSeat,
      seatsTotal,
      rideType,
      recurrenceDays,
      recurrenceEndDate,
      occurrenceStartTimes,
    } = (req.body ?? {}) as Partial<CreateRideBody>

    // Basic validation
    if (
      !fromCity ||
      fromLat == null ||
      fromLng == null ||
      !toCity ||
      toLat == null ||
      toLng == null ||
      !startTime ||
      pricePerSeat == null ||
      seatsTotal == null
    ) {
      return res.status(400).json({ error: "Missing required fields" })
    }

    if (
      !Number.isFinite(fromLat) ||
      !Number.isFinite(fromLng) ||
      !Number.isFinite(toLat) ||
      !Number.isFinite(toLng)
    ) {
      return res.status(400).json({ error: "Coordinates must be valid numbers" })
    }

    if (seatsTotal <= 0) {
      return res.status(400).json({ error: "seatsTotal must be > 0" })
    }
    if (!Number.isInteger(seatsTotal)) {
      return res.status(400).json({ error: "seatsTotal must be an integer" })
    }
    if (!Number.isFinite(pricePerSeat)) {
      return res.status(400).json({ error: "pricePerSeat must be a valid number" })
    }
    if (pricePerSeat < 0) {
      return res.status(400).json({ error: "pricePerSeat must be >= 0" })
    }

    const start = new Date(startTime)
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid startTime" })
    }

    const arrivalTimeResult = parseArrivalTime(arrivalTime, start)
    if ("error" in arrivalTimeResult) {
      return res.status(400).json({ error: arrivalTimeResult.error })
    }

    const stopsResult = parseStops(stops)
    if ("error" in stopsResult) {
      return res.status(400).json({ error: stopsResult.error })
    }

    const amenitiesResult = parseAmenities(amenities)
    if ("error" in amenitiesResult) {
      return res.status(400).json({ error: amenitiesResult.error })
    }

    const additionalNotesResult = parseAdditionalNotes(additionalNotes)
    if ("error" in additionalNotesResult) {
      return res.status(400).json({ error: additionalNotesResult.error })
    }

    const hasRecurringHints =
      recurrenceEndDate != null ||
      (Array.isArray(recurrenceDays) && recurrenceDays.length > 0) ||
      (Array.isArray(occurrenceStartTimes) && occurrenceStartTimes.length > 1)

    const rideTypeResult = parseRideType(rideType, hasRecurringHints)
    if ("error" in rideTypeResult) {
      return res.status(400).json({ error: rideTypeResult.error })
    }

    const recurrenceDaysResult = parseRecurrenceDays(
      recurrenceDays,
      rideTypeResult.rideType
    )
    if ("error" in recurrenceDaysResult) {
      return res.status(400).json({ error: recurrenceDaysResult.error })
    }

    const recurrenceEndDateResult = parseRecurrenceEndDate(
      recurrenceEndDate,
      rideTypeResult.rideType,
      start
    )
    if ("error" in recurrenceEndDateResult) {
      return res.status(400).json({ error: recurrenceEndDateResult.error })
    }

    const occurrenceStartTimesResult = parseOccurrenceStartTimes(
      occurrenceStartTimes,
      rideTypeResult.rideType,
      start,
      recurrenceEndDateResult.recurrenceEndDate
    )
    if ("error" in occurrenceStartTimesResult) {
      return res.status(400).json({ error: occurrenceStartTimesResult.error })
    }

    const pricing = await resolveSeatPrice({
      fromCity,
      toCity,
      fromLat,
      fromLng,
      toLat,
      toLng,
      seats: seatsTotal,
      basePricePerSeat: pricePerSeat,
      departureTime: start,
    })

    const seriesId =
      rideTypeResult.rideType === "recurring" ? randomUUID() : null
    const createdRides = await prisma.$transaction(
      occurrenceStartTimesResult.occurrenceStartTimes.map((occurrenceStartTime) =>
        prisma.ride.create({
          data: {
            driverId,
            fromCity,
            fromLat,
            fromLng,
            toCity,
            toLat,
            toLng,
            startTime: occurrenceStartTime,
            arrivalTime:
              arrivalTimeResult.arrivalTime == null
                ? null
                : new Date(
                    occurrenceStartTime.getTime() +
                      (arrivalTimeResult.arrivalTime.getTime() - start.getTime())
                  ),
            stops: stopsResult.stops,
            amenities: amenitiesResult.amenities,
            additionalNotes: additionalNotesResult.additionalNotes,
            pricePerSeat: pricing.pricePerSeat,
            seatsTotal,
            seatsAvailable: seatsTotal,
            rideType: rideTypeResult.rideType,
            recurringSeriesId: seriesId,
            recurrenceDays: recurrenceDaysResult.recurrenceDays,
            recurrenceEndDate: recurrenceEndDateResult.recurrenceEndDate,
            status: "open",
          },
        })
      )
    )
    const firstRide = createdRides[0]

    await notifyUsersByRole({
      role: "passenger",
      excludeUserId: req.userId,
      title:
        rideTypeResult.rideType === "recurring"
          ? "New recurring rides available"
          : "New ride available",
      body:
        rideTypeResult.rideType === "recurring"
          ? `${firstRide.fromCity} → ${firstRide.toCity} recurring rides are now available`
          : `${firstRide.fromCity} → ${firstRide.toCity} is now available`,
      type: "ride_update",
      data: {
        rideId: firstRide.id,
        kind: "ride_created",
      },
    })

    return res.status(201).json({
      ...attachRideTiming(firstRide),
      createdCount: createdRides.length,
      createdRideIds: createdRides.map((ride) => ride.id),
      recurringSeriesId: seriesId,
    })
  } catch (err) {
    console.error("POST /api/rides error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/rides
 * Query params:
 *  - fromCity (optional)
 *  - fromLat (optional)
 *  - fromLng (optional)
 *  - toCity (optional)
 *  - toLat (optional)
 *  - toLng (optional)
 *  - radiusKm (optional, defaults to 25)
 *  - date (optional, YYYY-MM-DD)
 *  - seats (optional, min seats required)
 */
export async function searchRides(req: AuthRequest, res: Response) {
  try {
    const { fromCity, toCity, date, seats, fromLat, fromLng, toLat, toLng, radiusKm } =
      req.query

    const minSeats = seats ? Number(seats) : 1
    if (seats && Number.isNaN(minSeats)) {
      return res.status(400).json({ error: "Invalid seats parameter" })
    }

    const parsedFromLat = typeof fromLat === "string" ? Number(fromLat) : null
    const parsedFromLng = typeof fromLng === "string" ? Number(fromLng) : null
    const parsedToLat = typeof toLat === "string" ? Number(toLat) : null
    const parsedToLng = typeof toLng === "string" ? Number(toLng) : null
    const parsedRadiusKm =
      typeof radiusKm === "string" ? Number(radiusKm) : 25

    if (
      (fromLat && Number.isNaN(parsedFromLat)) ||
      (fromLng && Number.isNaN(parsedFromLng)) ||
      (toLat && Number.isNaN(parsedToLat)) ||
      (toLng && Number.isNaN(parsedToLng)) ||
      (radiusKm && Number.isNaN(parsedRadiusKm))
    ) {
      return res.status(400).json({ error: "Invalid lat/lng or radiusKm parameter" })
    }

    if ((fromLat && !fromLng) || (!fromLat && fromLng)) {
      return res.status(400).json({ error: "Both fromLat and fromLng are required" })
    }

    if ((toLat && !toLng) || (!toLat && toLng)) {
      return res.status(400).json({ error: "Both toLat and toLng are required" })
    }

    const filters: any = {
      status: "open",
      seatsAvailable: {
        gte: minSeats,
      },
      startTime: {
        gte: new Date(), // default: future rides only
      },
    }

    const hasFromCoords =
      parsedFromLat != null &&
      !Number.isNaN(parsedFromLat) &&
      parsedFromLng != null &&
      !Number.isNaN(parsedFromLng)
    const hasToCoords =
      parsedToLat != null &&
      !Number.isNaN(parsedToLat) &&
      parsedToLng != null &&
      !Number.isNaN(parsedToLng)

    const locationClauses: any[] = []

    if (fromCity && typeof fromCity === "string") {
      locationClauses.push({
        fromCity: {
          contains: fromCity,
          mode: "insensitive",
        },
      })
    }

    if (hasFromCoords) {
      const bounds = buildBounds(parsedFromLat, parsedFromLng, parsedRadiusKm)
      locationClauses.push({
        fromLat: { gte: bounds.minLat, lte: bounds.maxLat },
        fromLng: { gte: bounds.minLng, lte: bounds.maxLng },
      })
    }

    if (locationClauses.length === 1) {
      Object.assign(filters, locationClauses[0])
    } else if (locationClauses.length > 1) {
      filters.AND = [...(filters.AND ?? []), { OR: locationClauses }]
    }

    const toLocationClauses: any[] = []

    if (toCity && typeof toCity === "string") {
      toLocationClauses.push({
        toCity: {
          contains: toCity,
          mode: "insensitive",
        },
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
      Object.assign(filters, toLocationClauses[0])
    } else if (toLocationClauses.length > 1) {
      filters.AND = [...(filters.AND ?? []), { OR: toLocationClauses }]
    }

    // If date provided, override startTime filter for that day
    if (date && typeof date === "string") {
      const dayStart = new Date(date + "T00:00:00.000Z")
      const dayEnd = new Date(date + "T23:59:59.999Z")

      if (!Number.isNaN(dayStart.getTime())) {
        filters.startTime = {
          gte: dayStart,
          lte: dayEnd,
        }
      }
    }

    let rides = await prisma.ride.findMany({
      where: filters,
      orderBy: {
        startTime: "asc",
      },
      include: {
        driver: {
          select: {
            id: true,
            name: true,
            providerAvatarUrl: true,
          },
        },
      },
    })

    if (hasFromCoords) {
      rides = rides.filter((ride) =>
        isWithinRadius(
          parsedFromLat,
          parsedFromLng,
          ride.fromLat,
          ride.fromLng,
          parsedRadiusKm
        )
      )
    }

    if (hasToCoords) {
      rides = rides.filter((ride) =>
        isWithinRadius(
          parsedToLat,
          parsedToLng,
          ride.toLat,
          ride.toLng,
          parsedRadiusKm
        )
      )
    }

    return res.json(rides.map(attachRideTiming))
  } catch (err) {
    console.error("GET /api/rides error", err)
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

  return distanceKm <= radiusKm
}

/**
 * GET /api/rides/me/list
 * Driver's own rides
 */
export async function getMyRides(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const rides = await prisma.ride.findMany({
      where: { driverId: req.userId },
      orderBy: {
        startTime: "desc",
      },
    })

    return res.json(rides.map(attachRideTiming))
  } catch (err) {
    console.error("GET /api/rides/mine error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/rides/:id
 * Fetch ride with driver info + basic booking stats
 */
export async function getRideById(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params

    if (!id) {
      return res.status(400).json({ error: "Ride id is required" })
    }

    const ride = await prisma.ride.findUnique({
      where: { id },
      include: {
        driver: {
          select: {
            id: true,
            name: true,
            providerAvatarUrl: true,
          },
        },
        bookings: {
          select: {
            id: true,
            seatsBooked: true,
            status: true,
          },
        },
      },
    })

    if (!ride) {
      return res.status(404).json({ error: "Ride not found" })
    }

    return res.json(attachRideTiming(ride))
  } catch (err) {
    console.error("GET /api/rides/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * PATCH /api/rides/:id
 * Update a ride (only the driver who created it can update)
 */
export async function updateRide(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "Ride id is required" })
    }

    const ride = await prisma.ride.findUnique({ where: { id } })
    if (!ride) {
      return res.status(404).json({ error: "Ride not found" })
    }

    if (ride.driverId !== req.userId) {
      return res.status(403).json({ error: "Forbidden" })
    }

    const updates = req.body as Partial<CreateRideBody>

    if (updates.seatsTotal != null) {
      if (!Number.isInteger(updates.seatsTotal) || updates.seatsTotal <= 0) {
        return res.status(400).json({ error: "seatsTotal must be a positive integer" })
      }
    }

    if (updates.pricePerSeat != null) {
      if (!Number.isFinite(updates.pricePerSeat)) {
        return res.status(400).json({ error: "pricePerSeat must be a valid number" })
      }
      const requestedPrice = Number(updates.pricePerSeat)
      if (requestedPrice < 0) {
        return res.status(400).json({ error: "pricePerSeat must be >= 0" })
      }
      if (Math.abs(requestedPrice - Number(ride.pricePerSeat)) >= 0.01) {
        return res.status(409).json({
          error: "pricePerSeat can not be changed after ride creation",
        })
      }
    }

    if (
      (updates.fromLat != null && !Number.isFinite(updates.fromLat)) ||
      (updates.fromLng != null && !Number.isFinite(updates.fromLng)) ||
      (updates.toLat != null && !Number.isFinite(updates.toLat)) ||
      (updates.toLng != null && !Number.isFinite(updates.toLng))
    ) {
      return res.status(400).json({ error: "Coordinates must be valid numbers" })
    }

    // Prepare update data
    const updateData: any = {
      ...(updates.fromCity && { fromCity: updates.fromCity }),
      ...(updates.fromLat != null && { fromLat: updates.fromLat }),
      ...(updates.fromLng != null && { fromLng: updates.fromLng }),
      ...(updates.toCity && { toCity: updates.toCity }),
      ...(updates.toLat != null && { toLat: updates.toLat }),
      ...(updates.toLng != null && { toLng: updates.toLng }),
    }

    let effectiveStartTime = ride.startTime
    if (updates.startTime !== undefined) {
      if (typeof updates.startTime !== "string") {
        return res.status(400).json({ error: "startTime must be a valid ISO date string" })
      }

      const start = new Date(updates.startTime)
      if (Number.isNaN(start.getTime())) {
        return res.status(400).json({ error: "Invalid startTime" })
      }

      effectiveStartTime = start
      updateData.startTime = start
    }

    if (updates.arrivalTime !== undefined) {
      const arrivalTimeResult = parseArrivalTime(updates.arrivalTime, effectiveStartTime)
      if ("error" in arrivalTimeResult) {
        return res.status(400).json({ error: arrivalTimeResult.error })
      }

      updateData.arrivalTime = arrivalTimeResult.arrivalTime
    } else if (updates.startTime !== undefined && ride.arrivalTime) {
      if (ride.arrivalTime <= effectiveStartTime) {
        return res.status(400).json({
          error:
            "Existing arrivalTime is earlier than updated startTime. Send a later arrivalTime or null.",
        })
      }
    }

    if (updates.stops !== undefined) {
      const stopsResult = parseStops(updates.stops)
      if ("error" in stopsResult) {
        return res.status(400).json({ error: stopsResult.error })
      }
      updateData.stops = stopsResult.stops
    }

    if (updates.amenities !== undefined) {
      const amenitiesResult = parseAmenities(updates.amenities)
      if ("error" in amenitiesResult) {
        return res.status(400).json({ error: amenitiesResult.error })
      }
      updateData.amenities = amenitiesResult.amenities
    }

    if (updates.additionalNotes !== undefined) {
      const additionalNotesResult = parseAdditionalNotes(updates.additionalNotes)
      if ("error" in additionalNotesResult) {
        return res.status(400).json({ error: additionalNotesResult.error })
      }
      updateData.additionalNotes = additionalNotesResult.additionalNotes
    }

    if (updates.seatsTotal != null) {
      updateData.seatsTotal = updates.seatsTotal
      // Adjust seatsAvailable proportionally
      const delta = updates.seatsTotal - ride.seatsTotal
      let newSeatsAvailable = ride.seatsAvailable + delta
      // Clamp between 0 and updates.seatsTotal
      newSeatsAvailable = Math.max(
        0,
        Math.min(newSeatsAvailable, updates.seatsTotal)
      )
      updateData.seatsAvailable = newSeatsAvailable
    }

    const updatedRide = await prisma.ride.update({
      where: { id },
      data: updateData,
    })

    const activeBookings = await prisma.booking.findMany({
      where: {
        rideId: updatedRide.id,
        status: { in: [...ACTIVE_BOOKING_NOTIFICATION_STATUSES] },
      },
      select: {
        passengerId: true,
      },
    })
    const passengerIds = Array.from(
      new Set(activeBookings.map((booking) => booking.passengerId))
    )

    if (passengerIds.length > 0) {
      await notifyUsersByIds({
        userIds: passengerIds,
        title: "Ride updated",
        body: `${updatedRide.fromCity} → ${updatedRide.toCity} details were updated`,
        type: "ride_update",
        data: {
          rideId: updatedRide.id,
          kind: "ride_updated",
        },
      })
    }

    return res.json(attachRideTiming(updatedRide))
  } catch (err) {
    console.error("PATCH /api/rides/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * DELETE /api/rides/:id
 * Delete a ride (only the driver who created it can delete)
 */
export async function deleteRide(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "Ride id is required" })
    }

    const ride = await prisma.ride.findUnique({ where: { id } })
    if (!ride) {
      return res.status(404).json({ error: "Ride not found" })
    }

    if (ride.driverId !== req.userId) {
      return res.status(403).json({ error: "Forbidden" })
    }

    await prisma.ride.delete({ where: { id } })
    return res.status(204).send()
  } catch (err) {
    console.error("DELETE /api/rides/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

async function getUnpaidBlockingBookings(rideId: string) {
  const bookings = await prisma.booking.findMany({
    where: {
      rideId,
      status: { in: ["ACCEPTED", "PAYMENT_PENDING", "CONFIRMED", "confirmed"] },
    },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
    },
  })

  return bookings.filter((booking) => {
    if (booking.status === "ACCEPTED" || booking.status === "PAYMENT_PENDING") {
      return true
    }

    return !["paid", "succeeded"].includes(booking.paymentStatus)
  })
}

/**
 * POST /api/rides/:id/start
 * Driver starts ride
 */
export async function startRide(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "Ride id is required" })
    }

    const ride = await prisma.ride.findUnique({ where: { id } })
    if (!ride) {
      return res.status(404).json({ error: "Ride not found" })
    }

    if (ride.driverId !== req.userId) {
      return res.status(403).json({ error: "Forbidden" })
    }

    if (ride.status !== "open") {
      return res.status(400).json({ error: "Only open rides can be started" })
    }

    const unpaidBookings = await getUnpaidBlockingBookings(id)
    if (unpaidBookings.length > 0) {
      return res.status(400).json({
        error: "Cannot start ride until all accepted bookings are paid",
        unpaidBookingIds: unpaidBookings.map((booking) => booking.id),
      })
    }

    const bookings = await prisma.booking.findMany({
      where: { rideId: id, status: { in: ["CONFIRMED", "confirmed"] } },
      select: { id: true, passengerId: true },
    })

    const updatedRide = await prisma.ride.update({
      where: { id },
      data: { status: "ongoing" },
    })

    await Promise.all(
      bookings.map((booking) =>
        notifyUser({
          userId: booking.passengerId,
          title: "Ride started",
          body: `${ride.fromCity} → ${ride.toCity} has started`,
          type: "ride_update",
          data: {
            rideId: ride.id,
            bookingId: booking.id,
            kind: "ride_started",
          },
        })
      )
    )

    return res.json(updatedRide)
  } catch (err) {
    console.error("POST /api/rides/:id/start error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/rides/:id/complete
 * Driver completes ride
 */
export async function completeRide(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "Ride id is required" })
    }

    const ride = await prisma.ride.findUnique({ where: { id } })
    if (!ride) {
      return res.status(404).json({ error: "Ride not found" })
    }

    if (ride.driverId !== req.userId) {
      return res.status(403).json({ error: "Forbidden" })
    }

    if (ride.status !== "ongoing") {
      return res
        .status(400)
        .json({ error: "Only ongoing rides can be completed" })
    }

    const unpaidBookings = await getUnpaidBlockingBookings(id)
    if (unpaidBookings.length > 0) {
      return res.status(400).json({
        error: "Cannot complete ride until all accepted bookings are paid",
        unpaidBookingIds: unpaidBookings.map((booking) => booking.id),
      })
    }

    const bookings = await prisma.booking.findMany({
      where: { rideId: id, status: { in: ["CONFIRMED", "confirmed"] } },
      select: { id: true, passengerId: true },
    })

    const [updatedRide, updatedBookings] = await prisma.$transaction([
      prisma.ride.update({
        where: { id },
        data: { status: "completed" },
      }),
      prisma.booking.updateMany({
        where: { rideId: id, status: { in: ["CONFIRMED", "confirmed"] } },
        data: { status: "completed" },
      }),
    ])

    await Promise.all(
      bookings.map((booking) =>
        notifyUser({
          userId: booking.passengerId,
          title: "Ride completed",
          body: `${ride.fromCity} → ${ride.toCity} has completed`,
          type: "ride_update",
          data: {
            rideId: ride.id,
            bookingId: booking.id,
            kind: "ride_completed",
          },
        })
      )
    )

    return res.json({ ride: updatedRide, bookings: updatedBookings })
  } catch (err) {
    console.error("POST /api/rides/:id/complete error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/rides/:id/cancel
 * Driver cancels ride
 */
export async function cancelRide(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "Ride id is required" })
    }

    const ride = await prisma.ride.findUnique({ where: { id } })
    if (!ride) {
      return res.status(404).json({ error: "Ride not found" })
    }

    if (ride.driverId !== req.userId) {
      return res.status(403).json({ error: "Forbidden" })
    }

    if (!["open", "ongoing"].includes(ride.status)) {
      return res
        .status(400)
        .json({ error: "Only open or ongoing rides can be cancelled" })
    }

    const bookings = await prisma.booking.findMany({
      where: {
        rideId: id,
        status: {
          in: ["pending", "confirmed", "ACCEPTED", "PAYMENT_PENDING", "CONFIRMED"],
        },
      },
      select: {
        id: true,
        passengerId: true,
        status: true,
        paymentStatus: true,
        stripePaymentIntentId: true,
      },
    })

    const confirmedBookings = bookings.filter((booking) =>
      ["CONFIRMED", "confirmed"].includes(booking.status)
    )

    try {
      await Promise.all(
        confirmedBookings.map((booking) =>
          initiateBookingRefundIfPaid({
            bookingId: booking.id,
            paymentStatus: booking.paymentStatus,
            stripePaymentIntentId: booking.stripePaymentIntentId,
            source: "driver_cancel_ride",
          })
        )
      )
    } catch (refundErr) {
      console.error("Refund initiation failed for ride cancellation", {
        rideId: id,
        err: refundErr,
      })
      return res.status(502).json({
        error: "Unable to initiate refunds for confirmed bookings. Please retry.",
      })
    }

    const [updatedRide, updatedBookings] = await prisma.$transaction([
      prisma.ride.update({
        where: { id },
        data: { status: "cancelled" },
      }),
      prisma.booking.updateMany({
        where: {
          rideId: id,
          status: {
            in: [
              "pending",
              "confirmed",
              "ACCEPTED",
              "PAYMENT_PENDING",
              "CONFIRMED",
            ],
          },
        },
        data: { status: "cancelled_by_driver" },
      }),
    ])

    await Promise.all(
      bookings.map((booking) =>
        notifyUser({
          userId: booking.passengerId,
          title: "Ride cancelled",
          body: `${ride.fromCity} → ${ride.toCity} was cancelled by the driver`,
          type: "ride_update",
          data: {
            rideId: ride.id,
            bookingId: booking.id,
            kind: "ride_cancelled_by_driver",
          },
        })
      )
    )

    return res.json({ ride: updatedRide, bookings: updatedBookings })
  } catch (err) {
    console.error("POST /api/rides/:id/cancel error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
