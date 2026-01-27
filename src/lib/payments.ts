import { haversineDistanceKm } from "./pricing.js"

export type FareCalculationInput = {
  fromLat: number
  fromLng: number
  toLat: number
  toLng: number
  pricePerSeat: number
  seatsBooked: number
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
  const fareCents = Math.round(pricePerSeat * seatsBooked * 100)

  return { distanceKm, fareCents }
}
