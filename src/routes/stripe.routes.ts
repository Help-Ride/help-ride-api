import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js"
import {
  createStripeDashboardLink,
  createStripeOnboardingLink,
  getStripeConnectStatus,
  handleStripeConnectReturn,
  resetStripeConnectAccount,
  refreshStripeConnectOnboarding,
} from "../controllers/stripe.controller.js"

const router = Router()

router.get("/connect/refresh", refreshStripeConnectOnboarding)
router.get("/connect/return", handleStripeConnectReturn)

router.post(
  "/connect/reset",
  authGuard,
  requireVerifiedEmail,
  resetStripeConnectAccount
)
router.post(
  "/connect/onboard",
  authGuard,
  requireVerifiedEmail,
  createStripeOnboardingLink
)
router.get(
  "/connect/status",
  authGuard,
  requireVerifiedEmail,
  getStripeConnectStatus
)
router.post(
  "/connect/dashboard-link",
  authGuard,
  requireVerifiedEmail,
  createStripeDashboardLink
)

export default router
