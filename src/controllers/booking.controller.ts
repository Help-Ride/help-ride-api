// src/controllers/booking.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"

interface CreateBookingBody {
  seats?: number
}

/**
 * POST /api/bookings/:rideId
 * Passenger requests a booking (PENDING)
 */
export async function createBooking(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { rideId } = req.params
    const { seats } = (req.body ?? {}) as CreateBookingBody

    const seatsRequested = Number(seats ?? 1)
    if (!rideId) {
      return res.status(400).json({ error: "rideId is required" })
    }
    if (!Number.isFinite(seatsRequested) || seatsRequested <= 0) {
      return res.status(400).json({ error: "seats must be a positive integer" })
    }

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      select: {
        id: true,
        driverId: true,
        status: true,
        seatsAvailable: true,
      },
    })

    if (!ride) {
      return res.status(404).json({ error: "Ride not found" })
    }

    // Passenger cannot book their own ride
    if (ride.driverId === req.userId) {
      return res.status(400).json({
        error: "You cannot book your own ride",
      })
    }

    if (ride.status !== "open") {
      return res.status(400).json({
        error: "Ride is not open for booking",
      })
    }

    if (ride.seatsAvailable < seatsRequested) {
      return res.status(400).json({
        error: "Not enough seats available",
      })
    }

    // NOTE: we DO NOT decrement seats here.
    // Seats are decremented only when driver confirms.
    const booking = await prisma.booking.create({
      data: {
        rideId: ride.id,
        passengerId: req.userId,
        seatsBooked: seatsRequested,
        status: "pending",
      },
      include: {
        ride: {
          select: {
            id: true,
            fromCity: true,
            toCity: true,
            startTime: true,
            driverId: true,
          },
        },
      },
    })

    // TODO: create notification for driver (booking_request)

    return res.status(201).json(booking)
  } catch (err) {
    console.error("POST /bookings/:rideId error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/bookings/me/list
 * Passenger sees own bookings
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
            driverId: true,
          },
        },
      },
    })

    return res.json(bookings)
  } catch (err) {
    console.error("GET /bookings/me/list error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/bookings/ride/:rideId
 * Driver sees bookings for a ride they own
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
      return res.status(403).json({
        error: "You are not the driver for this ride",
      })
    }

    const bookings = await prisma.booking.findMany({
      where: { rideId },
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
    console.error("GET /bookings/ride/:rideId error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * PUT /api/bookings/:id/confirm
 * Driver confirms booking → seats are decremented here
 */
export async function confirmBooking(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "booking id is required" })
    }

    const booking = await prisma.booking.findUnique({
      where: { id },
      include: { ride: true },
    })

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" })
    }

    if (booking.ride.driverId !== req.userId) {
      return res.status(403).json({
        error: "You are not the driver for this ride",
      })
    }

    if (booking.status !== "pending") {
      return res.status(400).json({
        error: "Only pending bookings can be confirmed",
      })
    }

    if (booking.ride.status !== "open") {
      return res.status(400).json({
        error: "Ride is not open for booking",
      })
    }

    if (booking.ride.seatsAvailable < booking.seatsBooked) {
      return res.status(400).json({
        error: "Not enough seats available to confirm this booking",
      })
    }

    const [updatedBooking, updatedRide] = await prisma.$transaction([
      prisma.booking.update({
        where: { id: booking.id },
        data: {
          status: "confirmed",
        },
      }),
      prisma.ride.update({
        where: { id: booking.rideId },
        data: {
          seatsAvailable: booking.ride.seatsAvailable - booking.seatsBooked,
          status:
            booking.ride.seatsAvailable - booking.seatsBooked <= 0
              ? "open" // or "full" if you extend RideStatus
              : booking.ride.status,
        },
      }),
    ])

    // TODO: notification to passenger (booking_confirmed)

    return res.json({
      booking: updatedBooking,
      ride: updatedRide,
    })
  } catch (err) {
    console.error("PUT /bookings/:id/confirm error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * PUT /api/bookings/:id/reject
 * Driver rejects booking → no seat change
 */
export async function rejectBooking(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "booking id is required" })
    }

    const booking = await prisma.booking.findUnique({
      where: { id },
      include: { ride: true },
    })

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" })
    }

    if (booking.ride.driverId !== req.userId) {
      return res.status(403).json({
        error: "You are not the driver for this ride",
      })
    }

    if (booking.status !== "pending") {
      return res.status(400).json({
        error: "Only pending bookings can be rejected",
      })
    }

    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: {
        status: "cancelled_by_driver",
      },
    })

    // TODO: notification to passenger (booking_rejected)

    return res.json(updated)
  } catch (err) {
    console.error("PUT /bookings/:id/reject error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
