// src/middleware/auth.ts
import type { Request, Response, NextFunction } from "express"
import { verifyAccessToken } from "../lib/jwt.js"
import prisma from "../lib/prisma.js"

export interface AuthRequest extends Request {
  userId?: string
  userRole?: "passenger" | "driver"
}

export async function authGuard(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
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
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        roleDefault: true,
        deletedAt: true,
      },
    })

    if (!user || user.deletedAt) {
      return res.status(401).json({ error: "Invalid or expired token" })
    }

    req.userId = user.id
    req.userRole = user.roleDefault
    next()
  } catch (err) {
    console.error("Token verification failed:", err)
    return res.status(401).json({ error: "Invalid or expired token" })
  }
}
