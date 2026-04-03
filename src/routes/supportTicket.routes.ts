import { Router } from "express"
import {
  createSupportTicket,
  createSupportTicketAttachmentPresign,
  getSupportTicket,
  listSupportTickets,
} from "../controllers/supportTicket.controller.js"
import { authGuard } from "../middleware/auth.js"

const router = Router()

router.use(authGuard)

router.post("/attachments/presign", createSupportTicketAttachmentPresign)
router.post("/", createSupportTicket)
router.get("/", listSupportTickets)
router.get("/:id", getSupportTicket)

export default router
