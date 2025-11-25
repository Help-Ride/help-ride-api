import express from "express"
import cors from "cors"
import dotenv from "dotenv"

dotenv.config()

const app = express()

app.use(cors())
app.use(express.json())

app.get("/", (_req, res) => {
  res.send("Hello Express!")
})

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() })
})

export default app
