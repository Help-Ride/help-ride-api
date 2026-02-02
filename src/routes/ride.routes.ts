// src/routes/ride.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js"
import {
  createRide,
  searchRides,
  getMyRides,
  getRideById,
  updateRide,
  deleteRide,
  startRide,
  completeRide,
  cancelRide,
} from "../controllers/ride.controller.js"

const router = Router()

// Public search
router.get("/", searchRides)
router.get("/:id", getRideById)

// Driver-only, verified email
router.get("/me/list", authGuard, getMyRides)

router.post("/", authGuard, requireVerifiedEmail, createRide)
router.put("/:id", authGuard, requireVerifiedEmail, updateRide)
router.delete("/:id", authGuard, requireVerifiedEmail, deleteRide)
router.post("/:id/start", authGuard, requireVerifiedEmail, startRide)
router.put("/:id/start", authGuard, requireVerifiedEmail, startRide)
router.post("/:id/complete", authGuard, requireVerifiedEmail, completeRide)
router.put("/:id/complete", authGuard, requireVerifiedEmail, completeRide)
router.post("/:id/cancel", authGuard, requireVerifiedEmail, cancelRide)
router.put("/:id/cancel", authGuard, requireVerifiedEmail, cancelRide)

export default router
