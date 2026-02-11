import { Router } from "express"
import {
  createSupportTicket,
  getSupportTicket,
  listSupportTickets,
} from "../controllers/supportTicket.controller.js"
import { authGuard } from "../middleware/auth.js"

const router = Router()

router.use(authGuard)

router.post("/", createSupportTicket)
router.get("/", listSupportTickets)
router.get("/:id", getSupportTicket)

export default router
