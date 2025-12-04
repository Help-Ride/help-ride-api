// src/routes/booking.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import {
  createBooking,
  getMyBookings,
  getBookingsForRide,
} from "../controllers/booking.controller.js"

const router = Router()

// Passenger books a ride
// POST /api/bookings/:rideId
router.post("/:rideId", authGuard, createBooking)

// Passenger's own bookings
// GET /api/bookings/me
router.get("/me/list", authGuard, getMyBookings)

// Driver view bookings for a specific ride
// GET /api/bookings/ride/:rideId
router.get("/ride/:rideId", authGuard, getBookingsForRide)

export default router
