import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import {
  oauthLogin,
  registerWithEmail,
  loginWithEmail,
  getMe,
  sendEmailVerifyOtp,
  verifyEmailWithOtp,
} from "../controllers/auth.controller.js"

const router = Router()

router.post("/oauth", oauthLogin)

router.post("/register", registerWithEmail)
router.post("/login", loginWithEmail)

// Email verification (OTP)
router.post("/verify-email/send-otp", sendEmailVerifyOtp)
router.post("/verify-email/verify-otp", verifyEmailWithOtp)

router.get("/me", authGuard, getMe)

export default router
