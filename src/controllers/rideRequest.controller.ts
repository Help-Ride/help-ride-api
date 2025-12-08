// src/controllers/rideRequest.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"

const VALID_RIDE_REQUEST_STATUSES = ["pending", "matched", "cancelled", "expired"] as const;

const RIDE_TYPE_MAP: Record<string, "one_time" | "recurring"> = {
  "one-time": "one_time",
  "recurring": "recurring",
};

const TRIP_TYPE_MAP: Record<string, "one_way" | "round_trip"> = {
  "one-way": "one_way",
  "round-trip": "round_trip",
};

interface RideRequestBody {
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
  rideType?: "one-time" | "recurring"
  tripType?: "one-way" | "round-trip"
  returnDate?: string
  returnTime?: string
}

/**
 * POST /api/ride-requests
 * Create a ride request (passenger)
 */
export async function createRideRequest(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const body = (req.body ?? {}) as RideRequestBody

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

    if (
      !fromCity ||
      typeof fromLat !== "number" ||
      typeof fromLng !== "number" ||
      !toCity ||
      typeof toLat !== "number" ||
      typeof toLng !== "number" ||
      !preferredDate ||
      !rideType ||
      !tripType
    ) {
      return res.status(400).json({
        error:
          "fromCity, fromLat, fromLng, toCity, toLat, toLng, preferredDate, rideType, and tripType are required",
      })
    }

    const seats = Number(seatsNeeded ?? 1)
    if (!Number.isInteger(seats) || seats <= 0) {
      return res
        .status(400)
        .json({ error: "seatsNeeded must be a positive integer" })
    }

    if (!["one-time", "recurring"].includes(rideType)) {
      return res
        .status(400)
        .json({ error: "rideType must be one-time or recurring" })
    }

    if (!["one-way", "round-trip"].includes(tripType)) {
      return res
        .status(400)
        .json({ error: "tripType must be one-way or round-trip" })
    }

    const preferredDateObj = new Date(preferredDate)
    if (Number.isNaN(preferredDateObj.getTime())) {
      return res
        .status(400)
        .json({ error: "preferredDate must be a valid ISO date" })
    }

    // Validate round-trip requires returnDate
    if (tripType === "round-trip" && !returnDate) {
      return res
        .status(400)
        .json({ error: "returnDate is required for round-trip journeys" })
    }

    let returnDateObj: Date | null = null
    if (returnDate) {
      const d = new Date(returnDate)
      if (Number.isNaN(d.getTime())) {
        return res
          .status(400)
          .json({ error: "returnDate must be a valid ISO date" })
      }
      returnDateObj = d
    }

    // Ensure returnDate is after or equal to preferredDate for round-trip journeys
    if (
      tripType === "round-trip" &&
      returnDateObj &&
      returnDateObj.getTime() < preferredDateObj.getTime()
    ) {
      return res
        .status(400)
        .json({ error: "returnDate must be after or equal to preferredDate for round-trip journeys" })
    }

    // Convert from API format (hyphenated) to database enum format (underscored)
    const rideTypeEnum = RIDE_TYPE_MAP[rideType];
    const tripTypeEnum = TRIP_TYPE_MAP[tripType];

    const request = await prisma.rideRequest.create({
      data: {
        passengerId: req.userId,
        fromCity,
        fromLat,
        fromLng,
        toCity,
        toLat,
        toLng,
        preferredDate: preferredDateObj,
        preferredTime: preferredTime ?? null,
        arrivalTime: arrivalTime ?? null,
        seatsNeeded: seats,
        rideType: rideTypeEnum,
        tripType: tripTypeEnum,
        returnDate: returnDateObj,
        returnTime: returnTime ?? null,
        status: "pending",
      },
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

    // TODO later: trigger matching + notifications to drivers

    return res.status(201).json(request)
  } catch (err) {
    console.error("POST /api/ride-requests error", err)
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
    
    // Validate and set status filter
    if (status) {
      const isValidStatus = (s: string): s is typeof VALID_RIDE_REQUEST_STATUSES[number] => 
        (VALID_RIDE_REQUEST_STATUSES as readonly string[]).includes(s);
      
      if (!isValidStatus(status)) {
        return res.status(400).json({ 
          error: `Invalid status. Must be one of: ${VALID_RIDE_REQUEST_STATUSES.join(", ")}` 
        });
      }
      where.status = status;
    } else {
      where.status = "pending";
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
    console.error("GET /api/ride-requests error", err)
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
    console.error("GET /api/ride-requests/me/list error", err)
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
    console.error("GET /api/ride-requests/:id error", err)
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
    console.error("DELETE /api/ride-requests/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
