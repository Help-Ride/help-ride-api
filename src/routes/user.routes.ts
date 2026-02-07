// src/routes/user.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import { getUserById, updateUserProfile } from "../controllers/user.controller.js"

const router = Router()

// Public: fetch user profile (safe fields only)
router.get("/:id", getUserById)

// Update own profile
router.put("/:id", authGuard, updateUserProfile)

export default router
