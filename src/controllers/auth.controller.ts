// src/controllers/auth.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { signAccessToken, signRefreshToken } from "../lib/jwt.js"
import { AuthRequest } from "../middleware/auth.js"

// Types for the OAuth body
interface OAuthBody {
  provider: "google" | "apple"
  providerUserId: string
  email: string
  name: string
  avatarUrl?: string
}

/**
 * POST /api/auth/oauth
 */
export async function oauthLogin(req: AuthRequest, res: Response) {
  try {
    const { provider, providerUserId, email, name, avatarUrl } = (req.body ??
      {}) as Partial<OAuthBody>

    if (!provider || !providerUserId || !email || !name) {
      return res.status(400).json({
        error: "provider, providerUserId, email, and name are required",
      })
    }

    if (!["google", "apple"].includes(provider)) {
      return res.status(400).json({ error: "Invalid provider" })
    }

    // Upsert user
    const user = await prisma.user.upsert({
      where: { email },
      update: {
        name,
        providerAvatarUrl: avatarUrl ?? undefined,
      },
      create: {
        email,
        name,
        providerAvatarUrl: avatarUrl ?? undefined,
        roleDefault: "passenger",
      },
    })

    // Upsert OAuth account
    await prisma.oAuthAccount.upsert({
      where: {
        provider_providerUserId: {
          provider,
          providerUserId,
        },
      },
      update: {
        providerEmail: email,
      },
      create: {
        provider,
        providerUserId,
        providerEmail: email,
        userId: user.id,
      },
    })

    const payload = {
      sub: user.id,
      roleDefault: user.roleDefault,
    }

    const accessToken = signAccessToken(payload)
    const refreshToken = signRefreshToken(payload)

    return res.status(200).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        roleDefault: user.roleDefault,
        providerAvatarUrl: user.providerAvatarUrl,
      },
      tokens: {
        accessToken,
        refreshToken,
      },
    })
  } catch (err) {
    console.error("POST /auth/oauth error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/auth/me
 */
export async function getMe(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: {
        driverProfile: true,
      },
    })

    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    return res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      roleDefault: user.roleDefault,
      providerAvatarUrl: user.providerAvatarUrl,
      driverProfile: user.driverProfile,
    })
  } catch (err) {
    console.error("GET /auth/me error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
