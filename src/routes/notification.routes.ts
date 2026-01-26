// src/routes/notification.routes.ts
import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../controllers/notification.controller.js"

const router = Router()

router.get("/", authGuard, listNotifications)
router.post("/:id/read", authGuard, markNotificationRead)
router.post("/read-all", authGuard, markAllNotificationsRead)

export default router
