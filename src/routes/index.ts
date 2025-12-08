// src/routes/index.ts
import type { Express } from "express"
import authRoutes from "./auth.routes.js"
import rideRoutes from "./ride.routes.js"
import bookingRoutes from "./booking.routes.js"
import driverRoutes from "./driver.routes.js"
import rideRequestRoutes from "./rideRequest.routes.js"

export function registerRoutes(app: Express) {
  app.use("/api/auth", authRoutes)
  app.use("/api/rides", rideRoutes)
  app.use("/api/bookings", bookingRoutes)
  app.use("/api/drivers", driverRoutes)
  app.use("/api/ride-requests", rideRequestRoutes)
}
