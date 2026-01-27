import express, { Router } from "express"
import { handleStripeWebhook } from "../controllers/stripe.controller.js"

const router = Router()

router.post("/stripe", express.raw({ type: "application/json" }), handleStripeWebhook)

export default router
