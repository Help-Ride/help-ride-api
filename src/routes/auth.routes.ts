// src/routes/auth.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import { oauthLogin, getMe } from "../controllers/auth.controller.js"

const router = Router()

// POST /api/auth/oauth
router.post("/oauth", oauthLogin)

// GET /api/auth/me
router.get("/me", authGuard, getMe)

export default router
