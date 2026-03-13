// src/controllers/user.controller.ts
import type { Response } from "express"
import bcrypt from "bcryptjs"
import { randomUUID } from "crypto"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"
import { deleteObject, getDownloadUrl, getUploadUrl } from "../lib/s3.js"
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

const TERMINAL_BOOKING_STATUSES = [
  "cancelled_by_passenger",
  "cancelled_by_driver",
  "completed",
] as const
const TERMINAL_RIDE_STATUSES = ["completed", "cancelled"] as const
const TERMINAL_RIDE_REQUEST_STATUSES = [
  "CANCELLED",
  "EXPIRED",
  "cancelled",
  "expired",
] as const
const TERMINAL_RIDE_REQUEST_OFFER_STATUSES = [
  "REJECTED",
  "EXPIRED",
  "rejected",
  "cancelled",
] as const

function buildDeletedEmail(userId: string) {
  return `deleted-${userId}-${Date.now()}@help-ride.invalid`
}

function extractAvatarS3Key(userId: string, rawUrl: string | null | undefined) {
  const value = rawUrl?.trim()
  if (!value) return null

  if (value.startsWith(`users/${userId}/avatar/`)) {
    return value
  }

  try {
    const parsed = new URL(value, "https://help-ride.invalid")
    const key = parsed.searchParams.get("key")?.trim()
    if (!key) return null
    return decodeURIComponent(key)
  } catch {
    return null
  }
}

function getDeletionReasonsMessage(reasons: string[]) {
  const labels = reasons.map((reason) => {
    switch (reason) {
      case "active_booking":
        return "active bookings"
      case "active_ride":
        return "active rides"
      case "active_ride_request":
        return "active ride requests"
      case "active_ride_request_offer":
        return "active ride request offers"
      case "pending_driver_transfer":
        return "pending driver payouts"
      default:
        return reason.replaceAll("_", " ")
    }
  })

  return `Resolve ${labels.join(", ")} before deleting your account.`
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
 * DELETE /api/users/me
 * Authenticated user can permanently delete their own account.
 */
export async function deleteMyAccount(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const userId = req.userId

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        providerAvatarUrl: true,
        stripeAccountId: true,
      },
    })

    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    const [
      activeBookingsCount,
      activeRidesCount,
      activeRideRequestsCount,
      activeRideRequestOffersCount,
      pendingDriverTransfersCount,
      driverDocuments,
    ] = await prisma.$transaction([
      prisma.booking.count({
        where: {
          passengerId: userId,
          status: { notIn: [...TERMINAL_BOOKING_STATUSES] },
        },
      }),
      prisma.ride.count({
        where: {
          driverId: userId,
          status: { notIn: [...TERMINAL_RIDE_STATUSES] },
        },
      }),
      prisma.rideRequest.count({
        where: {
          OR: [
            {
              passengerId: userId,
              status: { notIn: [...TERMINAL_RIDE_REQUEST_STATUSES] },
            },
            {
              driverId: userId,
              status: { notIn: [...TERMINAL_RIDE_REQUEST_STATUSES] },
            },
          ],
        },
      }),
      prisma.rideRequestOffer.count({
        where: {
          driverId: userId,
          status: { notIn: [...TERMINAL_RIDE_REQUEST_OFFER_STATUSES] },
        },
      }),
      prisma.payment.count({
        where: {
          status: "succeeded",
          driverTransferredAt: null,
          booking: {
            ride: {
              driverId: userId,
            },
          },
        },
      }),
      prisma.driverDocument.findMany({
        where: { userId },
        select: { s3Key: true },
      }),
    ])

    const reasons: string[] = []
    if (activeBookingsCount > 0) reasons.push("active_booking")
    if (activeRidesCount > 0) reasons.push("active_ride")
    if (activeRideRequestsCount > 0) reasons.push("active_ride_request")
    if (activeRideRequestOffersCount > 0) {
      reasons.push("active_ride_request_offer")
    }
    if (pendingDriverTransfersCount > 0) {
      reasons.push("pending_driver_transfer")
    }

    if (reasons.length > 0) {
      return res.status(409).json({
        error: getDeletionReasonsMessage(reasons),
        reasons,
      })
    }

    const keysToDelete = new Set<string>()
    const avatarKey = extractAvatarS3Key(userId, user.providerAvatarUrl)
    if (avatarKey) {
      keysToDelete.add(avatarKey)
    }
    for (const document of driverDocuments) {
      const key = document.s3Key.trim()
      if (key) {
        keysToDelete.add(key)
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.refreshToken.deleteMany({
        where: { userId },
      })
      await tx.oAuthAccount.deleteMany({
        where: { userId },
      })
      await tx.deviceToken.deleteMany({
        where: { userId },
      })
      await tx.notification.deleteMany({
        where: { userId },
      })
      await tx.userLocation.deleteMany({
        where: { userId },
      })
      await tx.driverDocument.deleteMany({
        where: { userId },
      })
      await tx.driverProfile.deleteMany({
        where: { userId },
      })
      await tx.user.update({
        where: { id: userId },
        data: {
          deletedAt: new Date(),
          email: buildDeletedEmail(userId),
          name: "Deleted User",
          phone: null,
          passwordHash: null,
          providerAvatarUrl: null,
          emailVerified: false,
          phoneVerified: false,
          stripeAccountId: null,
          emailVerifyOtp: null,
          emailVerifyOtpExpiresAt: null,
          emailVerifyOtpAttempts: 0,
          phoneVerifyOtp: null,
          phoneVerifyOtpExpiresAt: null,
          phoneVerifyOtpAttempts: 0,
          passwordResetOtp: null,
          passwordResetOtpExpiresAt: null,
          passwordResetOtpAttempts: 0,
        },
      })
    })

    await Promise.allSettled(
      [...keysToDelete].map(async (key) => {
        await deleteObject(key)
      })
    )

    return res.status(200).json({ message: "Account deleted successfully." })
  } catch (err) {
    console.error("DELETE /users/me error", err)
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
