import { Router } from "express"
import { authGuard } from "../middleware/auth.js"
import {
  createConversation,
  listConversations,
  listMessages,
  sendMessage,
  pusherAuth,
} from "../controllers/chat.controller.js"

const router = Router()

router.post("/conversations", authGuard, createConversation)
router.get("/conversations", authGuard, listConversations)
router.get("/conversations/:id/messages", authGuard, listMessages)
router.post("/conversations/:id/messages", authGuard, sendMessage)
router.post("/pusher/auth", authGuard, pusherAuth)

export default router
