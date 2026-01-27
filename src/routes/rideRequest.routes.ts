// src/routes/rideRequest.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js"
import { rateLimit } from "../middleware/rateLimit.js"
import {
  createRide,
  updateRide,
  listRideRequests,
  getMyRideRequests,
  getRideRequestById,
  deleteRideRequest,
} from "../controllers/rideRequest.controller.js"
import {
  acceptRideRequestOffer,
  cancelRideRequestOffer,
  createRideRequestOffer,
  listMyRideRequestOffers,
  listRideRequestOffers,
  rejectRideRequestOffer,
} from "../controllers/rideRequestOffer.controller.js"

const router = Router()

// Passenger: my requests (auth)
router.get("/me/list", authGuard, getMyRideRequests)
// Driver: my offers (auth)
router.get("/offers/me/list", authGuard, listMyRideRequestOffers)

// Public list/search
router.get("/", rateLimit({ windowMs: 60_000, max: 60 }), listRideRequests)

// Public detail
router.get("/:id", getRideRequestById)
// Passenger: update own request
router.put("/:id", authGuard, requireVerifiedEmail, updateRide)

// Passenger: create request (must be verified)
router.post("/", authGuard, requireVerifiedEmail, createRide)

// Driver: create offer for a request
router.post("/:id/offers", authGuard, requireVerifiedEmail, createRideRequestOffer)
// Passenger: list offers for a request (driver sees own offers)
router.get("/:id/offers", authGuard, listRideRequestOffers)
// Passenger: accept or reject offer
router.put(
  "/:id/offers/:offerId/accept",
  authGuard,
  requireVerifiedEmail,
  acceptRideRequestOffer
)
router.put(
  "/:id/offers/:offerId/reject",
  authGuard,
  requireVerifiedEmail,
  rejectRideRequestOffer
)
// Driver: cancel offer
router.put(
  "/:id/offers/:offerId/cancel",
  authGuard,
  requireVerifiedEmail,
  cancelRideRequestOffer
)

// Passenger: cancel own request
router.delete("/:id", authGuard, requireVerifiedEmail, deleteRideRequest)

export default router
