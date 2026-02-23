// src/routes/user.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import {
  changeUserPassword,
  createUserAvatarPresign,
  getUserById,
  updateMyLocation,
  updateUserProfile,
} from "../controllers/user.controller.js"

const router = Router()

// Public: fetch user profile (safe fields only)
router.get("/:id", getUserById)

// Update own profile
router.put("/:id", authGuard, updateUserProfile)
router.post("/:id/avatar/presign", authGuard, createUserAvatarPresign)

// Change own password
router.put("/me/password", authGuard, changeUserPassword)
router.put("/me/location", authGuard, updateMyLocation)

export default router
