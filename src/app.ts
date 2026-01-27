import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import prisma from "./lib/prisma.js"
import { registerRoutes } from "./routes/index.js"
import webhookRoutes from "./routes/webhook.routes.js"

dotenv.config()

const app = express()

app.use(cors())
app.use("/api/webhooks", webhookRoutes)
app.use(express.json())

app.get("/api/health", (_req, res) => {
  res.json({ status: "oksss", ts: new Date().toISOString() })
})

app.get("/api/db-check", async (_req, res) => {
  try {
    const result = await prisma.$queryRaw`SELECT 1 as ok`
    res.json({ connected: true, result })
  } catch (err) {
    console.error("DB connection error:", err)
    res.status(500).json({ connected: false, error: String(err) })
  }
})

registerRoutes(app)

export default app
