import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import authRoutes from "./routes/auth.routes.js"

dotenv.config()

const app = express()

app.use(cors())
app.use(express.json())

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() })
})

app.use("/api/auth", authRoutes)

export default app
