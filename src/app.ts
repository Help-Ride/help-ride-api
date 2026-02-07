import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import prisma from "./lib/prisma.js"
import { registerRoutes } from "./routes/index.js"
import webhookRoutes from "./routes/webhook.routes.js"

dotenv.config()

const app = express()

app.use(cors())
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint()

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
    const payload = {
      method: req.method,
      path: req.originalUrl || req.url,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
    }

    if (res.statusCode >= 500) {
      console.error("[http] request", JSON.stringify(payload))
      return
    }
    if (res.statusCode >= 400) {
      console.warn("[http] request", JSON.stringify(payload))
      return
    }
    console.info("[http] request", JSON.stringify(payload))
  })

  next()
})
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
