// src/routes/ride.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import {
  createRide,
  searchRides,
  getMyRides,
  getRideById,
  updateRide,
  deleteRide,
} from "../controllers/ride.controller.js"

const router = Router()

// Public search (no auth required)
router.get("/", searchRides)

// Authenticated driver actions
router.get("/me/list", authGuard, getMyRides)

// Ride detail (no auth required for now)
router.get("/:id", getRideById)
router.post("/", authGuard, createRide)
router.put("/:id", authGuard, updateRide)
router.delete("/:id", authGuard, deleteRide)
export default router
