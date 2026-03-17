import prisma from "./prisma.js"
import { notifyUsersByIds } from "./notifications.js"

type NearbyDriverNotificationInput = {
  rideRequestId: string
  passengerId: string
  pickupCity: string
  pickupLat: number
  pickupLng: number
  dropoffCity: string
}

type NearbyDriverNotificationResult = {
  matchedDrivers: number
  notifiedDrivers: number
  radiusKm: number
  locationMaxAgeMinutes: number
}

const DEFAULT_NOTIFY_RADIUS_KM = 12
const MAX_NOTIFY_RADIUS_KM = 100
const DEFAULT_DRIVER_LOCATION_MAX_AGE_MINUTES = 15
const DEFAULT_NOTIFY_LIMIT = 100
const MAX_NOTIFY_LIMIT = 500

function parsePositiveNumber(
  value: string | undefined,
  fallback: number,
  max: number
) {
  if (!value) return fallback

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.min(parsed, max)
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  max: number
) {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.min(Math.floor(parsed), max)
}

function getNearbyDriverDispatchConfig() {
  const radiusKm = parsePositiveNumber(
    process.env.RIDE_REQUEST_DRIVER_NOTIFY_RADIUS_KM,
    DEFAULT_NOTIFY_RADIUS_KM,
    MAX_NOTIFY_RADIUS_KM
  )
  const locationMaxAgeMinutes = parsePositiveInteger(
    process.env.DRIVER_LOCATION_MAX_AGE_MINUTES,
    DEFAULT_DRIVER_LOCATION_MAX_AGE_MINUTES,
    120
  )
  const maxDrivers = parsePositiveInteger(
    process.env.RIDE_REQUEST_DRIVER_NOTIFY_LIMIT,
    DEFAULT_NOTIFY_LIMIT,
    MAX_NOTIFY_LIMIT
  )

  return {
    radiusKm,
    locationMaxAgeMinutes,
    maxDrivers,
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
  return earthRadiusKm * c
}

export async function notifyNearbyDriversForRideRequest(
  input: NearbyDriverNotificationInput
): Promise<NearbyDriverNotificationResult> {
  const { radiusKm, locationMaxAgeMinutes, maxDrivers } =
    getNearbyDriverDispatchConfig()
  const bounds = buildBounds(input.pickupLat, input.pickupLng, radiusKm)
  const minUpdatedAt = new Date(Date.now() - locationMaxAgeMinutes * 60 * 1000)

  // Query candidates with a cheap bounding box filter, then exact Haversine.
  const candidates = await prisma.userLocation.findMany({
    where: {
      updatedAt: { gte: minUpdatedAt },
      lat: { gte: bounds.minLat, lte: bounds.maxLat },
      lng: { gte: bounds.minLng, lte: bounds.maxLng },
      user: {
        driverProfile: { isNot: null },
        id: { not: input.passengerId },
      },
    },
    select: {
      userId: true,
      lat: true,
      lng: true,
    },
    orderBy: { updatedAt: "desc" },
    take: Math.max(maxDrivers * 4, maxDrivers),
  })

  const nearby = candidates
    .map((candidate) => ({
      userId: candidate.userId,
      distanceKm: calculateDistanceKm(
        input.pickupLat,
        input.pickupLng,
        candidate.lat,
        candidate.lng
      ),
    }))
    .filter((candidate) => candidate.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, maxDrivers)

  if (nearby.length === 0) {
    return {
      matchedDrivers: 0,
      notifiedDrivers: 0,
      radiusKm,
      locationMaxAgeMinutes,
    }
  }

  const result = await notifyUsersByIds({
    userIds: nearby.map((candidate) => candidate.userId),
    title: "New ride request nearby",
    body: `${input.pickupCity} -> ${input.dropoffCity} request posted`,
    type: "ride_update",
    data: {
      rideRequestId: input.rideRequestId,
      kind: "ride_request_created_nearby",
    },
  })

  return {
    matchedDrivers: nearby.length,
    notifiedDrivers: result.notified,
    radiusKm,
    locationMaxAgeMinutes,
  }
}
