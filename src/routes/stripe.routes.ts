import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js"
import { createStripeOnboardingLink } from "../controllers/stripe.controller.js"

const router = Router()

router.post(
  "/connect/onboard",
  authGuard,
  requireVerifiedEmail,
  createStripeOnboardingLink
)

export default router
