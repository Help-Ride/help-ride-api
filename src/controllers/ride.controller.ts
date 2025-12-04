// src/controllers/ride.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"

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
        pricePerSeat,
        seatsTotal,
        seatsAvailable: seatsTotal,
        status: "open",
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
 *  - toCity (optional)
 *  - date (optional, YYYY-MM-DD)
 *  - seats (optional, min seats required)
 */
export async function searchRides(req: AuthRequest, res: Response) {
  try {
    const { fromCity, toCity, date, seats } = req.query

    const minSeats = seats ? Number(seats) : 1
    if (seats && Number.isNaN(minSeats)) {
      return res.status(400).json({ error: "Invalid seats parameter" })
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

    if (fromCity && typeof fromCity === "string") {
      filters.fromCity = {
        contains: fromCity,
        mode: "insensitive",
      }
    }

    if (toCity && typeof toCity === "string") {
      filters.toCity = {
        contains: toCity,
        mode: "insensitive",
      }
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

    const rides = await prisma.ride.findMany({
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

    return res.json(rides)
  } catch (err) {
    console.error("GET /api/rides error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
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
      updateData.seatsTotal = updates.seatsTotal;
      // Adjust seatsAvailable proportionally
      const delta = updates.seatsTotal - ride.seatsTotal;
      let newSeatsAvailable = ride.seatsAvailable + delta;
      // Clamp between 0 and updates.seatsTotal
      newSeatsAvailable = Math.max(0, Math.min(newSeatsAvailable, updates.seatsTotal));
      updateData.seatsAvailable = newSeatsAvailable;
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
