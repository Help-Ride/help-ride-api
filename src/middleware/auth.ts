// src/middleware/auth.ts
import type { Request, Response, NextFunction } from "express"
import { verifyAccessToken } from "../lib/jwt.js"

export interface AuthRequest extends Request {
  userId?: string
  userRole?: "passenger" | "driver"
}

export function authGuard(req: AuthRequest, res: Response, next: NextFunction) {
  // Private API responses should not be cached by clients or intermediaries.
  res.setHeader("Cache-Control", "no-store")
  res.setHeader("Pragma", "no-cache")
  res.setHeader("Vary", "Authorization")

  const header = req.headers.authorization
  if (!header?.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ error: "Missing or invalid Authorization header" })
  }

  const token = header.slice("Bearer ".length).trim()

  try {
    const payload = verifyAccessToken(token)
    req.userId = payload.sub
    req.userRole = payload.roleDefault
    next()
  } catch (err) {
    console.error("Token verification failed:", err)
    return res.status(401).json({ error: "Invalid or expired token" })
  }
}
