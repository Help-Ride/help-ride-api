// src/routes/rideRequest.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js"
import {
  createRide,
  updateRide,
  listRideRequests,
  getMyRideRequests,
  getRideRequestById,
  deleteRideRequest,
} from "../controllers/rideRequest.controller.js"

const router = Router()

// Passenger: my requests (auth)
router.get("/me/list", authGuard, getMyRideRequests)

// Public list/search
router.get("/", listRideRequests)

// Public detail
router.get("/:id", getRideRequestById)
// Passenger: update own request
router.put("/:id", authGuard, requireVerifiedEmail, updateRide)

// Passenger: create request (must be verified)
router.post("/", authGuard, requireVerifiedEmail, createRide)

// Passenger: cancel own request
router.delete("/:id", authGuard, requireVerifiedEmail, deleteRideRequest)

export default router
