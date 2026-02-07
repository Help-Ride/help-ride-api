// src/routes/notification.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import {
  listNotifications,
  registerDeviceToken,
  unregisterDeviceToken,
  markAllNotificationsRead,
  markNotificationRead,
} from "../controllers/notification.controller.js"

const router = Router()

router.get("/", authGuard, listNotifications)
router.post("/tokens/register", authGuard, registerDeviceToken)
router.post("/tokens/unregister", authGuard, unregisterDeviceToken)
router.post("/:id/read", authGuard, markNotificationRead)
router.post("/read-all", authGuard, markAllNotificationsRead)

export default router
