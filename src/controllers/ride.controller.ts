// src/controllers/ride.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"
import { resolveSeatPrice } from "../lib/pricing.js"
import { notifyUser, notifyUsersByRole } from "../lib/notifications.js"

interface CreateRideBody {
  fromCity: string
  fromLat: number
  fromLng: number
  toCity: string
  toLat: number
  toLng: number
  startTime: string // ISO string from client
  pricePerSeat: number
  seatsTotal: number
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

    if (seatsTotal <= 0) {
      return res.status(400).json({ error: "seatsTotal must be > 0" })
    }
    if (pricePerSeat < 0) {
      return res.status(400).json({ error: "pricePerSeat must be >= 0" })
    }

    const start = new Date(startTime)
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid startTime" })
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

    const ride = await prisma.ride.create({
      data: {
        driverId: req.userId,
        fromCity,
        fromLat,
        fromLng,
        toCity,
        toLat,
        toLng,
        startTime: start,
        pricePerSeat: pricing.pricePerSeat,
        seatsTotal,
        seatsAvailable: seatsTotal,
        status: "open",
      },
    })

    await notifyUsersByRole({
      role: "passenger",
      excludeUserId: req.userId,
      title: "New ride available",
      body: `${ride.fromCity} → ${ride.toCity} is now available`,
      type: "ride_update",
      data: {
        rideId: ride.id,
        kind: "ride_created",
      },
    })

    return res.status(201).json(ride)
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

    return res.json(rides)
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

    return res.json(rides)
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

    return res.json(ride)
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

    // Prepare update data
    const updateData: any = {
      ...(updates.fromCity && { fromCity: updates.fromCity }),
      ...(updates.fromLat != null && { fromLat: updates.fromLat }),
      ...(updates.fromLng != null && { fromLng: updates.fromLng }),
      ...(updates.toCity && { toCity: updates.toCity }),
      ...(updates.toLat != null && { toLat: updates.toLat }),
      ...(updates.toLng != null && { toLng: updates.toLng }),
      ...(updates.startTime && { startTime: new Date(updates.startTime) }),
      ...(updates.pricePerSeat != null && {
        pricePerSeat: updates.pricePerSeat,
      }),
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

    if (updates.pricePerSeat != null) {
      const pricing = await resolveSeatPrice({
        fromCity: updates.fromCity ?? ride.fromCity,
        toCity: updates.toCity ?? ride.toCity,
        fromLat: updates.fromLat ?? ride.fromLat,
        fromLng: updates.fromLng ?? ride.fromLng,
        toLat: updates.toLat ?? ride.toLat,
        toLng: updates.toLng ?? ride.toLng,
        seats: updates.seatsTotal ?? ride.seatsTotal,
        basePricePerSeat: updates.pricePerSeat,
        departureTime: updates.startTime
          ? new Date(updates.startTime)
          : ride.startTime,
      })
      updateData.pricePerSeat = pricing.pricePerSeat
    }

    const updatedRide = await prisma.ride.update({
      where: { id },
      data: updateData,
    })

    return res.json(updatedRide)
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
      select: { id: true, passengerId: true },
    })

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
