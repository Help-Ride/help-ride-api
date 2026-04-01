import { haversineDistanceKm } from "./pricing.js"

export type FareCalculationInput = {
  fromLat: number
  fromLng: number
  toLat: number
  toLng: number
  pricePerSeat: number
  seatsBooked: number
}

export type FareBreakdown = {
  seatSubtotalCents: number
  baseFareCents: number
  distanceCents: number
  serviceFeeCents: number
  subtotalCents: number
  taxCents: number
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
  const seatSubtotalCents = Math.round(pricePerSeat * seatsBooked * 100)
  const fareCents = seatSubtotalCents

  return {
    distanceKm,
    fareCents,
    breakdown: {
      seatSubtotalCents,
      baseFareCents: 0,
      distanceCents: 0,
      serviceFeeCents: 0,
      subtotalCents: seatSubtotalCents,
      taxCents: 0,
    } satisfies FareBreakdown,
  }
}
