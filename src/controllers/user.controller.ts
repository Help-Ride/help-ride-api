// src/controllers/user.controller.ts
import type { Response } from "express"
import bcrypt from "bcryptjs"
import { randomUUID } from "crypto"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"
import { getDownloadUrl, getUploadUrl } from "../lib/s3.js"
import { isValidE164Phone, normalizePhoneNumber } from "../lib/twilio.js"

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

interface PresignUserAvatarBody {
  fileName?: string
  mimeType?: string
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

function buildAvatarProxyUrl(req: AuthRequest, userId: string, s3Key: string) {
  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim()
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim()
  const protocol = forwardedProto || req.protocol
  const host = forwardedHost || req.get("host")
  const encodedKey = encodeURIComponent(s3Key)
  const path = `/api/users/${userId}/avatar?key=${encodedKey}`

  if (!host) {
    return path
  }

  return `${protocol}://${host}${path}`
}

/**
 * POST /api/users/:id/avatar/presign
 * Returns a presigned upload URL and updates providerAvatarUrl.
 */
export async function createUserAvatarPresign(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "id is required" })
    }

    if (id !== req.userId) {
      return res.status(403).json({
        error: "You can only upload a photo for your own profile",
      })
    }

    const { fileName, mimeType } = (req.body ?? {}) as PresignUserAvatarBody

    if (!fileName || !mimeType) {
      return res
        .status(400)
        .json({ error: "fileName and mimeType are required" })
    }

    if (!mimeType.toLowerCase().startsWith("image/")) {
      return res.status(400).json({
        error: "mimeType must be an image/* type",
      })
    }

    const safeFileName = fileName.replace(/[^\w.\-]/g, "_")
    const s3Key = `users/${req.userId}/avatar/${randomUUID()}-${safeFileName}`
    const uploadUrl = await getUploadUrl({
      key: s3Key,
      contentType: mimeType,
    })
    const avatarUrl = buildAvatarProxyUrl(req, req.userId, s3Key)

    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { providerAvatarUrl: avatarUrl },
      select: {
        id: true,
        providerAvatarUrl: true,
      },
    })

    return res.status(201).json({
      uploadUrl,
      avatar: {
        fileName: safeFileName,
        mimeType,
        s3Key,
        url: user.providerAvatarUrl,
      },
    })
  } catch (err) {
    console.error("POST /users/:id/avatar/presign error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/users/:id/avatar?key=...
 * Redirects to a short-lived signed download URL for private S3 objects.
 */
export async function getUserAvatar(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params
    const key = typeof req.query.key === "string" ? req.query.key : ""

    if (!id) {
      return res.status(400).json({ error: "id is required" })
    }
    if (!key) {
      return res.status(400).json({ error: "key is required" })
    }
    if (!key.startsWith(`users/${id}/avatar/`)) {
      return res.status(400).json({ error: "Invalid avatar key" })
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, providerAvatarUrl: true },
    })
    if (!user || !user.providerAvatarUrl) {
      return res.status(404).json({ error: "Avatar not found" })
    }
    if (!user.providerAvatarUrl.includes(encodeURIComponent(key))) {
      return res.status(404).json({ error: "Avatar not found" })
    }

    const downloadUrl = await getDownloadUrl(key)
    return res.redirect(302, downloadUrl)
  } catch (err) {
    console.error("GET /users/:id/avatar error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
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

    const existingUser = await prisma.user.findUnique({
      where: { id },
      select: { phone: true },
    })

    if (!existingUser) {
      return res.status(404).json({ error: "User not found" })
    }

    let normalizedPhone: string | undefined
    if (phone !== undefined) {
      normalizedPhone = normalizePhoneNumber(phone)
      if (!isValidE164Phone(normalizedPhone)) {
        return res.status(400).json({
          error: "phone must be in E.164 format (for example: +14165551234)",
        })
      }
    }

    const phoneChanged =
      normalizedPhone !== undefined && normalizedPhone !== existingUser.phone

    if (phoneChanged && normalizedPhone) {
      const phoneOwner = await prisma.user.findUnique({
        where: { phone: normalizedPhone },
        select: { id: true },
      })

      if (phoneOwner && phoneOwner.id !== id) {
        return res.status(409).json({
          error: "An account with this phone number already exists.",
        })
      }
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(normalizedPhone !== undefined ? { phone: normalizedPhone } : {}),
        ...(phoneChanged
          ? {
              phoneVerified: false,
              phoneVerifyOtp: null,
              phoneVerifyOtpExpiresAt: null,
              phoneVerifyOtpAttempts: 0,
            }
          : {}),
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
        phoneVerified: true,
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
