// src/routes/booking.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js"
import {
  createBooking,
  getMyBookings,
  getBookingsForRide,
  confirmBooking,
  rejectBooking,
} from "../controllers/booking.controller.js"

const router = Router()

// Passenger creates booking (PENDING)
router.post("/:rideId", authGuard, requireVerifiedEmail, createBooking)

// Passenger: list my bookings
router.get("/me/list", authGuard, getMyBookings)

// Driver: list bookings for a ride
router.get("/ride/:rideId", authGuard, getBookingsForRide)

// Driver: confirm / reject booking
router.put("/:id/confirm", authGuard, requireVerifiedEmail, confirmBooking)
router.put("/:id/reject", authGuard, requireVerifiedEmail, rejectBooking)

export default router
