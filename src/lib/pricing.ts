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
  sameDestination?: boolean
}

export type RideTimingClassification = "PREBOOKED" | "ONTIME" | "STANDARD"
export type RidePricingStrategy = "FIXED_ROUTE" | "MARKET_MINIMUM" | "DRIVER_INPUT"

type RidePricingConfig = {
  baseFare: number
  perKmRate: number
  perMinuteRate: number
  minimumSeatPrice: number
  ontimeMarkupMultiplier: number
  maxSharedSeatDivisor: number
  assumedAverageSpeedKmh: number
  minimumDurationMinutes: number
}

export type SeatPriceResolution = {
  distanceKm: number
  estimatedDurationMinutes: number
  rideTiming: RideTimingClassification
  inputPricePerSeat: number
  marketFloorPricePerSeat: number
  fixedRoutePricePerSeat: number | null
  pricePerSeat: number
  finalPricePerSeat: number
  strategy: RidePricingStrategy
  appliedOntimeMarkup: boolean
  sharedSeatDivisor: number
  estimatedTripTotal: number
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

function getPositiveNumberEnv(name: string, fallback: number) {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`)
  }

  return parsed
}

function getNonNegativeNumberEnv(name: string, fallback: number) {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }

  return parsed
}

function getRidePricingConfig(): RidePricingConfig {
  return {
    baseFare: getNonNegativeNumberEnv("RIDE_PRICING_BASE_FARE", 3.5),
    perKmRate: getNonNegativeNumberEnv("RIDE_PRICING_PER_KM_RATE", 0.65),
    perMinuteRate: getNonNegativeNumberEnv("RIDE_PRICING_PER_MIN_RATE", 0.18),
    minimumSeatPrice: getNonNegativeNumberEnv(
      "RIDE_PRICING_MIN_SEAT_PRICE",
      6.5
    ),
    ontimeMarkupMultiplier: getPositiveNumberEnv(
      "RIDE_PRICING_ONTIME_MULTIPLIER",
      1.15
    ),
    maxSharedSeatDivisor: getPositiveNumberEnv(
      "RIDE_PRICING_MAX_SHARED_DIVISOR",
      2.5
    ),
    assumedAverageSpeedKmh: getPositiveNumberEnv(
      "RIDE_PRICING_ASSUMED_SPEED_KMH",
      32
    ),
    minimumDurationMinutes: getPositiveNumberEnv(
      "RIDE_PRICING_MIN_DURATION_MINUTES",
      8
    ),
  }
}

function classifyRideTiming(hoursUntilDeparture: number): RideTimingClassification {
  if (hoursUntilDeparture >= 10) {
    return "PREBOOKED"
  }

  if (hoursUntilDeparture >= 0 && hoursUntilDeparture <= 2) {
    return "ONTIME"
  }

  return "STANDARD"
}

export function classifyRideTimingByDeparture(
  departureTime: Date,
  referenceTime: Date = new Date()
): RideTimingClassification {
  const hoursUntilDeparture =
    (departureTime.getTime() - referenceTime.getTime()) / (1000 * 60 * 60)
  return classifyRideTiming(hoursUntilDeparture)
}

function estimateDurationMinutes(distanceKm: number, averageSpeedKmh: number) {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    return 0
  }

  const durationHours = distanceKm / averageSpeedKmh
  return Math.ceil(durationHours * 60)
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
  sameDestination: _sameDestination,
}: PricingInput) {
  const distanceKm = haversineDistanceKm(fromLat, fromLng, toLat, toLng)
  const fixedRoutePrice = await getFixedRoutePrice(fromCity, toCity)
  const inputPricePerSeat = basePricePerSeat < 0 ? 0 : basePricePerSeat

  const bookingTime = bookedAt ?? new Date()
  const rideTiming = classifyRideTimingByDeparture(departureTime, bookingTime)
  const config = getRidePricingConfig()
  const estimatedDurationMinutes = Math.max(
    config.minimumDurationMinutes,
    estimateDurationMinutes(distanceKm, config.assumedAverageSpeedKmh)
  )
  const sharedSeatDivisor =
    seats <= 1 ? 1 : Math.min(seats, config.maxSharedSeatDivisor)

  let estimatedTripTotal =
    config.baseFare +
    distanceKm * config.perKmRate +
    estimatedDurationMinutes * config.perMinuteRate
  let appliedOntimeMarkup = false

  if (rideTiming === "ONTIME") {
    estimatedTripTotal *= config.ontimeMarkupMultiplier
    appliedOntimeMarkup = true
  }

  const marketFloorPricePerSeat = Math.max(
    config.minimumSeatPrice,
    estimatedTripTotal / sharedSeatDivisor
  )

  let finalPricePerSeat = inputPricePerSeat
  let strategy: RidePricingStrategy = "DRIVER_INPUT"

  if (fixedRoutePrice != null) {
    finalPricePerSeat = fixedRoutePrice
    strategy = "FIXED_ROUTE"
  } else if (finalPricePerSeat < marketFloorPricePerSeat) {
    finalPricePerSeat = marketFloorPricePerSeat
    strategy = "MARKET_MINIMUM"
  }

  return {
    distanceKm,
    estimatedDurationMinutes,
    inputPricePerSeat: roundToCents(inputPricePerSeat),
    marketFloorPricePerSeat: roundToCents(marketFloorPricePerSeat),
    fixedRoutePricePerSeat:
      fixedRoutePrice == null ? null : roundToCents(fixedRoutePrice),
    pricePerSeat: roundToCents(finalPricePerSeat),
    finalPricePerSeat: roundToCents(finalPricePerSeat),
    strategy,
    appliedOntimeMarkup,
    sharedSeatDivisor,
    estimatedTripTotal: roundToCents(estimatedTripTotal),
    rideTiming,
  }
}
