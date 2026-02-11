import type { Request, Response, NextFunction } from "express"

export function adminGuard(req: Request, res: Response, next: NextFunction) {
  const adminKey = process.env.ADMIN_API_KEY
  if (!adminKey) {
    return res.status(500).json({ error: "Admin API key not configured" })
  }

  const providedKey = req.header("x-admin-api-key")
  if (!providedKey || providedKey !== adminKey) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  next()
}
