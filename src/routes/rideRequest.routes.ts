// src/routes/rideRequest.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js"
import {
  createRideRequest,
  listRideRequests,
  getMyRideRequests,
  getRideRequestById,
  deleteRideRequest,
} from "../controllers/rideRequest.controller.js"

const router = Router()

// Public list/search
router.get("/", listRideRequests)

// Passenger: my requests (auth) - must come before /:id
router.get("/me/list", authGuard, getMyRideRequests)

// Public detail
router.get("/:id", getRideRequestById)

// Passenger: create request (must be verified)
router.post("/", authGuard, requireVerifiedEmail, createRideRequest)

// Passenger: cancel own request
router.delete("/:id", authGuard, requireVerifiedEmail, deleteRideRequest)

export default router
