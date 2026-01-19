// src/routes/fixedRoutePrice.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js"
import {
  createFixedRoutePrice,
  deleteFixedRoutePrice,
  listFixedRoutePrices,
  updateFixedRoutePrice,
} from "../controllers/fixedRoutePrice.controller.js"

const router = Router()

router.get("/", authGuard, listFixedRoutePrices)
router.post("/", authGuard, requireVerifiedEmail, createFixedRoutePrice)
router.put("/:id", authGuard, requireVerifiedEmail, updateFixedRoutePrice)
router.delete("/:id", authGuard, requireVerifiedEmail, deleteFixedRoutePrice)

export default router
