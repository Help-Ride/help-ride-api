import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import {
  oauthLogin,
  registerWithEmail,
  loginWithEmail,
  getMe,
  sendEmailVerifyOtp,
  verifyEmailWithOtp,
  sendPasswordResetOtpEmail,
  resetPasswordWithOtp,
  refreshTokens,
  logout,
} from "../controllers/auth.controller.js"

const router = Router()

router.post("/oauth", oauthLogin)

router.post("/register", registerWithEmail)
router.post("/login", loginWithEmail)
router.post("/refresh", refreshTokens)
router.post("/logout", logout)

// Email verification (OTP)
router.post("/verify-email/send-otp", sendEmailVerifyOtp)
router.post("/verify-email/verify-otp", verifyEmailWithOtp)
router.post("/password-reset/send-otp", sendPasswordResetOtpEmail)
router.post("/password-reset/verify-otp", resetPasswordWithOtp)

router.get("/me", authGuard, getMe)

export default router
