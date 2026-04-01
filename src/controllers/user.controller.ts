// src/controllers/user.controller.ts
import type { Response } from "express"
import bcrypt from "bcryptjs"
import { randomUUID } from "crypto"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"
import { notifyUser, notifyUsersByIds } from "../lib/notifications.js"
import { dispatchRideRequestCancel } from "../lib/realtime.js"
import {
  initiateBookingRefundIfPaid,
  initiateRideRequestRefund,
} from "../lib/refunds.js"
import { deleteObject, getDownloadUrl, getUploadUrl } from "../lib/s3.js"
import { isValidE164Phone, normalizePhoneNumber } from "../lib/twilio.js"

interface UpdateUserBody {
  name?: string
  email?: string
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

const ACTIVE_BOOKING_STATUSES = [
  "pending",
  "confirmed",
  "ACCEPTED",
  "PAYMENT_PENDING",
  "CONFIRMED",
] as const
const SEAT_RESTORE_BOOKING_STATUSES = [
  "confirmed",
  "ACCEPTED",
  "PAYMENT_PENDING",
  "CONFIRMED",
] as const
const ACTIVE_RIDE_STATUSES = ["open", "ongoing"] as const
const TERMINAL_RIDE_REQUEST_STATUSES = [
  "CANCELLED",
  "EXPIRED",
  "cancelled",
  "expired",
] as const
const ACTIVE_RIDE_REQUEST_OFFER_STATUSES = [
  "SENT",
  "pending",
  "ACCEPTED",
] as const
const SEAT_RESTORE_BOOKING_STATUS_SET = new Set<string>(
  SEAT_RESTORE_BOOKING_STATUSES
)

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

function uniqueIds(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values.filter((value): value is string => typeof value === "string" && value.length > 0)
    )
  )
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

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeEmail(value: string) {
  return value.trim().toLowerCase()
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

    const { name, email, phone, providerAvatarUrl } = (req.body ??
      {}) as UpdateUserBody

    if (!name && !email && !phone && !providerAvatarUrl) {
      return res.status(400).json({
        error:
          "At least one field (name, email, phone, providerAvatarUrl) is required",
      })
    }

    const existingUser = await prisma.user.findUnique({
      where: { id },
      select: {
        email: true,
        phone: true,
        pendingEmail: true,
        pendingPhone: true,
      },
    })

    if (!existingUser) {
      return res.status(404).json({ error: "User not found" })
    }

    let normalizedEmail: string | undefined
    if (email !== undefined) {
      normalizedEmail = normalizeEmail(email)
      if (!EMAIL_REGEX.test(normalizedEmail)) {
        return res.status(400).json({
          error: "email must be a valid email address",
        })
      }
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

    const emailChanged =
      normalizedEmail !== undefined && normalizedEmail !== existingUser.email

    if (emailChanged && normalizedEmail) {
      const emailOwner = await prisma.user.findFirst({
        where: {
          OR: [{ email: normalizedEmail }, { pendingEmail: normalizedEmail }],
          NOT: { id },
        },
        select: { id: true },
      })

      if (emailOwner && emailOwner.id !== id) {
        return res.status(409).json({
          error: "An account with this email already exists.",
        })
      }
    }

    const phoneChanged =
      normalizedPhone !== undefined && normalizedPhone !== existingUser.phone

    if (phoneChanged && normalizedPhone) {
      const phoneOwner = await prisma.user.findFirst({
        where: {
          OR: [{ phone: normalizedPhone }, { pendingPhone: normalizedPhone }],
          NOT: { id },
        },
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
        ...(emailChanged
          ? {
              pendingEmail: normalizedEmail,
              emailVerifyOtp: null,
              emailVerifyOtpExpiresAt: null,
              emailVerifyOtpAttempts: 0,
            }
          : {}),
        ...(phoneChanged
          ? {
              pendingPhone: normalizedPhone,
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
        pendingEmail: true,
        pendingPhone: true,
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
      passengerBookings,
      driverRides,
      passengerRideRequests,
      driverAssignedRideRequests,
      driverRideRequestOffers,
      pendingDriverTransfersCount,
      driverDocuments,
    ] = await prisma.$transaction([
      prisma.booking.findMany({
        where: {
          passengerId: userId,
          status: { in: [...ACTIVE_BOOKING_STATUSES] },
        },
        select: {
          id: true,
          rideId: true,
          seatsBooked: true,
          status: true,
          paymentStatus: true,
          stripePaymentIntentId: true,
          ride: {
            select: {
              id: true,
              driverId: true,
              fromCity: true,
              toCity: true,
              seatsAvailable: true,
              seatsTotal: true,
            },
          },
        },
      }),
      prisma.ride.findMany({
        where: {
          driverId: userId,
          status: { in: [...ACTIVE_RIDE_STATUSES] },
        },
        select: {
          id: true,
          fromCity: true,
          toCity: true,
          bookings: {
            where: {
              status: { in: [...ACTIVE_BOOKING_STATUSES] },
            },
            select: {
              id: true,
              passengerId: true,
              status: true,
              paymentStatus: true,
              stripePaymentIntentId: true,
            },
          },
        },
      }),
      prisma.rideRequest.findMany({
        where: {
          passengerId: userId,
          status: { notIn: [...TERMINAL_RIDE_REQUEST_STATUSES] },
        },
        select: {
          id: true,
          mode: true,
          status: true,
          jitPaymentIntentId: true,
          fromCity: true,
          toCity: true,
          driverId: true,
          offers: {
            where: {
              status: { in: [...ACTIVE_RIDE_REQUEST_OFFER_STATUSES] },
            },
            select: {
              driverId: true,
            },
          },
        },
      }),
      prisma.rideRequest.findMany({
        where: {
          driverId: userId,
          status: { notIn: [...TERMINAL_RIDE_REQUEST_STATUSES] },
        },
        select: {
          id: true,
          passengerId: true,
          fromCity: true,
          toCity: true,
        },
      }),
      prisma.rideRequestOffer.findMany({
        where: {
          driverId: userId,
          status: { in: [...ACTIVE_RIDE_REQUEST_OFFER_STATUSES] },
        },
        select: {
          id: true,
          rideRequestId: true,
          ride: {
            select: {
              fromCity: true,
              toCity: true,
            },
          },
          rideRequest: {
            select: {
              passengerId: true,
              fromCity: true,
              toCity: true,
            },
          },
        },
      }),
      prisma.payment.count({
        where: {
          status: { in: ["paid", "succeeded"] },
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

    try {
      await Promise.all(
        passengerBookings.map((booking) =>
          initiateBookingRefundIfPaid({
            bookingId: booking.id,
            paymentStatus: booking.paymentStatus,
            stripePaymentIntentId: booking.stripePaymentIntentId,
            source: "passenger_cancel_booking",
          })
        )
      )
    } catch (refundErr) {
      console.error("Refund initiation failed for account deletion bookings", {
        userId,
        err: refundErr,
      })
      return res.status(502).json({
        error: "Unable to initiate booking refunds for account deletion. Please retry.",
      })
    }

    try {
      await Promise.all(
        driverRides.flatMap((ride) =>
          ride.bookings.map((booking) =>
            initiateBookingRefundIfPaid({
              bookingId: booking.id,
              paymentStatus: booking.paymentStatus,
              stripePaymentIntentId: booking.stripePaymentIntentId,
              source: "driver_cancel_ride",
            })
          )
        )
      )
    } catch (refundErr) {
      console.error("Refund initiation failed for account deletion rides", {
        userId,
        err: refundErr,
      })
      return res.status(502).json({
        error: "Unable to initiate ride refunds for account deletion. Please retry.",
      })
    }

    try {
      await Promise.all(
        passengerRideRequests
          .filter((request) => request.mode === "JIT")
          .map((request) =>
            initiateRideRequestRefund({
              rideRequestId: request.id,
              stripePaymentIntentId: request.jitPaymentIntentId,
              source: "passenger_cancel_ride_request",
            })
          )
      )
    } catch (refundErr) {
      console.error(
        "Refund initiation failed for account deletion ride requests",
        {
          userId,
          err: refundErr,
        }
      )
      return res.status(502).json({
        error:
          "Unable to initiate ride request refunds for account deletion. Please retry.",
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

    const passengerBookingIds = passengerBookings.map((booking) => booking.id)
    const driverRideIds = driverRides.map((ride) => ride.id)
    const driverRideBookings = driverRides.flatMap((ride) => ride.bookings)
    const driverRideBookingIds = driverRideBookings.map((booking) => booking.id)
    const passengerRideRequestIds = passengerRideRequests.map((request) => request.id)
    const driverAssignedRideRequestIds = driverAssignedRideRequests.map(
      (request) => request.id
    )
    const rideRequestIdsToCancel = uniqueIds([
      ...passengerRideRequestIds,
      ...driverAssignedRideRequestIds,
    ])
    const preserveStripeConnectAccount = pendingDriverTransfersCount > 0
    const seatRestoresByRideId = new Map<
      string,
      {
        rideId: string
        seatsAvailable: number
        seatsTotal: number
        seatsToRestore: number
      }
    >()

    for (const booking of passengerBookings) {
      if (!SEAT_RESTORE_BOOKING_STATUS_SET.has(booking.status)) {
        continue
      }

      const existingRestore = seatRestoresByRideId.get(booking.rideId)
      if (existingRestore) {
        existingRestore.seatsToRestore += booking.seatsBooked
        continue
      }

      seatRestoresByRideId.set(booking.rideId, {
        rideId: booking.rideId,
        seatsAvailable: booking.ride.seatsAvailable,
        seatsTotal: booking.ride.seatsTotal,
        seatsToRestore: booking.seatsBooked,
      })
    }

    await prisma.$transaction(async (tx) => {
      if (passengerBookingIds.length > 0) {
        await tx.booking.updateMany({
          where: {
            id: { in: passengerBookingIds },
            status: { in: [...ACTIVE_BOOKING_STATUSES] },
          },
          data: { status: "cancelled_by_passenger" },
        })
      }

      for (const restore of seatRestoresByRideId.values()) {
        await tx.ride.update({
          where: { id: restore.rideId },
          data: {
            seatsAvailable: Math.min(
              restore.seatsTotal,
              restore.seatsAvailable + restore.seatsToRestore
            ),
          },
        })
      }

      if (driverRideIds.length > 0) {
        await tx.ride.updateMany({
          where: {
            id: { in: driverRideIds },
            status: { in: [...ACTIVE_RIDE_STATUSES] },
          },
          data: { status: "cancelled" },
        })
      }

      if (driverRideBookingIds.length > 0) {
        await tx.booking.updateMany({
          where: {
            id: { in: driverRideBookingIds },
            status: { in: [...ACTIVE_BOOKING_STATUSES] },
          },
          data: { status: "cancelled_by_driver" },
        })
      }

      if (rideRequestIdsToCancel.length > 0) {
        await tx.rideRequest.updateMany({
          where: {
            id: { in: rideRequestIdsToCancel },
            status: { notIn: [...TERMINAL_RIDE_REQUEST_STATUSES] },
          },
          data: { status: "CANCELLED" },
        })

        await tx.rideRequestOffer.updateMany({
          where: {
            rideRequestId: { in: rideRequestIdsToCancel },
            status: { in: [...ACTIVE_RIDE_REQUEST_OFFER_STATUSES] },
          },
          data: { status: "EXPIRED" },
        })
      }

      await tx.rideRequestOffer.updateMany({
        where: {
          driverId: userId,
          status: { in: [...ACTIVE_RIDE_REQUEST_OFFER_STATUSES] },
        },
        data: { status: "EXPIRED" },
      })

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
          emailVerifiedAt: null,
          phoneVerified: false,
          phoneVerifiedAt: null,
          appleProviderId: null,
          googleProviderId: null,
          authMethods: [],
          stripeAccountId: preserveStripeConnectAccount
            ? user.stripeAccountId
            : null,
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

    await Promise.all(
      passengerBookings.map((booking) =>
        notifyUser({
          userId: booking.ride.driverId,
          title: "Booking cancelled",
          body: `${booking.ride.fromCity} → ${booking.ride.toCity} was cancelled because the passenger deleted their account`,
          type: "ride_update",
          data: {
            bookingId: booking.id,
            rideId: booking.rideId,
            kind: "booking_cancelled_by_passenger",
          },
        })
      )
    )

    await Promise.all(
      driverRides.flatMap((ride) =>
        ride.bookings.map((booking) =>
          notifyUser({
            userId: booking.passengerId,
            title: "Ride cancelled",
            body: `${ride.fromCity} → ${ride.toCity} was cancelled because the driver deleted their account`,
            type: "ride_update",
            data: {
              rideId: ride.id,
              bookingId: booking.id,
              kind: "ride_cancelled_by_driver",
            },
          })
        )
      )
    )

    await Promise.all(
      passengerRideRequests.map(async (request) => {
        const recipientIds = uniqueIds([
          request.driverId,
          ...request.offers.map((offer) => offer.driverId),
        ]).filter((id) => id !== userId)

        if (recipientIds.length === 0) {
          return
        }

        await notifyUsersByIds({
          userIds: recipientIds,
          title: "Ride request cancelled",
          body: `${request.fromCity} → ${request.toCity} was cancelled because the passenger deleted their account`,
          type: "ride_update",
          data: {
            rideRequestId: request.id,
            kind: "ride_request_cancelled_by_passenger",
          },
        })
      })
    )

    await Promise.all(
      driverAssignedRideRequests.map((request) =>
        notifyUser({
          userId: request.passengerId,
          title: "Ride request cancelled",
          body: `${request.fromCity} → ${request.toCity} was cancelled because the assigned driver deleted their account`,
          type: "ride_update",
          data: {
            rideRequestId: request.id,
            kind: "ride_request_cancelled_by_driver",
          },
        })
      )
    )

    const driverAssignedRideRequestIdSet = new Set(driverAssignedRideRequestIds)
    await Promise.all(
      driverRideRequestOffers
        .filter((offer) => !driverAssignedRideRequestIdSet.has(offer.rideRequestId))
        .map((offer) =>
          notifyUser({
            userId: offer.rideRequest.passengerId,
            title: "Offer cancelled",
            body: `${offer.ride?.fromCity ?? offer.rideRequest.fromCity} → ${offer.ride?.toCity ?? offer.rideRequest.toCity} offer was cancelled because the driver deleted their account`,
            type: "ride_update",
            data: {
              offerId: offer.id,
              rideRequestId: offer.rideRequestId,
              kind: "ride_request_offer_cancelled",
            },
          })
        )
    )

    await Promise.all(
      passengerRideRequestIds.map(async (rideRequestId) => {
        try {
          await dispatchRideRequestCancel({ rideRequestId })
        } catch (cancelErr) {
          console.error(
            "[realtime] cancel dispatch failed",
            JSON.stringify({ rideRequestId, source: "delete_account" }),
            cancelErr
          )
        }
      })
    )

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
