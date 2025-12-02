// src/routes/index.ts
import type { Express } from "express"
import authRoutes from "./auth.routes.js"

export function registerRoutes(app: Express) {
  app.use("/api/auth", authRoutes)

  // later:
  // app.use("/api/rides", ridesRoutes);
  // app.use("/api/bookings", bookingRoutes);
}
