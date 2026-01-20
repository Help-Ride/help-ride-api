// src/controllers/rideRequest.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"

interface CreateRideRequestBody {
  fromCity?: string
  fromLat?: number
  fromLng?: number
  toCity?: string
  toLat?: number
  toLng?: number
  preferredDate?: string // ISO
  preferredTime?: string
  arrivalTime?: string
  seatsNeeded?: number
  rideType?: string
  tripType?: string
  returnDate?: string // ISO (optional)
  returnTime?: string
}

interface UpdateRideRequestBody {
  fromCity?: string
  fromLat?: number
  fromLng?: number
  toCity?: string
  toLat?: number
  toLng?: number
  preferredDate?: string
  preferredTime?: string
  arrivalTime?: string | null
  seatsNeeded?: number
  rideType?: string
  tripType?: string
  returnDate?: string | null
  returnTime?: string | null
}

function validateAndParsePreferredDate(preferredDate: string | undefined): {
  date: Date | undefined
  error: string | null
} {
  if (!preferredDate) {
    return { date: undefined, error: null }
  }
  const d = new Date(preferredDate)
  if (Number.isNaN(d.getTime())) {
    return { date: undefined, error: "preferredDate must be a valid ISO date" }
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

    const body = (req.body ?? {}) as CreateRideRequestBody

    const {
      fromCity,
      fromLat,
      fromLng,
      toCity,
      toLat,
      toLng,
      preferredDate,
      preferredTime,
      arrivalTime,
      seatsNeeded,
      rideType,
      tripType,
      returnDate,
      returnTime,
    } = body

    // Basic validation
    if (
      !fromCity ||
      typeof fromLat !== "number" ||
      typeof fromLng !== "number" ||
      !toCity ||
      typeof toLat !== "number" ||
      typeof toLng !== "number" ||
      !preferredDate ||
      typeof seatsNeeded !== "number" ||
      !rideType ||
      !tripType
    ) {
      return res.status(400).json({
        error:
          "fromCity, fromLat, fromLng, toCity, toLat, toLng, preferredDate, seatsNeeded, rideType, and tripType are required",
      })
    }

    if (!Number.isFinite(seatsNeeded) || seatsNeeded <= 0) {
      return res
        .status(400)
        .json({ error: "seatsNeeded must be a positive integer" })
    }

    const preferredDateValue = new Date(preferredDate)
    if (Number.isNaN(preferredDateValue.getTime())) {
      return res
        .status(400)
        .json({ error: "preferredDate must be a valid ISO date" })
    }

    let returnDateValue: Date | null = null
    if (returnDate) {
      const d = new Date(returnDate)
      if (Number.isNaN(d.getTime())) {
        return res
          .status(400)
          .json({ error: "returnDate must be a valid ISO date" })
      }
      returnDateValue = d
    }

    const request = await prisma.rideRequest.create({
      data: {
        passengerId: req.userId,
        fromCity,
        fromLat,
        fromLng,
        toCity,
        toLat,
        toLng,
        preferredDate: preferredDateValue,
        preferredTime: preferredTime ?? null,
        arrivalTime: arrivalTime ?? null,
        seatsNeeded,
        rideType,
        tripType,
        returnDate: returnDateValue,
        returnTime: returnTime ?? null,
      },
    })

    return res.status(201).json(request)
  } catch (err) {
    console.error("POST /ride-requests error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function updateRide(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    const body = (req.body ?? {}) as UpdateRideRequestBody

    const {
      fromCity,
      fromLat,
      fromLng,
      toCity,
      toLat,
      toLng,
      preferredDate,
      preferredTime,
      arrivalTime,
      seatsNeeded,
      rideType,
      tripType,
      returnDate,
      returnTime,
    } = body

    const request = await prisma.rideRequest.findUnique({
      where: { id },
    })

    if (!request) {
      return res.status(404).json({ error: "Ride request not found" })
    }

    if (request.passengerId !== req.userId) {
      return res.status(403).json({
        error: "You can only update your own ride requests",
      })
    }

    const preferredDateResult = validateAndParsePreferredDate(preferredDate)
    if (preferredDateResult.error) {
      return res.status(400).json({ error: preferredDateResult.error })
    }

    if (seatsNeeded !== undefined) {
      if (!Number.isFinite(seatsNeeded) || seatsNeeded <= 0) {
        return res
          .status(400)
          .json({ error: "seatsNeeded must be a positive integer" })
      }
    }

    let returnDateValue: Date | null | undefined
    if (returnDate !== undefined) {
      if (returnDate === null || returnDate === "") {
        returnDateValue = null
      } else {
        const d = new Date(returnDate)
        if (Number.isNaN(d.getTime())) {
          return res
            .status(400)
            .json({ error: "returnDate must be a valid ISO date" })
        }
        returnDateValue = d
      }
    }

    const updated = await prisma.rideRequest.update({
      where: { id },
      data: {
        fromCity: fromCity ?? request.fromCity,
        fromLat: fromLat ?? request.fromLat,
        fromLng: fromLng ?? request.fromLng,
        toCity: toCity ?? request.toCity,
        toLat: toLat ?? request.toLat,
        toLng: toLng ?? request.toLng,
        preferredDate: preferredDateResult.date ?? request.preferredDate,
        preferredTime:
          preferredTime !== undefined ? preferredTime : request.preferredTime,
        arrivalTime: arrivalTime !== undefined ? arrivalTime : request.arrivalTime,
        seatsNeeded: seatsNeeded ?? request.seatsNeeded,
        rideType: rideType ?? request.rideType,
        tripType: tripType ?? request.tripType,
        returnDate: returnDateValue ?? request.returnDate,
        returnTime: returnTime !== undefined ? returnTime : request.returnTime,
      },
    })

    return res.json(updated)
  } catch (err) {
    console.error("PUT /ride-requests/:id error", err)
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
