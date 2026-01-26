// src/controllers/rideRequestOffer.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"

interface CreateOfferBody {
  rideId?: string
  seatsOffered?: number
}

/**
 * POST /api/ride-requests/:id/offers
 * Driver creates an offer for a passenger ride request
 */
export async function createRideRequestOffer(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id: rideRequestId } = req.params
    const { rideId, seatsOffered } = (req.body ?? {}) as CreateOfferBody

    if (!rideRequestId || !rideId) {
      return res
        .status(400)
        .json({ error: "rideRequestId and rideId are required" })
    }

    const [rideRequest, ride] = await Promise.all([
      prisma.rideRequest.findUnique({ where: { id: rideRequestId } }),
      prisma.ride.findUnique({ where: { id: rideId } }),
    ])

    if (!rideRequest) {
      return res.status(404).json({ error: "Ride request not found" })
    }

    if (rideRequest.status !== "pending") {
      return res.status(400).json({ error: "Ride request is not pending" })
    }

    if (!ride) {
      return res.status(404).json({ error: "Ride not found" })
    }

    if (ride.driverId !== req.userId) {
      return res
        .status(403)
        .json({ error: "You are not the driver for this ride" })
    }

    if (ride.driverId === rideRequest.passengerId) {
      return res
        .status(400)
        .json({ error: "You cannot offer your own request" })
    }

    if (ride.status !== "open") {
      return res.status(400).json({ error: "Ride is not open for offers" })
    }

    const seats =
      seatsOffered !== undefined
        ? Number(seatsOffered)
        : rideRequest.seatsNeeded
    if (!Number.isFinite(seats) || seats <= 0) {
      return res
        .status(400)
        .json({ error: "seatsOffered must be a positive integer" })
    }

    if (seats < rideRequest.seatsNeeded) {
      return res.status(400).json({
        error: "seatsOffered must be at least seatsNeeded for the request",
      })
    }

    if (ride.seatsAvailable < seats) {
      return res.status(400).json({ error: "Not enough seats available" })
    }

    const offer = await prisma.rideRequestOffer.create({
      data: {
        rideRequestId: rideRequest.id,
        driverId: ride.driverId,
        rideId: ride.id,
        seatsOffered: seats,
        pricePerSeat: ride.pricePerSeat,
      },
    })

    return res.status(201).json(offer)
  } catch (err) {
    console.error("POST /ride-requests/:id/offers error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/ride-requests/:id/offers
 * Passenger sees all offers; driver sees their own offers for the request
 */
export async function listRideRequestOffers(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id: rideRequestId } = req.params
    if (!rideRequestId) {
      return res.status(400).json({ error: "rideRequestId is required" })
    }

    const rideRequest = await prisma.rideRequest.findUnique({
      where: { id: rideRequestId },
    })

    if (!rideRequest) {
      return res.status(404).json({ error: "Ride request not found" })
    }

    const isPassenger = rideRequest.passengerId === req.userId

    const where = isPassenger
      ? { rideRequestId }
      : { rideRequestId, driverId: req.userId }

    const offers = await prisma.rideRequestOffer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        ride: {
          select: {
            id: true,
            fromCity: true,
            toCity: true,
            startTime: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            providerAvatarUrl: true,
          },
        },
      },
    })

    return res.json(offers)
  } catch (err) {
    console.error("GET /ride-requests/:id/offers error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/ride-requests/offers/me/list
 * Driver lists offers they have made
 */
export async function listMyRideRequestOffers(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const offers = await prisma.rideRequestOffer.findMany({
      where: { driverId: req.userId },
      orderBy: { createdAt: "desc" },
      include: {
        rideRequest: {
          select: {
            id: true,
            fromCity: true,
            toCity: true,
            preferredDate: true,
            seatsNeeded: true,
          },
        },
      },
    })

    return res.json(offers)
  } catch (err) {
    console.error("GET /ride-requests/offers/me/list error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * PUT /api/ride-requests/:id/offers/:offerId/accept
 * Passenger accepts an offer and confirms the ride
 */
export async function acceptRideRequestOffer(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id: rideRequestId, offerId } = req.params
    if (!rideRequestId || !offerId) {
      return res
        .status(400)
        .json({ error: "rideRequestId and offerId are required" })
    }

    const offer = await prisma.rideRequestOffer.findUnique({
      where: { id: offerId },
      include: { rideRequest: true, ride: true },
    })

    if (!offer || offer.rideRequestId !== rideRequestId) {
      return res.status(404).json({ error: "Offer not found" })
    }

    if (offer.rideRequest.passengerId !== req.userId) {
      return res
        .status(403)
        .json({ error: "You can only accept offers for your request" })
    }

    if (offer.status !== "pending") {
      return res
        .status(400)
        .json({ error: "Only pending offers can be accepted" })
    }

    if (offer.rideRequest.status !== "pending") {
      return res.status(400).json({ error: "Ride request is not pending" })
    }

    if (offer.ride.status !== "open") {
      return res.status(400).json({ error: "Ride is not open for booking" })
    }

    if (offer.ride.seatsAvailable < offer.seatsOffered) {
      return res.status(400).json({ error: "Not enough seats available" })
    }

    const [
      updatedOffer,
      updatedRequest,
      booking,
      updatedRide,
      _rejectedOffers,
    ] = await prisma.$transaction([
      prisma.rideRequestOffer.update({
        where: { id: offer.id },
        data: { status: "accepted" },
      }),
      prisma.rideRequest.update({
        where: { id: offer.rideRequestId },
        data: { status: "matched" },
      }),
      prisma.booking.create({
        data: {
          rideId: offer.rideId,
          passengerId: offer.rideRequest.passengerId,
          seatsBooked: offer.seatsOffered,
          status: "confirmed",
        },
      }),
      prisma.ride.update({
        where: { id: offer.rideId },
        data: {
          seatsAvailable: offer.ride.seatsAvailable - offer.seatsOffered,
          status:
            offer.ride.seatsAvailable - offer.seatsOffered <= 0
              ? "open"
              : offer.ride.status,
        },
      }),
      prisma.rideRequestOffer.updateMany({
        where: {
          rideRequestId: offer.rideRequestId,
          status: "pending",
          NOT: { id: offer.id },
        },
        data: { status: "rejected" },
      }),
    ])

    return res.json({
      offer: updatedOffer,
      rideRequest: updatedRequest,
      booking,
      ride: updatedRide,
    })
  } catch (err) {
    console.error("PUT /ride-requests/:id/offers/:offerId/accept error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * PUT /api/ride-requests/:id/offers/:offerId/reject
 * Passenger rejects an offer
 */
export async function rejectRideRequestOffer(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id: rideRequestId, offerId } = req.params
    if (!rideRequestId || !offerId) {
      return res
        .status(400)
        .json({ error: "rideRequestId and offerId are required" })
    }

    const offer = await prisma.rideRequestOffer.findUnique({
      where: { id: offerId },
      include: { rideRequest: true },
    })

    if (!offer || offer.rideRequestId !== rideRequestId) {
      return res.status(404).json({ error: "Offer not found" })
    }

    if (offer.rideRequest.passengerId !== req.userId) {
      return res
        .status(403)
        .json({ error: "You can only reject offers for your request" })
    }

    if (offer.status !== "pending") {
      return res
        .status(400)
        .json({ error: "Only pending offers can be rejected" })
    }

    const updated = await prisma.rideRequestOffer.update({
      where: { id: offer.id },
      data: { status: "rejected" },
    })

    return res.json(updated)
  } catch (err) {
    console.error("PUT /ride-requests/:id/offers/:offerId/reject error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * PUT /api/ride-requests/:id/offers/:offerId/cancel
 * Driver cancels an offer
 */
export async function cancelRideRequestOffer(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id: rideRequestId, offerId } = req.params
    if (!rideRequestId || !offerId) {
      return res
        .status(400)
        .json({ error: "rideRequestId and offerId are required" })
    }

    const offer = await prisma.rideRequestOffer.findUnique({
      where: { id: offerId },
    })

    if (!offer || offer.rideRequestId !== rideRequestId) {
      return res.status(404).json({ error: "Offer not found" })
    }

    if (offer.driverId !== req.userId) {
      return res
        .status(403)
        .json({ error: "You can only cancel your own offers" })
    }

    if (offer.status !== "pending") {
      return res
        .status(400)
        .json({ error: "Only pending offers can be cancelled" })
    }

    const updated = await prisma.rideRequestOffer.update({
      where: { id: offer.id },
      data: { status: "cancelled" },
    })

    return res.json(updated)
  } catch (err) {
    console.error("PUT /ride-requests/:id/offers/:offerId/cancel error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
