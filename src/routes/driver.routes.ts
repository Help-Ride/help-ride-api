// src/routes/driver.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js"
import {
  createDriverProfile,
  getDriverProfile,
  getDriverEarnings,
  getDriverSummary,
  updateDriverProfile,
} from "../controllers/driver.controller.js"
import {
  createDriverDocumentPresign,
  listDriverDocuments,
} from "../controllers/driverDocument.controller.js"

const router = Router()

// Create driver profile (verified user only)
router.post("/", authGuard, requireVerifiedEmail, createDriverProfile)

// Authenticated driver dashboard endpoints
router.get("/me/summary", authGuard, getDriverSummary)
router.get("/me/earnings", authGuard, getDriverEarnings)

// Public view by userId
router.get("/:id", getDriverProfile)

// Update own driver profile
router.put("/:id", authGuard, requireVerifiedEmail, updateDriverProfile)

// Driver documents (S3)
router.post("/:id/documents/presign", authGuard, createDriverDocumentPresign)
router.get("/:id/documents", authGuard, listDriverDocuments)

export default router
