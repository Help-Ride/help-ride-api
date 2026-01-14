// src/routes/index.ts
import type { Express } from "express"
import authRoutes from "./auth.routes.js"
import rideRoutes from "./ride.routes.js"
import bookingRoutes from "./booking.routes.js"
import driverRoutes from "./driver.routes.js"
import rideRequestRoutes from "./rideRequest.routes.js"
import userRoutes from "./user.routes.js"
import chatRoutes from "./chat.routes.js"

export function registerRoutes(app: Express) {
  app.use("/api/auth", authRoutes)
  app.use("/api/rides", rideRoutes)
  app.use("/api/bookings", bookingRoutes)
  app.use("/api/drivers", driverRoutes)
  app.use("/api/ride-requests", rideRequestRoutes)
  app.use("/api/users", userRoutes)
  app.use("/api/chat", chatRoutes)
}
