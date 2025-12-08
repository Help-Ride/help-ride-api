// src/routes/driver.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js"
import {
  createDriverProfile,
  getDriverProfile,
  updateDriverProfile,
} from "../controllers/driver.controller.js"

const router = Router()

// Create driver profile for current user
router.post("/", authGuard, requireVerifiedEmail, createDriverProfile)

// Public: get driver profile by userId
router.get("/:id", getDriverProfile)

// Update driver profile (only owner)
router.put("/:id", authGuard, requireVerifiedEmail, updateDriverProfile)

export default router
