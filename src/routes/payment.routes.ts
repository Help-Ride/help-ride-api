import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js"
import {
  createPaymentIntent,
  getPaymentIntentById,
} from "../controllers/payment.controller.js"

const router = Router()

router.post("/intent", authGuard, requireVerifiedEmail, createPaymentIntent)
router.get("/intent/:id", authGuard, requireVerifiedEmail, getPaymentIntentById)

export default router
