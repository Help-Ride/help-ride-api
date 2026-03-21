import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import {
  oauthLogin,
  registerWithEmail,
  loginWithEmail,
  sendLoginEmailOtp,
  sendLoginPhoneOtp,
  getMe,
  sendEmailVerifyOtp,
  verifyEmailWithOtp,
  sendPhoneVerifyOtp,
  verifyPhoneWithOtp,
  sendPasswordResetOtpEmail,
  resetPasswordWithOtp,
  sendPasswordResetOtpPhone,
  resetPasswordWithOtpPhone,
  refreshTokens,
  logout,
} from "../controllers/auth.controller.js"

const router = Router()

router.post("/oauth", oauthLogin)

router.post("/register", registerWithEmail)
router.post("/login", loginWithEmail)
router.post("/login-email/send-otp", sendLoginEmailOtp)
router.post("/login-phone/send-otp", sendLoginPhoneOtp)
router.post("/refresh", refreshTokens)
router.post("/logout", logout)

// Email verification (OTP)
router.post("/verify-email/send-otp", sendEmailVerifyOtp)
router.post("/verify-email/verify-otp", verifyEmailWithOtp)
router.post("/verify-phone/send-otp", sendPhoneVerifyOtp)
router.post("/verify-phone/verify-otp", verifyPhoneWithOtp)
router.post("/password-reset/send-otp", sendPasswordResetOtpEmail)
router.post("/password-reset/verify-otp", resetPasswordWithOtp)
router.post("/password-reset/send-otp-phone", sendPasswordResetOtpPhone)
router.post("/password-reset/verify-otp-phone", resetPasswordWithOtpPhone)

router.get("/me", authGuard, getMe)

export default router
