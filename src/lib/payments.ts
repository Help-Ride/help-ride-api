import { haversineDistanceKm } from "./pricing.js"

export type FareCalculationInput = {
  fromLat: number
  fromLng: number
  toLat: number
  toLng: number
  pricePerSeat: number
  seatsBooked: number
}

type PricingModelConfig = {
  baseFareCents: number
  perKmRateCents: number
  serviceFeeCents: number
  taxRateBps: number
}

export type FareBreakdown = {
  seatSubtotalCents: number
  baseFareCents: number
  distanceCents: number
  serviceFeeCents: number
  subtotalCents: number
  taxCents: number
}

function getNonNegativeIntEnv(name: string, fallback: number) {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }

  return parsed
}

function getPricingModelConfig(): PricingModelConfig {
  return {
    // Defaults preserve the current amount behavior unless configured.
    baseFareCents: getNonNegativeIntEnv("PAYMENT_BASE_FARE_CENTS", 0),
    perKmRateCents: getNonNegativeIntEnv("PAYMENT_PER_KM_RATE_CENTS", 0),
    serviceFeeCents: getNonNegativeIntEnv("PAYMENT_SERVICE_FEE_CENTS", 0),
    taxRateBps: getNonNegativeIntEnv("PAYMENT_TAX_BPS", 0),
  }
}

export function calculateBookingFareCents({
  fromLat,
  fromLng,
  toLat,
  toLng,
  pricePerSeat,
  seatsBooked,
}: FareCalculationInput) {
  const distanceKm = haversineDistanceKm(fromLat, fromLng, toLat, toLng)
  const config = getPricingModelConfig()
  const seatSubtotalCents = Math.round(pricePerSeat * seatsBooked * 100)
  const distanceCents = Math.round(distanceKm * config.perKmRateCents)
  const baseDistanceFareCents = config.baseFareCents + distanceCents
  const rideFareCents = Math.max(seatSubtotalCents, baseDistanceFareCents)
  const subtotalCents = rideFareCents + config.serviceFeeCents
  const taxCents = Math.round((subtotalCents * config.taxRateBps) / 10_000)
  const fareCents = subtotalCents + taxCents

  return {
    distanceKm,
    fareCents,
    breakdown: {
      seatSubtotalCents,
      baseFareCents: config.baseFareCents,
      distanceCents,
      serviceFeeCents: config.serviceFeeCents,
      subtotalCents,
      taxCents,
    } satisfies FareBreakdown,
  }
}
