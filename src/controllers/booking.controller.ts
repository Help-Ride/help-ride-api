// src/controllers/booking.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"

/**
 * POST /api/bookings/:rideId
 * Body:
 * {
 *   "seats": number
 * }
 */
export async function createBooking(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { rideId } = req.params
    const { seats } = req.body ?? {}

    const seatsRequested = Number(seats)

    if (!rideId) {
      return res.status(400).json({ error: "rideId is required" })
    }

    if (!seatsRequested || seatsRequested <= 0) {
      return res.status(400).json({ error: "seats must be a positive number" })
    }

    const now = new Date()

    const result = await prisma.$transaction(async (tx) => {
      const ride = await tx.ride.findUnique({
        where: { id: rideId },
        select: {
          id: true,
          driverId: true,
          fromCity: true,
          toCity: true,
          startTime: true,
          pricePerSeat: true,
          seatsAvailable: true,
          status: true,
        },
      })

      if (!ride) {
        throw { status: 404, message: "Ride not found" }
      }

      if (ride.status !== "open") {
        throw { status: 400, message: "Ride is not open for booking" }
      }

      if (ride.startTime <= now) {
        throw { status: 400, message: "Cannot book a past ride" }
      }

      if (ride.seatsAvailable < seatsRequested) {
        throw {
          status: 400,
          message: `Only ${ride.seatsAvailable} seat(s) left on this ride`,
        }
      }

      // Create booking
      const booking = await tx.booking.create({
        data: {
          rideId: ride.id,
          passengerId: req.userId!,
          seatsBooked: seatsRequested,
          status: "pending", // later can add driver approval flow
          paymentStatus: "unpaid", // Stripe will update this
        },
      })

      // Decrement seatsAvailable
      await tx.ride.update({
        where: { id: ride.id },
        data: {
          seatsAvailable: {
            decrement: seatsRequested,
          },
        },
      })

      return { ride, booking }
    })

    return res.status(201).json({
      booking: result.booking,
      ride: result.ride,
    })
  } catch (err: any) {
    if (err && typeof err === "object" && "status" in err) {
      return res.status(err.status ?? 400).json({ error: err.message })
    }

    console.error("POST /api/bookings/:rideId error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/bookings/me
 * Passenger sees their own bookings with basic ride info
 */
export async function getMyBookings(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const bookings = await prisma.booking.findMany({
      where: { passengerId: req.userId },
      orderBy: { createdAt: "desc" },
      include: {
        ride: {
          select: {
            id: true,
            fromCity: true,
            toCity: true,
            startTime: true,
            pricePerSeat: true,
          },
        },
      },
    })

    return res.json(bookings)
  } catch (err) {
    console.error("GET /api/bookings/me error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/bookings/ride/:rideId
 * Driver sees bookings for their ride
 */
export async function getBookingsForRide(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { rideId } = req.params

    if (!rideId) {
      return res.status(400).json({ error: "rideId is required" })
    }

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      select: {
        id: true,
        driverId: true,
      },
    })

    if (!ride) {
      return res.status(404).json({ error: "Ride not found" })
    }

    if (ride.driverId !== req.userId) {
      return res
        .status(403)
        .json({ error: "You are not the driver of this ride" })
    }

    const bookings = await prisma.booking.findMany({
      where: { rideId: rideId },
      orderBy: { createdAt: "desc" },
      include: {
        passenger: {
          select: {
            id: true,
            name: true,
            email: true,
            providerAvatarUrl: true,
          },
        },
      },
    })

    return res.json(bookings)
  } catch (err) {
    console.error("GET /api/bookings/ride/:rideId error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
