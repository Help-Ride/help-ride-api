import app from "./app.js"
import prisma from "./lib/prisma.js"

app.get("/api/db-check", async (_req, res) => {
  try {
    const result = await prisma.$queryRaw`SELECT 1 as ok`
    res.json({ connected: true, result })
  } catch (err) {
    console.error("DB connection error:", err)
    res.status(500).json({ connected: false, error: String(err) })
  }
})

const PORT = process.env.PORT || 4000
app.listen(PORT, () => console.log(`API server running on port ${PORT}`))
