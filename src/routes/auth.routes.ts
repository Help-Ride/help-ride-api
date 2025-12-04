// src/routes/auth.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import {
  oauthLogin,
  registerWithEmail,
  loginWithEmail,
  getMe,
} from "../controllers/auth.controller.js"

const router = Router()

// POST /api/auth/oauth
router.post("/oauth", oauthLogin)

// Email/password
router.post("/register", registerWithEmail)
router.post("/login", loginWithEmail)

// Me
router.get("/me", authGuard, getMe)

export default router
