import { Router } from "express"
import {
  getAppConfig,
  listSupportTicketsAdmin,
  updateAppConfig,
  updateSupportTicketAdmin,
} from "../controllers/admin.controller.js"
import { adminGuard } from "../middleware/admin.js"

const router = Router()

router.use(adminGuard)

router.get("/support-tickets", listSupportTicketsAdmin)
router.patch("/support-tickets/:id", updateSupportTicketAdmin)
router.get("/app-config", getAppConfig)
router.patch("/app-config", updateAppConfig)

export default router
