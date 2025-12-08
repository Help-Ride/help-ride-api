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

// Create driver profile (verified user only)
router.post("/", authGuard, requireVerifiedEmail, createDriverProfile)

// Public view by userId
router.get("/:id", getDriverProfile)

// Update own driver profile
router.put("/:id", authGuard, requireVerifiedEmail, updateDriverProfile)

export default router
