// src/routes/index.ts
import type { Express } from "express"
import authRoutes from "./auth.routes.js"
import rideRoutes from "./ride.routes.js"

export function registerRoutes(app: Express) {
  app.use("/api/auth", authRoutes)
  app.use("/api/rides", rideRoutes)
}
