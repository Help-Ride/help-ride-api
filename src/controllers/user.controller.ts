// src/controllers/user.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"

interface UpdateUserBody {
  name?: string
  phone?: string
  providerAvatarUrl?: string
}

/**
 * PUT /api/users/:id
 * Authenticated user can update **their own** profile.
 */
export async function updateUserProfile(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "id is required" })
    }

    // You can only update yourself
    if (id !== req.userId) {
      return res.status(403).json({
        error: "You can only update your own profile",
      })
    }

    const { name, phone, providerAvatarUrl } = (req.body ??
      {}) as UpdateUserBody

    if (!name && !phone && !providerAvatarUrl) {
      return res.status(400).json({
        error:
          "At least one field (name, phone, providerAvatarUrl) is required",
      })
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(phone !== undefined ? { phone } : {}),
        ...(providerAvatarUrl !== undefined ? { providerAvatarUrl } : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        roleDefault: true,
        providerAvatarUrl: true,
        emailVerified: true,
        createdAt: true,
      },
    })

    return res.json(updated)
  } catch (err) {
    console.error("PUT /users/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
