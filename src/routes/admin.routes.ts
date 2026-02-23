import { Router } from "express"
import {
  createSupportTicketAdmin,
  getSupportTicketAdmin,
  getAppConfig,
  listSupportTicketsAdmin,
  resolveSupportTicketAdmin,
  updateAppConfig,
  updateSupportTicketAdmin,
} from "../controllers/admin.controller.js"
import {
  assignRideDriverAdmin,
  bulkCreateRideOffersAdmin,
  bulkCreateRidesAdmin,
  cancelBookingAdmin,
  cancelRideAdmin,
  confirmBookingAdmin,
  createRideAdmin,
  createRideOfferAdmin,
  exportBookingsAdmin,
  exportPaymentsAdmin,
  exportRidesAdmin,
  getBookingDetailsAdmin,
  getDashboardStatsAdmin,
  getDriverDetailsAdmin,
  getDriverDocumentUrlAdmin,
  getPaymentDetailsAdmin,
  getRideDetailsAdmin,
  globalSearchAdmin,
  listBookingsAdmin,
  listDriversAdmin,
  listEligibleDriversForRideAdmin,
  listPaymentsAdmin,
  listRideRequestsAdmin,
  listRidesAdmin,
  markPaymentPaidAdmin,
  refundPaymentAdmin,
  requestAdditionalDriverDocumentAdmin,
  reviewDriverDocumentAdmin,
  updateRideAdmin,
  updateRideRequestStatusAdmin,
  updateRideStatusAdmin,
  verifyDriverAdmin,
} from "../controllers/adminOps.controller.js"
import { adminGuard } from "../middleware/admin.js"

const router = Router()

router.use(adminGuard)

router.get("/drivers", listDriversAdmin)
router.get("/drivers/:driverId", getDriverDetailsAdmin)
router.post("/drivers/:driverId/verify", verifyDriverAdmin)
router.patch("/drivers/:driverId/documents/:docId", reviewDriverDocumentAdmin)
router.post(
  "/drivers/:driverId/documents/request",
  requestAdditionalDriverDocumentAdmin
)
router.get("/drivers/:driverId/documents/:docId/url", getDriverDocumentUrlAdmin)

router.get("/rides/export", exportRidesAdmin)
router.get("/rides", listRidesAdmin)
router.get("/rides/:rideId", getRideDetailsAdmin)
router.post("/rides", createRideAdmin)
router.post("/rides/bulk", bulkCreateRidesAdmin)
router.patch("/rides/:rideId", updateRideAdmin)
router.put("/rides/:rideId/assign", assignRideDriverAdmin)
router.put("/rides/:rideId/cancel", cancelRideAdmin)
router.put("/rides/:rideId/status", updateRideStatusAdmin)
router.get("/rides/:rideId/eligible-drivers", listEligibleDriversForRideAdmin)

router.get("/ride-requests", listRideRequestsAdmin)
router.post("/ride-requests/:requestId/offers", createRideOfferAdmin)
router.post("/ride-requests/:requestId/offers/bulk", bulkCreateRideOffersAdmin)
router.put("/ride-requests/:requestId/status", updateRideRequestStatusAdmin)

router.get("/bookings/export", exportBookingsAdmin)
router.get("/bookings", listBookingsAdmin)
router.get("/bookings/:bookingId", getBookingDetailsAdmin)
router.put("/bookings/:bookingId/confirm", confirmBookingAdmin)
router.put("/bookings/:bookingId/cancel", cancelBookingAdmin)

router.get("/payments/export", exportPaymentsAdmin)
router.get("/payments", listPaymentsAdmin)
router.get("/payments/:paymentId", getPaymentDetailsAdmin)
router.put("/payments/:paymentId/mark-paid", markPaymentPaidAdmin)
router.post("/payments/:paymentId/refund", refundPaymentAdmin)

router.get("/dashboard/stats", getDashboardStatsAdmin)
router.get("/search", globalSearchAdmin)

router.get("/support-tickets", listSupportTicketsAdmin)
router.get("/support-tickets/:id", getSupportTicketAdmin)
router.post("/support-tickets", createSupportTicketAdmin)
router.patch("/support-tickets/:id", updateSupportTicketAdmin)
router.post("/support-tickets/:id/resolve", resolveSupportTicketAdmin)

router.get("/app-config", getAppConfig)
router.patch("/app-config", updateAppConfig)
router.get("/settings", getAppConfig)
router.put("/settings", updateAppConfig)

export default router
