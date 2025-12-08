// src/routes/booking.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js"
import {
  createBooking,
  getMyBookings,
  getBookingsForRide,
} from "../controllers/booking.controller.js"

const router = Router()

// Passenger: create booking (must be logged in + verified)
router.post("/:rideId", authGuard, requireVerifiedEmail, createBooking)

// Passenger: my bookings
router.get("/me/list", authGuard, getMyBookings)

// Driver: view bookings for a ride
router.get("/ride/:rideId", authGuard, getBookingsForRide)

export default router
