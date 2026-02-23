// src/controllers/user.controller.ts
import type { Response } from "express"
import bcrypt from "bcryptjs"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"

interface UpdateUserBody {
  name?: string
  phone?: string
  providerAvatarUrl?: string
}

interface ChangePasswordBody {
  currentPassword?: string
  newPassword?: string
}

interface UpdateMyLocationBody {
  lat?: number | string
  lng?: number | string
  accuracyMeters?: number | string | null
  recordedAt?: string
}

function parseNumber(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function isValidLatitude(value: number) {
  return Number.isFinite(value) && value >= -90 && value <= 90
}

function isValidLongitude(value: number) {
  return Number.isFinite(value) && value >= -180 && value <= 180
}

/**
 * GET /api/users/:id
 * Public user profile (safe fields only).
 */
export async function getUserById(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "id is required" })
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        providerAvatarUrl: true,
        roleDefault: true,
      },
    })

    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    return res.json(user)
  } catch (err) {
    console.error("GET /users/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
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

/**
 * PUT /api/users/me/password
 * Authenticated user can change **their own** password.
 */
export async function changeUserPassword(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { currentPassword, newPassword } = (req.body ??
      {}) as ChangePasswordBody

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: "currentPassword and newPassword are required",
      })
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        error: "Password must be at least 8 characters long",
      })
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, passwordHash: true },
    })

    if (!user || !user.passwordHash) {
      return res.status(400).json({
        error: "Password change is not available for this account",
      })
    }

    const isValid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!isValid) {
      return res.status(400).json({ error: "Invalid current password" })
    }

    const passwordHash = await bcrypt.hash(newPassword, 10)
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    })

    return res.status(200).json({ message: "Password updated successfully." })
  } catch (err) {
    console.error("PUT /users/:id/password error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * PUT /api/users/me/location
 * Save latest user location (call on app open/login).
 */
export async function updateMyLocation(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const body = (req.body ?? {}) as UpdateMyLocationBody
    const lat = parseNumber(body.lat)
    const lng = parseNumber(body.lng)
    const accuracyMeters =
      body.accuracyMeters === null
        ? null
        : parseNumber(body.accuracyMeters) ?? null

    if (lat == null || lng == null) {
      return res.status(400).json({ error: "lat and lng are required" })
    }

    if (!isValidLatitude(lat) || !isValidLongitude(lng)) {
      return res.status(400).json({
        error: "lat must be between -90 and 90, lng between -180 and 180",
      })
    }

    if (
      accuracyMeters != null &&
      (!Number.isFinite(accuracyMeters) || accuracyMeters < 0)
    ) {
      return res
        .status(400)
        .json({ error: "accuracyMeters must be a non-negative number" })
    }

    let recordedAt = new Date()
    if (body.recordedAt) {
      const parsed = new Date(body.recordedAt)
      if (Number.isNaN(parsed.getTime())) {
        return res
          .status(400)
          .json({ error: "recordedAt must be a valid ISO date" })
      }
      recordedAt = parsed
    }

    const saved = await prisma.userLocation.upsert({
      where: { userId: req.userId },
      create: {
        userId: req.userId,
        lat,
        lng,
        accuracyMeters,
        recordedAt,
      },
      update: {
        lat,
        lng,
        accuracyMeters,
        recordedAt,
      },
      select: {
        userId: true,
        lat: true,
        lng: true,
        accuracyMeters: true,
        recordedAt: true,
        updatedAt: true,
      },
    })

    return res.status(200).json(saved)
  } catch (err) {
    console.error("PUT /users/me/location error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
