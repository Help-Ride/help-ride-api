// src/controllers/rideRequest.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"
import { Prisma } from "../generated/prisma/client.js"
import { resolveSeatPrice } from "../lib/pricing.js"

interface CreateRideBody {
  fromCity?: string
  fromLat?: number
  fromLng?: number
  toCity?: string
  toLat?: number
  toLng?: number
  startTime?: string // ISO
  arrivalTime?: string // ISO (optional)
  pricePerSeat?: number
  seatsTotal?: number
}

interface UpdateRideBody {
  fromCity?: string
  fromLat?: number
  fromLng?: number
  toCity?: string
  toLat?: number
  toLng?: number
  startTime?: string
  arrivalTime?: string // ISO (optional, nullable)
  pricePerSeat?: number
  seatsTotal?: number
}

function validateAndParseStartTime(startTime: string | undefined): {
  date: Date | undefined
  error: string | null
} {
  if (!startTime) {
    return { date: undefined, error: null }
  }
  const d = new Date(startTime)
  if (Number.isNaN(d.getTime())) {
    return { date: undefined, error: "startTime must be a valid ISO date" }
  }
  return { date: d, error: null }
}

function validateAndParseArrivalTime(
  arrivalTime: string | null | undefined,
  startTimeDate: Date | undefined,
  rideStartTime: Date
): { date: Date | null | undefined; error: string | null } {
  if (arrivalTime === undefined) {
    return { date: undefined, error: null }
  }

  if (arrivalTime === null || arrivalTime === "") {
    return { date: null, error: null }
  }

  const d = new Date(arrivalTime)
  if (Number.isNaN(d.getTime())) {
    return { date: undefined, error: "arrivalTime must be a valid ISO date" }
  }

  const baseStart = startTimeDate ?? rideStartTime
  if (d.getTime() <= baseStart.getTime()) {
    return {
      date: undefined,
      error: "arrivalTime must be after startTime",
    }
  }

  return { date: d, error: null }
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

    const body = (req.body ?? {}) as CreateRideBody

    const {
      fromCity,
      fromLat,
      fromLng,
      toCity,
      toLat,
      toLng,
      startTime,
      arrivalTime,
      pricePerSeat,
      seatsTotal,
    } = body

    // Basic validation
    if (
      !fromCity ||
      typeof fromLat !== "number" ||
      typeof fromLng !== "number" ||
      !toCity ||
      typeof toLat !== "number" ||
      typeof toLng !== "number" ||
      !startTime ||
      typeof pricePerSeat !== "number" ||
      typeof seatsTotal !== "number"
    ) {
      return res.status(400).json({
        error:
          "fromCity, fromLat, fromLng, toCity, toLat, toLng, startTime, pricePerSeat, and seatsTotal are required",
      })
    }

    const startTimeDate = new Date(startTime)
    if (Number.isNaN(startTimeDate.getTime())) {
      return res
        .status(400)
        .json({ error: "startTime must be a valid ISO date" })
    }

    let arrivalTimeDate: Date | null = null
    if (arrivalTime) {
      const d = new Date(arrivalTime)
      if (Number.isNaN(d.getTime())) {
        return res
          .status(400)
          .json({ error: "arrivalTime must be a valid ISO date" })
      }
      // Optional sanity: arrival after start
      if (d.getTime() <= startTimeDate.getTime()) {
        return res.status(400).json({
          error: "arrivalTime must be after startTime",
        })
      }
      arrivalTimeDate = d
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
      departureTime: startTimeDate,
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
        startTime: startTimeDate,
        arrivalTime: arrivalTimeDate,
        pricePerSeat: new Prisma.Decimal(pricing.pricePerSeat),
        seatsTotal,
        seatsAvailable: seatsTotal,
        status: "open",
      },
    })

    return res.status(201).json(ride)
  } catch (err) {
    console.error("POST /rides error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function updateRide(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    const body = (req.body ?? {}) as UpdateRideBody

    const {
      fromCity,
      fromLat,
      fromLng,
      toCity,
      toLat,
      toLng,
      startTime,
      arrivalTime,
      pricePerSeat,
      seatsTotal,
    } = body

    const ride = await prisma.ride.findUnique({
      where: { id },
    })

    if (!ride) {
      return res.status(404).json({ error: "Ride not found" })
    }

    if (ride.driverId !== req.userId) {
      return res
        .status(403)
        .json({ error: "You are not the driver for this ride" })
    }

    const startTimeResult = validateAndParseStartTime(startTime)
    if (startTimeResult.error) {
      return res.status(400).json({ error: startTimeResult.error })
    }

    const arrivalTimeResult = validateAndParseArrivalTime(
      arrivalTime,
      startTimeResult.date,
      ride.startTime
    )
    if (arrivalTimeResult.error) {
      return res.status(400).json({ error: arrivalTimeResult.error })
    }

    const pricing =
      pricePerSeat !== undefined
        ? await resolveSeatPrice({
            fromCity: fromCity ?? ride.fromCity,
            toCity: toCity ?? ride.toCity,
            fromLat: fromLat ?? ride.fromLat,
            fromLng: fromLng ?? ride.fromLng,
            toLat: toLat ?? ride.toLat,
            toLng: toLng ?? ride.toLng,
            seats: seatsTotal ?? ride.seatsTotal,
            basePricePerSeat: pricePerSeat,
            departureTime: startTimeResult.date ?? ride.startTime,
          })
        : null

    const updated = await prisma.ride.update({
      where: { id },
      data: {
        fromCity: fromCity ?? ride.fromCity,
        fromLat: fromLat ?? ride.fromLat,
        fromLng: fromLng ?? ride.fromLng,
        toCity: toCity ?? ride.toCity,
        toLat: toLat ?? ride.toLat,
        toLng: toLng ?? ride.toLng,
        startTime: startTimeResult.date ?? ride.startTime,
        arrivalTime:
          arrivalTimeResult.date !== undefined
            ? arrivalTimeResult.date
            : ride.arrivalTime,
        pricePerSeat:
          pricing ? new Prisma.Decimal(pricing.pricePerSeat) : ride.pricePerSeat,
        seatsTotal: seatsTotal ?? ride.seatsTotal,
        // You can refine this later if you want smarter seat logic
        seatsAvailable: ride.seatsAvailable,
      },
    })

    return res.json(updated)
  } catch (err) {
    console.error("PUT /rides/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/ride-requests
 * Public list / search of ride requests
 */
export async function listRideRequests(req: AuthRequest, res: Response) {
  try {
    const { fromCity, toCity, status } = req.query as {
      fromCity?: string
      toCity?: string
      status?: string
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

    const requests = await prisma.rideRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        passenger: {
          select: {
            id: true,
            name: true,
            providerAvatarUrl: true,
          },
        },
      },
    })

    return res.json(requests)
  } catch (err) {
    console.error("GET /ride-requests error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
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
