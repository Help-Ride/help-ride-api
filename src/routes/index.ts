// src/routes/index.ts
import type { Express, Router } from "express"
import authRoutes from "./auth.routes.js"
import rideRoutes from "./ride.routes.js"
import bookingRoutes from "./booking.routes.js"
import driverRoutes from "./driver.routes.js"
import rideRequestRoutes from "./rideRequest.routes.js"
import userRoutes from "./user.routes.js"
import chatRoutes from "./chat.routes.js"
import fixedRoutePriceRoutes from "./fixedRoutePrice.routes.js"
import notificationRoutes from "./notification.routes.js"
import stripeRoutes from "./stripe.routes.js"
import paymentRoutes from "./payment.routes.js"
import supportTicketRoutes from "./supportTicket.routes.js"
import adminRoutes from "./admin.routes.js"

export const API_ROUTE_MOUNTS: Array<{ path: string; router: Router }> = [
  { path: "/auth", router: authRoutes },
  { path: "/rides", router: rideRoutes },
  { path: "/bookings", router: bookingRoutes },
  { path: "/drivers", router: driverRoutes },
  { path: "/ride-requests", router: rideRequestRoutes },
  { path: "/fixed-route-prices", router: fixedRoutePriceRoutes },
  { path: "/users", router: userRoutes },
  { path: "/chat", router: chatRoutes },
  { path: "/notifications", router: notificationRoutes },
  { path: "/stripe", router: stripeRoutes },
  { path: "/payments", router: paymentRoutes },
  { path: "/support-tickets", router: supportTicketRoutes },
  { path: "/admin", router: adminRoutes },
]

export function registerRoutes(app: Express) {
  for (const mount of API_ROUTE_MOUNTS) {
    app.use(`/api${mount.path}`, mount.router)
  }
}
