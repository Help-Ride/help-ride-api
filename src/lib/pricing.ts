import prisma from "./prisma.js"

type PricingInput = {
  fromCity: string
  toCity: string
  fromLat: number
  fromLng: number
  toLat: number
  toLng: number
  seats: number
  basePricePerSeat: number
  departureTime: Date
  bookedAt?: Date
}

function normalizeCity(value: string) {
  return value.trim().toLowerCase()
}

async function getFixedRoutePrice(fromCity: string, toCity: string) {
  const normalizedFrom = normalizeCity(fromCity)
  const normalizedTo = normalizeCity(toCity)
  const route = await prisma.fixedRoutePrice.findFirst({
    where: {
      fromCity: normalizedFrom,
      toCity: normalizedTo,
      isActive: true,
    },
    select: {
      pricePerSeat: true,
    },
  })
  return route ? Number(route.pricePerSeat) : null
}

export function haversineDistanceKm(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
) {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const earthRadiusKm = 6371
  const dLat = toRad(toLat - fromLat)
  const dLng = toRad(toLng - fromLng)
  const lat1 = toRad(fromLat)
  const lat2 = toRad(toLat)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return earthRadiusKm * c
}

function roundToCents(value: number) {
  return Math.round(value * 100) / 100
}

export async function resolveSeatPrice({
  fromCity,
  toCity,
  fromLat,
  fromLng,
  toLat,
  toLng,
  seats,
  basePricePerSeat,
  departureTime,
  bookedAt,
}: PricingInput) {
  const distanceKm = haversineDistanceKm(fromLat, fromLng, toLat, toLng)
  const fixedRoutePrice = await getFixedRoutePrice(fromCity, toCity)
  let pricePerSeat = fixedRoutePrice ?? basePricePerSeat

  const bookingTime = bookedAt ?? new Date()
  const hoursUntilDeparture =
    (departureTime.getTime() - bookingTime.getTime()) / (1000 * 60 * 60)

  if (hoursUntilDeparture <= 2) {
    pricePerSeat *= 1.3
  }

  if (distanceKm >= 55 && seats <= 2 && pricePerSeat < 20) {
    pricePerSeat = 20
  }

  if (distanceKm >= 50 && pricePerSeat > 15) {
    pricePerSeat = 15
  }

  const upperCap = distanceKm * 0.3
  if (pricePerSeat > upperCap) {
    pricePerSeat = upperCap
  }

  return {
    distanceKm,
    pricePerSeat: roundToCents(pricePerSeat),
  }
}
