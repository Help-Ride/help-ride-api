// src/middleware/requireVerifiedEmail.ts
import type { Response, NextFunction } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "./auth.js"

export async function requireVerifiedEmail(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    if (!req.userId) {
      return res.status(401).json({
        error: "Unauthorized",
        code: "AUTH_REQUIRED",
        message: "Please log in to perform this action.",
      })
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, emailVerified: true },
    })

    if (!user) {
      return res.status(401).json({
        error: "Unauthorized",
        code: "USER_NOT_FOUND",
      })
    }

    if (!user.emailVerified) {
      return res.status(403).json({
        error: "Email verification required",
        code: "EMAIL_NOT_VERIFIED",
        message: "Please verify your email before posting or booking rides.",
      })
    }

    return next()
  } catch (err) {
    console.error("requireVerifiedEmail error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
