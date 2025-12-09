// src/routes/user.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import { updateUserProfile } from "../controllers/user.controller.js"

const router = Router()

// Update own profile
router.put("/:id", authGuard, updateUserProfile)

export default router
