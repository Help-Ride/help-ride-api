// src/controllers/auth.controller.ts
import type { Response } from "express"
import bcrypt from "bcryptjs"
import crypto from "crypto"
import { Prisma } from "../generated/prisma/client.js"
import prisma from "../lib/prisma.js"
import {
  signAccessToken,
  signOnboardingToken,
  signRefreshToken,
  verifyOnboardingToken,
  verifyRefreshToken,
} from "../lib/jwt.js"
import { isAppReviewEmail } from "../lib/appReview.js"
import { AuthRequest } from "../middleware/auth.js"
import {
  sendAuthOtpEmail,
  sendEmailVerificationOtp,
  sendPasswordResetOtp,
} from "../lib/email.js"
import {
  sendAuthOtpSms,
  isValidE164Phone,
  normalizePhoneNumber,
  sendPasswordResetOtpSms,
  sendPhoneVerificationOtpSms,
  TwilioNotConfiguredError,
} from "../lib/twilio.js"

interface OAuthBody {
  provider: "google" | "apple"
  providerUserId: string
  email: string
  name: string
  avatarUrl?: string
  identityToken?: string
  lat?: number | string
  lng?: number | string
  accuracyMeters?: number | string | null
  recordedAt?: string
}

interface RegisterBody {
  name: string
  email: string
  password: string
  phone?: string
}

interface LoginBody {
  email: string
  password: string
  lat?: number | string
  lng?: number | string
  accuracyMeters?: number | string | null
  recordedAt?: string
}

interface RefreshBody {
  refreshToken: string
}

interface ResetPasswordBody {
  email: string
  otp: string
  newPassword: string
}

interface SendPhoneOtpBody {
  phone: string
}

interface SendEmailOtpBody {
  email: string
}

interface ContinueAuthBody {
  phone?: string
  email?: string
  deviceId?: string
}

interface VerifyPhoneOtpBody {
  phone: string
  otp: string
}

interface VerifyContinueAuthBody {
  phone?: string
  email?: string
  otp?: string
  deviceId?: string
}

interface CompleteOnboardingBody {
  onboardingToken: string
  firstName: string
  lastName: string
  email?: string
  phone?: string
  deviceId?: string
}

interface ResetPasswordWithPhoneBody {
  phone: string
  otp: string
  newPassword: string
}

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const AUTH_OTP_TTL_MS = 5 * 60 * 1000
const AUTH_OTP_RESEND_COOLDOWN_MS = 30 * 1000
const AUTH_OTP_MAX_VERIFY_ATTEMPTS = 5
const AUTH_OTP_LOCKOUT_MS = 15 * 60 * 1000
const AUTH_OTP_MAX_SENDS_PER_IDENTIFIER_WINDOW = 5
const AUTH_OTP_MAX_SENDS_PER_IP_WINDOW = 12
const AUTH_OTP_MAX_SENDS_PER_DEVICE_WINDOW = 8
const AUTH_OTP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
const TEST_PHONE_OTP_ENABLED =
  String(
    process.env.TEST_PHONE_OTP_ENABLED ??
      (process.env.NODE_ENV === "production" ? "false" : "true"),
  )
    .trim()
    .toLowerCase() === "true"
const TEST_PHONE_OTP_PHONE =
  process.env.TEST_PHONE_OTP_PHONE?.trim() || "+11111111111"
const TEST_PHONE_OTP_CODE = process.env.TEST_PHONE_OTP_CODE?.trim() || "123456"

class LocationValidationError extends Error {}
class PhoneValidationError extends Error {}

function buildMissingAccountResponse(identifierType: "email" | "phone") {
  return {
    error:
      identifierType === "email"
        ? "No account found for this email. Create one to continue."
        : "No account found for this phone number. Create one to continue.",
    code: "ACCOUNT_NOT_FOUND",
    identifierType,
    nextStep: "register",
  }
}

function buildAuthError(
  error: string,
  code: string,
  extra: Record<string, unknown> = {},
) {
  return {
    error,
    code,
    ...extra,
  }
}

function normalizeEmail(value: unknown) {
  const parsed = parseNonEmptyString(value)
  return parsed?.toLowerCase() ?? null
}

function mergeAuthMethods(
  existing: string[] | null | undefined,
  ...next: Array<string | null | undefined>
) {
  const set = new Set<string>()
  for (const value of existing ?? []) {
    const parsed = parseNonEmptyString(value)
    if (parsed) {
      set.add(parsed)
    }
  }
  for (const value of next) {
    const parsed = parseNonEmptyString(value)
    if (parsed) {
      set.add(parsed)
    }
  }
  return Array.from(set)
}

function getRequestedIp(req: AuthRequest) {
  const forwarded = req.headers["x-forwarded-for"]
  if (typeof forwarded === "string" && forwarded.trim().length > 0) {
    return forwarded.split(",")[0]?.trim() ?? req.ip ?? null
  }
  return req.ip ?? null
}

function getRequestedDeviceId(
  body: Record<string, unknown> | null | undefined,
) {
  return parseNonEmptyString(body?.deviceId)
}

function isAccountActive(accountStatus: string | null | undefined) {
  return !accountStatus || accountStatus === "active"
}

function splitNameParts(firstName: string, lastName: string) {
  return `${firstName.trim()} ${lastName.trim()}`.trim()
}

function authMethodForChannel(channel: "phone" | "email") {
  return channel === "phone" ? "phone_otp" : "email_otp"
}

function oauthProviderUserData(
  provider: "google" | "apple",
  providerUserId: string,
) {
  return provider === "apple"
    ? { appleProviderId: providerUserId }
    : { googleProviderId: providerUserId }
}

async function findUserByOAuthProviderId(
  provider: "google" | "apple",
  providerUserId: string,
) {
  return provider === "apple"
    ? prisma.user.findUnique({
        where: { appleProviderId: providerUserId },
      })
    : prisma.user.findUnique({
        where: { googleProviderId: providerUserId },
      })
}

async function releaseDeletedOAuthProviderLink(
  provider: "google" | "apple",
  providerUserId: string,
) {
  const deletedUser = await findUserByOAuthProviderId(provider, providerUserId)
  if (!deletedUser?.deletedAt) {
    return null
  }

  await prisma.user.update({
    where: { id: deletedUser.id },
    data: {
      ...(provider === "apple"
        ? { appleProviderId: null }
        : { googleProviderId: null }),
      authMethods: (deletedUser.authMethods ?? []).filter(
        (method) => method !== provider,
      ),
    },
  })

  await prisma.oAuthAccount.deleteMany({
    where: {
      userId: deletedUser.id,
      provider,
      providerUserId,
    },
  })

  return deletedUser.id
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex")
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

function parseNonEmptyString(value: unknown) {
  if (typeof value !== "string") {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function decodeJwtPayload(token: string) {
  const parts = token.split(".")
  if (parts.length < 2) {
    return null
  }

  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8")
    const parsed = JSON.parse(payload)
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function extractAppleEmailFromIdentityToken(identityToken: unknown) {
  const token = parseNonEmptyString(identityToken)
  if (!token) {
    return null
  }

  const payload = decodeJwtPayload(token)
  return parseNonEmptyString(payload?.email)
}

function parsePhoneOrThrow(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PhoneValidationError("phone is required")
  }

  const normalized = normalizePhoneNumber(value)
  if (!isValidE164Phone(normalized)) {
    throw new PhoneValidationError(
      "phone must be in E.164 format (for example: +14165551234)",
    )
  }

  return normalized
}

function isTestPhoneOtpNumber(phone: string) {
  return TEST_PHONE_OTP_ENABLED && phone === TEST_PHONE_OTP_PHONE
}

function generatePhoneOtp(params: {
  phone: string
  authFlow?: boolean
}): {
  otp: string
  expiresAt: Date
  resendAvailableAt: Date | null
} {
  if (!isTestPhoneOtpNumber(params.phone)) {
    if (params.authFlow) {
      return generateAuthOtp()
    }

    const generated = generateEmailOtp()
    return {
      ...generated,
      resendAvailableAt: null,
    }
  }

  const now = Date.now()
  const expiresAt = new Date(
    now + (params.authFlow ? AUTH_OTP_TTL_MS : 10 * 60 * 1000),
  )

  return params.authFlow
    ? {
        otp: TEST_PHONE_OTP_CODE,
        expiresAt,
        resendAvailableAt: new Date(now + AUTH_OTP_RESEND_COOLDOWN_MS),
      }
    : {
        otp: TEST_PHONE_OTP_CODE,
        expiresAt,
        resendAvailableAt: null,
      }
}

function isValidLatitude(value: number) {
  return Number.isFinite(value) && value >= -90 && value <= 90
}

function isValidLongitude(value: number) {
  return Number.isFinite(value) && value >= -180 && value <= 180
}

async function upsertLocationIfProvided(
  userId: string,
  body: {
    lat?: number | string
    lng?: number | string
    accuracyMeters?: number | string | null
    recordedAt?: string
  },
) {
  const hasLat = body.lat !== undefined && body.lat !== null
  const hasLng = body.lng !== undefined && body.lng !== null
  if (!hasLat && !hasLng) {
    return
  }
  if (!hasLat || !hasLng) {
    throw new LocationValidationError(
      "Both lat and lng are required when sending location",
    )
  }

  const lat = parseNumber(body.lat)
  const lng = parseNumber(body.lng)
  const accuracyMeters =
    body.accuracyMeters === null
      ? null
      : (parseNumber(body.accuracyMeters) ?? null)

  if (lat == null || lng == null) {
    throw new LocationValidationError("lat and lng must be numbers")
  }
  if (!isValidLatitude(lat) || !isValidLongitude(lng)) {
    throw new LocationValidationError("lat/lng are out of range")
  }
  if (
    accuracyMeters != null &&
    (!Number.isFinite(accuracyMeters) || accuracyMeters < 0)
  ) {
    throw new LocationValidationError(
      "accuracyMeters must be a non-negative number",
    )
  }

  let recordedAt = new Date()
  if (body.recordedAt) {
    const parsedRecordedAt = new Date(body.recordedAt)
    if (Number.isNaN(parsedRecordedAt.getTime())) {
      throw new LocationValidationError("recordedAt must be a valid ISO date")
    }
    recordedAt = parsedRecordedAt
  }

  await prisma.userLocation.upsert({
    where: { userId },
    create: {
      userId,
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
  })
}

// Helper for issuing tokens + response shape
async function resolveRoleDefaultForAuth(user: {
  id: string
  roleDefault: "passenger" | "driver"
}) {
  if (user.roleDefault === "driver") {
    return "driver" as const
  }

  const driverProfile = await prisma.driverProfile.findUnique({
    where: { userId: user.id },
    select: { id: true },
  })

  if (!driverProfile) {
    return user.roleDefault
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { roleDefault: "driver" },
  })

  return "driver" as const
}

async function buildAuthResponse(user: {
  id: string
  name: string
  email: string | null
  phone: string | null
  pendingEmail?: string | null
  pendingPhone?: string | null
  phoneVerified: boolean
  emailVerified: boolean
  phoneVerifiedAt?: Date | null
  emailVerifiedAt?: Date | null
  roleDefault: "passenger" | "driver"
  providerAvatarUrl: string | null
  authMethods?: string[]
  accountStatus?: string
  lastLoginAt?: Date | null
  appleProviderId?: string | null
  googleProviderId?: string | null
}) {
  const resolvedRoleDefault = await resolveRoleDefaultForAuth(user)

  const payload = {
    sub: user.id,
    roleDefault: resolvedRoleDefault,
  }

  const accessToken = signAccessToken(payload)
  const refreshToken = signRefreshToken(payload)
  const refreshTokenHash = hashToken(refreshToken)
  const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS)

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: refreshTokenHash,
      expiresAt: refreshTokenExpiresAt,
    },
  })

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      pendingEmail: user.pendingEmail ?? null,
      pendingPhone: user.pendingPhone ?? null,
      phoneVerified: user.phoneVerified,
      emailVerified: user.emailVerified,
      phoneVerifiedAt: user.phoneVerifiedAt ?? null,
      emailVerifiedAt: user.emailVerifiedAt ?? null,
      authMethods: user.authMethods ?? [],
      accountStatus: user.accountStatus ?? "active",
      lastLoginAt: user.lastLoginAt ?? null,
      appleProviderId: user.appleProviderId ?? null,
      googleProviderId: user.googleProviderId ?? null,
      roleDefault: resolvedRoleDefault,
      providerAvatarUrl: user.providerAvatarUrl,
    },
    tokens: {
      accessToken,
      refreshToken,
    },
  }
}

async function loadAuthUserById(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
  })
}

async function markSuccessfulAuth(
  userId: string,
  method: string,
  updates: Record<string, unknown> = {},
) {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { authMethods: true },
  })

  if (!existing) {
    return null
  }

  return prisma.user.update({
    where: { id: userId },
    data: {
      lastLoginAt: new Date(),
      authMethods: mergeAuthMethods(existing.authMethods, method),
      ...updates,
    },
  })
}

function generateEmailOtp() {
  // 6-digit numeric OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString()
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
  return { otp, expiresAt }
}

function generateAuthOtp() {
  const otp = Math.floor(100000 + Math.random() * 900000).toString()
  const now = Date.now()
  return {
    otp,
    expiresAt: new Date(now + AUTH_OTP_TTL_MS),
    resendAvailableAt: new Date(now + AUTH_OTP_RESEND_COOLDOWN_MS),
  }
}

async function findUserByEmailForVerification(email: string) {
  return prisma.user.findFirst({
    where: {
      OR: [{ email }, { pendingEmail: email }],
    },
  })
}

async function findUserByPhoneForVerification(phone: string) {
  return prisma.user.findFirst({
    where: {
      OR: [{ phone }, { pendingPhone: phone }],
    },
  })
}

async function findLatestAuthChallenge(
  channel: "phone" | "email",
  identifier: string,
) {
  return prisma.authChallenge.findFirst({
    where: {
      channel,
      identifier,
      consumedAt: null,
    },
    orderBy: { createdAt: "desc" },
  })
}

async function checkAuthChallengeRateLimits(params: {
  channel: "phone" | "email"
  identifier: string
  requestedFromIp: string | null
  requestedFromDevice: string | null
}) {
  const windowStart = new Date(Date.now() - AUTH_OTP_RATE_LIMIT_WINDOW_MS)

  const identifierRequests = await prisma.authChallenge.count({
    where: {
      channel: params.channel,
      identifier: params.identifier,
      createdAt: { gte: windowStart },
    },
  })

  if (identifierRequests >= AUTH_OTP_MAX_SENDS_PER_IDENTIFIER_WINDOW) {
    return {
      status: 429,
      body: buildAuthError(
        "Too many codes requested. Try again later.",
        "OTP_RATE_LIMITED",
        { retryAfterSeconds: Math.floor(AUTH_OTP_LOCKOUT_MS / 1000) },
      ),
    }
  }

  if (params.requestedFromIp) {
    const ipRequests = await prisma.authChallenge.count({
      where: {
        requestedFromIp: params.requestedFromIp,
        createdAt: { gte: windowStart },
      },
    })
    if (ipRequests >= AUTH_OTP_MAX_SENDS_PER_IP_WINDOW) {
      return {
        status: 429,
        body: buildAuthError(
          "Too many requests from this network. Try again later.",
          "OTP_IP_RATE_LIMITED",
          { retryAfterSeconds: Math.floor(AUTH_OTP_LOCKOUT_MS / 1000) },
        ),
      }
    }
  }

  if (params.requestedFromDevice) {
    const deviceRequests = await prisma.authChallenge.count({
      where: {
        requestedFromDevice: params.requestedFromDevice,
        createdAt: { gte: windowStart },
      },
    })
    if (deviceRequests >= AUTH_OTP_MAX_SENDS_PER_DEVICE_WINDOW) {
      return {
        status: 429,
        body: buildAuthError(
          "Too many codes requested from this device. Try again later.",
          "OTP_DEVICE_RATE_LIMITED",
          { retryAfterSeconds: Math.floor(AUTH_OTP_LOCKOUT_MS / 1000) },
        ),
      }
    }
  }

  return null
}

async function createAuthChallenge(params: {
  channel: "phone" | "email"
  identifier: string
  requestedFromIp: string | null
  requestedFromDevice: string | null
  userId?: string | null
}) {
  const latest = await findLatestAuthChallenge(
    params.channel,
    params.identifier,
  )
  if (latest?.lockedUntil && latest.lockedUntil > new Date()) {
    return {
      error: {
        status: 429,
        body: buildAuthError(
          "Too many failed attempts. Try again later.",
          "OTP_TEMPORARILY_LOCKED",
          {
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((latest.lockedUntil.getTime() - Date.now()) / 1000),
            ),
          },
        ),
      },
    }
  }

  if (latest?.resendAvailableAt && latest.resendAvailableAt > new Date()) {
    return {
      error: {
        status: 429,
        body: buildAuthError(
          "Please wait before requesting another code.",
          "OTP_RESEND_THROTTLED",
          {
            retryAfterSeconds: Math.max(
              1,
              Math.ceil(
                (latest.resendAvailableAt.getTime() - Date.now()) / 1000,
              ),
            ),
          },
        ),
      },
    }
  }

  const rateLimit = await checkAuthChallengeRateLimits(params)
  if (rateLimit) {
    return { error: rateLimit }
  }

  const generated: {
    otp: string
    expiresAt: Date
    resendAvailableAt: Date | null
  } =
    params.channel === "phone"
      ? generatePhoneOtp({
          phone: params.identifier,
          authFlow: true,
        })
      : generateAuthOtp()
  const challenge = await prisma.authChallenge.create({
    data: {
      channel: params.channel,
      identifier: params.identifier,
      userId: params.userId ?? null,
      otp: hashToken(generated.otp),
      expiresAt: generated.expiresAt,
      resendAvailableAt: generated.resendAvailableAt!,
      requestedFromIp: params.requestedFromIp,
      requestedFromDevice: params.requestedFromDevice,
    },
  })

  return { challenge, otp: generated.otp }
}

async function verifyAuthChallenge(params: {
  channel: "phone" | "email"
  identifier: string
  otp: string
}) {
  const challenge = await findLatestAuthChallenge(
    params.channel,
    params.identifier,
  )
  if (!challenge) {
    return {
      error: {
        status: 400,
        body: buildAuthError(
          "Code expired. Request a new one.",
          "OTP_NOT_FOUND",
        ),
      },
    }
  }

  if (challenge.lockedUntil && challenge.lockedUntil > new Date()) {
    return {
      error: {
        status: 429,
        body: buildAuthError(
          "Too many failed attempts. Try again later.",
          "OTP_TEMPORARILY_LOCKED",
          {
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((challenge.lockedUntil.getTime() - Date.now()) / 1000),
            ),
          },
        ),
      },
    }
  }

  if (challenge.expiresAt < new Date()) {
    return {
      error: {
        status: 400,
        body: buildAuthError("Code expired. Request a new one.", "OTP_EXPIRED"),
      },
    }
  }

  if (challenge.otp !== hashToken(params.otp)) {
    const attempts = challenge.verifyAttempts + 1
    const lockedUntil =
      attempts >= AUTH_OTP_MAX_VERIFY_ATTEMPTS
        ? new Date(Date.now() + AUTH_OTP_LOCKOUT_MS)
        : null

    await prisma.authChallenge.update({
      where: { id: challenge.id },
      data: {
        verifyAttempts: attempts,
        lockedUntil,
      },
    })

    return {
      error: {
        status: attempts >= AUTH_OTP_MAX_VERIFY_ATTEMPTS ? 429 : 400,
        body: buildAuthError(
          attempts >= AUTH_OTP_MAX_VERIFY_ATTEMPTS
            ? "Too many failed attempts. Request a new code later."
            : "That code is incorrect. Try again.",
          attempts >= AUTH_OTP_MAX_VERIFY_ATTEMPTS
            ? "OTP_MAX_ATTEMPTS_REACHED"
            : "OTP_INVALID",
          attempts >= AUTH_OTP_MAX_VERIFY_ATTEMPTS
            ? { retryAfterSeconds: Math.floor(AUTH_OTP_LOCKOUT_MS / 1000) }
            : {},
        ),
      },
    }
  }

  const verified = await prisma.authChallenge.update({
    where: { id: challenge.id },
    data: {
      verifiedAt: new Date(),
      verifyAttempts: 0,
      lockedUntil: null,
    },
  })

  return { challenge: verified }
}

function logAuthEvent(event: string, details: Record<string, unknown>) {
  console.info(
    JSON.stringify({
      scope: "auth",
      event,
      ...details,
      timestamp: new Date().toISOString(),
    }),
  )
}

/**
 * POST /api/auth/oauth
 */
export async function oauthLogin(req: AuthRequest, res: Response) {
  try {
    const { provider, providerUserId, email, name, avatarUrl, identityToken } =
      (req.body ?? {}) as Partial<OAuthBody>

    const normalizedProviderUserId = parseNonEmptyString(providerUserId)
    if (!provider || !normalizedProviderUserId) {
      return res.status(400).json({
        error: "provider and providerUserId are required",
      })
    }

    if (!["google", "apple"].includes(provider)) {
      return res.status(400).json({ error: "Invalid provider" })
    }

    const normalizedEmail = normalizeEmail(email)
    const normalizedName = parseNonEmptyString(name)
    const resolvedEmail =
      normalizedEmail ??
      (provider === "apple"
        ? extractAppleEmailFromIdentityToken(identityToken)
        : null)

    const existingOAuthAccount = await prisma.oAuthAccount.findUnique({
      where: {
        provider_providerUserId: {
          provider,
          providerUserId: normalizedProviderUserId,
        },
      },
      include: {
        user: true,
      },
    })

    if (existingOAuthAccount?.user?.deletedAt) {
      await prisma.oAuthAccount.delete({
        where: { id: existingOAuthAccount.id },
      })
    }

    const releasedDeletedUserId = await releaseDeletedOAuthProviderLink(
      provider,
      normalizedProviderUserId,
    )
    if (releasedDeletedUserId) {
      logAuthEvent("oauth_deleted_link_released", {
        provider,
        providerUserId: normalizedProviderUserId,
        userId: releasedDeletedUserId,
      })
    }

    const providerLinkedUser = await findUserByOAuthProviderId(
      provider,
      normalizedProviderUserId,
    )

    if (
      existingOAuthAccount?.user &&
      providerLinkedUser &&
      existingOAuthAccount.user.id !== providerLinkedUser.id
    ) {
      logAuthEvent("oauth_link_conflict", {
        provider,
        providerUserId: normalizedProviderUserId,
        oauthAccountUserId: existingOAuthAccount.user.id,
        providerFieldUserId: providerLinkedUser.id,
      })
      return res
        .status(409)
        .json(
          buildAuthError(
            "This sign-in is linked to another account. Contact support for help.",
            "OAUTH_LINK_CONFLICT",
          ),
        )
    }

    let user =
      (existingOAuthAccount?.user?.deletedAt ?? false)
        ? null
        : existingOAuthAccount?.user ?? providerLinkedUser ?? null

    if (user) {
      if (!isAccountActive(user.accountStatus)) {
        return res
          .status(403)
          .json(
            buildAuthError(
              "This account is not available. Contact support for help.",
              "ACCOUNT_UNAVAILABLE",
            ),
          )
      }

      const shouldUpdateUser =
        (normalizedName != null && normalizedName !== user.name) ||
        (typeof avatarUrl === "string" &&
          avatarUrl.trim().length > 0 &&
          avatarUrl.trim() !== user.providerAvatarUrl) ||
        (resolvedEmail != null && user.email == null) ||
        (resolvedEmail != null &&
          user.email === resolvedEmail &&
          !user.emailVerified)

      if (shouldUpdateUser) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            ...(normalizedName != null ? { name: normalizedName } : {}),
            ...(typeof avatarUrl === "string" && avatarUrl.trim().length > 0
              ? { providerAvatarUrl: avatarUrl.trim() }
              : {}),
            ...(resolvedEmail != null && user.email == null
              ? {
                  email: resolvedEmail,
                  emailVerified: true,
                  emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
                }
              : {}),
            ...(resolvedEmail != null &&
            user.email === resolvedEmail &&
            !user.emailVerified
              ? {
                  emailVerified: true,
                  emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
                }
              : {}),
            ...oauthProviderUserData(provider, normalizedProviderUserId),
          },
        })
      }
    } else {
      if (!resolvedEmail || !normalizedName) {
        return res.status(400).json({
          error:
            provider === "apple"
              ? "Apple did not return an email address for this sign-in. Remove Help Ride from Sign in with Apple in your Apple ID settings, then try again."
              : "email and name are required for first-time OAuth sign-in",
        })
      }

      const existingUser = await prisma.user.findUnique({
        where: { email: resolvedEmail },
      })

      if (existingUser && !isAccountActive(existingUser.accountStatus)) {
        return res
          .status(403)
          .json(
            buildAuthError(
              "This account is not available. Contact support for help.",
              "ACCOUNT_UNAVAILABLE",
            ),
          )
      }

      user =
        existingUser != null && !existingUser.deletedAt
          ? await prisma.user.update({
              where: { id: existingUser.id },
              data: {
                name: normalizedName,
                ...(typeof avatarUrl === "string" && avatarUrl.trim().length > 0
                  ? { providerAvatarUrl: avatarUrl.trim() }
                  : {}),
                emailVerified: true,
                emailVerifiedAt: existingUser.emailVerifiedAt ?? new Date(),
                ...oauthProviderUserData(provider, normalizedProviderUserId),
                authMethods: mergeAuthMethods(
                  existingUser.authMethods,
                  provider,
                ),
              },
            })
          : await prisma.user.create({
              data: {
                email: resolvedEmail,
                name: normalizedName,
                providerAvatarUrl:
                  typeof avatarUrl === "string" && avatarUrl.trim().length > 0
                    ? avatarUrl.trim()
                    : undefined,
                roleDefault: "passenger",
                emailVerified: true,
                emailVerifiedAt: new Date(),
                ...oauthProviderUserData(provider, normalizedProviderUserId),
                authMethods: [provider],
                lastLoginAt: new Date(),
              },
            })
    }

    await prisma.oAuthAccount.upsert({
      where: {
        provider_providerUserId: {
          provider,
          providerUserId: normalizedProviderUserId,
        },
      },
      update: {
        providerEmail:
          resolvedEmail ??
          existingOAuthAccount?.providerEmail ??
          user.email ??
          normalizedProviderUserId,
        userId: user.id,
      },
      create: {
        provider,
        providerUserId: normalizedProviderUserId,
        providerEmail:
          resolvedEmail ??
          existingOAuthAccount?.providerEmail ??
          user.email ??
          normalizedProviderUserId,
        userId: user.id,
      },
    })

    await upsertLocationIfProvided(
      user.id,
      (req.body ?? {}) as Partial<OAuthBody>,
    )

    const authenticatedUser = await markSuccessfulAuth(user.id, provider, {
      ...(provider === "apple"
        ? { appleProviderId: normalizedProviderUserId }
        : { googleProviderId: normalizedProviderUserId }),
    })
    const response = await buildAuthResponse(authenticatedUser ?? user)
    return res.status(200).json(response)
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return res
        .status(409)
        .json(
          buildAuthError(
            "This sign-in is already linked to another account.",
            "OAUTH_ALREADY_LINKED",
          ),
        )
    }
    if (err instanceof LocationValidationError) {
      return res.status(400).json({ error: err.message })
    }
    console.error("POST /auth/oauth error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/register
 * Body: { name, email, password }
 */
export async function registerWithEmail(req: AuthRequest, res: Response) {
  try {
    const { name, email, password, phone } = (req.body ??
      {}) as Partial<RegisterBody>
    const normalizedEmail = normalizeEmail(email)

    if (!name || !normalizedEmail || !password) {
      return res
        .status(400)
        .json({ error: "name, email, and password are required" })
    }

    if (password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters long" })
    }

    const reviewBypass = isAppReviewEmail(normalizedEmail)
    const requestedPhone =
      typeof phone === "string" && phone.trim().length > 0
        ? parsePhoneOrThrow(phone)
        : null

    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { oauthAccounts: true },
    })

    const effectivePhone = requestedPhone ?? existing?.phone ?? null

    if (!reviewBypass && !effectivePhone) {
      return res.status(400).json({
        error: "phone is required for registration",
      })
    }

    if (effectivePhone) {
      const phoneOwner = await prisma.user.findUnique({
        where: { phone: effectivePhone },
        select: { id: true },
      })

      if (phoneOwner && phoneOwner.id !== existing?.id) {
        return res.status(409).json({
          error: "An account with this phone number already exists.",
        })
      }
    }

    if (existing && !existing.passwordHash) {
      // Account exists via OAuth, allow them to set a password and use both
      const hash = await bcrypt.hash(password, 10)
      const samePhone =
        existing.phone != null && existing.phone === effectivePhone

      const updated = await prisma.user.update({
        where: { id: existing.id },
        data: {
          name,
          passwordHash: hash,
          emailVerified: existing.emailVerified || reviewBypass,
          emailVerifiedAt:
            existing.emailVerified || reviewBypass
              ? (existing.emailVerifiedAt ?? new Date())
              : null,
          ...(effectivePhone != null ? { phone: effectivePhone } : {}),
          ...(effectivePhone != null
            ? {
                phoneVerified:
                  reviewBypass || (samePhone && existing.phoneVerified),
                phoneVerifiedAt:
                  reviewBypass || (samePhone && existing.phoneVerified)
                    ? (existing.phoneVerifiedAt ?? new Date())
                    : null,
                phoneVerifyOtp: null,
                phoneVerifyOtpExpiresAt: null,
                phoneVerifyOtpAttempts: 0,
              }
            : {}),
          authMethods: mergeAuthMethods(
            existing.authMethods,
            "legacy_password",
          ),
          lastLoginAt: new Date(),
        },
      })

      const response = await buildAuthResponse(updated)
      return res.status(200).json(response)
    }

    if (existing && existing.passwordHash) {
      return res.status(409).json({
        error:
          "An account with this email already exists. Please log in instead.",
      })
    }

    const passwordHash = await bcrypt.hash(password, 10)

    const user = await prisma.user.create({
      data: {
        name,
        email: normalizedEmail,
        passwordHash,
        roleDefault: "passenger",
        emailVerified: reviewBypass,
        emailVerifiedAt: reviewBypass ? new Date() : null,
        ...(effectivePhone != null ? { phone: effectivePhone } : {}),
        ...(effectivePhone != null
          ? {
              phoneVerified: reviewBypass,
              phoneVerifiedAt: reviewBypass ? new Date() : null,
            }
          : {}),
        authMethods: ["legacy_password"],
        lastLoginAt: new Date(),
      },
    })

    const response = await buildAuthResponse(user)
    return res.status(201).json(response)
  } catch (err) {
    if (err instanceof PhoneValidationError) {
      return res.status(400).json({ error: err.message })
    }
    console.error("POST /auth/register error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
export async function loginWithEmail(req: AuthRequest, res: Response) {
  try {
    const { email, password } = (req.body ?? {}) as Partial<LoginBody>
    const normalizedEmail = normalizeEmail(email)

    if (!normalizedEmail || !password) {
      return res.status(400).json({ error: "email and password are required" })
    }

    let user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    })

    if (!user) {
      return res.status(404).json(buildMissingAccountResponse("email"))
    }

    if (!user.passwordHash) {
      return res.status(409).json({
        error:
          "This account does not have a password yet. Use a one-time code or continue with Apple or Google.",
        code: "PASSWORD_LOGIN_UNAVAILABLE",
        nextStep: "otp_or_oauth",
      })
    }

    const isValid = await bcrypt.compare(password, user.passwordHash)
    if (!isValid) {
      return res.status(401).json({ error: "Invalid credentials" })
    }

    await upsertLocationIfProvided(
      user.id,
      (req.body ?? {}) as Partial<LoginBody>,
    )

    if (!user.emailVerified && user.email && isAppReviewEmail(user.email)) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true, emailVerifiedAt: new Date() },
      })
    }

    const authenticatedUser = await markSuccessfulAuth(
      user.id,
      "legacy_password",
    )
    const response = await buildAuthResponse(authenticatedUser ?? user)
    return res.status(200).json(response)
  } catch (err) {
    if (err instanceof LocationValidationError) {
      return res.status(400).json({ error: err.message })
    }
    console.error("POST /auth/login error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/login-email/send-otp
 * Body: { email }
 */
export async function sendLoginEmailOtp(req: AuthRequest, res: Response) {
  try {
    const { email } = (req.body ?? {}) as Partial<SendEmailOtpBody>
    const normalizedEmail = parseNonEmptyString(email)

    if (!normalizedEmail) {
      return res.status(400).json({ error: "email is required" })
    }

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    })

    if (!user) {
      return res.status(404).json(buildMissingAccountResponse("email"))
    }

    const { otp, expiresAt } = generateEmailOtp()

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifyOtp: otp,
        emailVerifyOtpExpiresAt: expiresAt,
        emailVerifyOtpAttempts: 0,
      },
    })

    await sendEmailVerificationOtp({
      email: updated.email ?? normalizedEmail,
      name: updated.name,
      otp,
    })

    return res.status(200).json({
      message: "Sign-in OTP sent.",
    })
  } catch (err) {
    console.error("POST /auth/login-email/send-otp error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/login-phone/send-otp
 * Body: { phone }
 */
export async function sendLoginPhoneOtp(req: AuthRequest, res: Response) {
  try {
    const { phone } = (req.body ?? {}) as Partial<SendPhoneOtpBody>
    const normalizedPhone = parsePhoneOrThrow(phone)

    const user = await prisma.user.findUnique({
      where: { phone: normalizedPhone },
    })

    if (!user) {
      return res.status(404).json(buildMissingAccountResponse("phone"))
    }

    const { otp, expiresAt } = generatePhoneOtp({
      phone: normalizedPhone,
    })

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        phoneVerifyOtp: otp,
        phoneVerifyOtpExpiresAt: expiresAt,
        phoneVerifyOtpAttempts: 0,
      },
    })

    if (!isTestPhoneOtpNumber(normalizedPhone)) {
      await sendPhoneVerificationOtpSms({
        phone: updated.phone ?? normalizedPhone,
        name: updated.name,
        otp,
      })
    }

    return res.status(200).json({
      message: "Sign-in OTP sent.",
    })
  } catch (err) {
    if (err instanceof PhoneValidationError) {
      return res.status(400).json({ error: err.message })
    }
    if (err instanceof TwilioNotConfiguredError) {
      return res.status(503).json({ error: "SMS service is not configured" })
    }
    console.error("POST /auth/login-phone/send-otp error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/continue/phone
 * Body: { phone, deviceId? }
 */
export async function sendContinuePhoneOtp(req: AuthRequest, res: Response) {
  try {
    const body = (req.body ?? {}) as ContinueAuthBody
    const normalizedPhone = parsePhoneOrThrow(body.phone)
    const requestedFromIp = getRequestedIp(req)
    const requestedFromDevice = getRequestedDeviceId(
      body as Record<string, unknown>,
    )
    const existingUser = await prisma.user.findUnique({
      where: { phone: normalizedPhone },
    })

    if (existingUser && !isAccountActive(existingUser.accountStatus)) {
      return res
        .status(403)
        .json(
          buildAuthError(
            "This account is not available. Contact support for help.",
            "ACCOUNT_UNAVAILABLE",
          ),
        )
    }

    const created = await createAuthChallenge({
      channel: "phone",
      identifier: normalizedPhone,
      requestedFromIp,
      requestedFromDevice,
      userId: existingUser?.id ?? null,
    })

    if (created.error) {
      return res.status(created.error.status).json(created.error.body)
    }

    if (!isTestPhoneOtpNumber(normalizedPhone)) {
      await sendAuthOtpSms({
        phone: normalizedPhone,
        otp: created.otp!,
      })
    }

    logAuthEvent("otp_sent", {
      channel: "phone",
      existingUser: existingUser != null,
      requestedFromIp,
      requestedFromDevice,
      identifierEnding: normalizedPhone.slice(-4),
    })

    return res.status(200).json({
      message: "Code sent.",
      channel: "phone",
      nextStep: "verify_otp",
      resendAvailableInSeconds: Math.floor(AUTH_OTP_RESEND_COOLDOWN_MS / 1000),
    })
  } catch (err) {
    if (err instanceof PhoneValidationError) {
      return res.status(400).json({ error: err.message })
    }
    if (err instanceof TwilioNotConfiguredError) {
      return res.status(503).json({ error: "SMS service is not configured" })
    }
    console.error("POST /auth/continue/phone error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/continue/phone/verify
 * Body: { phone, otp, deviceId? }
 */
export async function verifyContinuePhoneOtp(req: AuthRequest, res: Response) {
  try {
    const body = (req.body ?? {}) as VerifyContinueAuthBody
    const normalizedPhone = parsePhoneOrThrow(body.phone)
    const otp = parseNonEmptyString(body.otp)

    if (!otp) {
      return res.status(400).json({ error: "phone and otp are required" })
    }

    const verification = await verifyAuthChallenge({
      channel: "phone",
      identifier: normalizedPhone,
      otp,
    })

    if (verification.error) {
      return res.status(verification.error.status).json(verification.error.body)
    }

    const verifiedChallenge = verification.challenge!
    const existingUser = await prisma.user.findUnique({
      where: { phone: normalizedPhone },
    })

    if (existingUser) {
      if (!isAccountActive(existingUser.accountStatus)) {
        return res
          .status(403)
          .json(
            buildAuthError(
              "This account is not available. Contact support for help.",
              "ACCOUNT_UNAVAILABLE",
            ),
          )
      }

      const updatedUser = await markSuccessfulAuth(
        existingUser.id,
        authMethodForChannel("phone"),
        {
          phoneVerified: true,
          phoneVerifiedAt: existingUser.phoneVerifiedAt ?? new Date(),
        },
      )

      await prisma.authChallenge.update({
        where: { id: verifiedChallenge.id },
        data: {
          userId: existingUser.id,
          consumedAt: new Date(),
        },
      })

      logAuthEvent("otp_verified", {
        channel: "phone",
        outcome: "existing_user",
        userId: existingUser.id,
      })

      const response = await buildAuthResponse(updatedUser!)
      return res.status(200).json({
        nextStep: "home",
        isNewUser: false,
        ...response,
      })
    }

    const onboardingToken = signOnboardingToken({
      challengeId: verifiedChallenge.id,
      channel: "phone",
      identifier: normalizedPhone,
    })

    logAuthEvent("otp_verified", {
      channel: "phone",
      outcome: "new_user",
      identifierEnding: normalizedPhone.slice(-4),
    })

    return res.status(200).json({
      nextStep: "complete_profile",
      isNewUser: true,
      onboardingToken,
      onboarding: {
        phone: normalizedPhone,
        phoneVerified: true,
      },
    })
  } catch (err) {
    if (err instanceof PhoneValidationError) {
      return res.status(400).json({ error: err.message })
    }
    console.error("POST /auth/continue/phone/verify error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/continue/email
 * Body: { email, deviceId? }
 */
export async function sendContinueEmailOtp(req: AuthRequest, res: Response) {
  try {
    const body = (req.body ?? {}) as ContinueAuthBody
    const normalizedEmail = normalizeEmail(body.email)
    if (!normalizedEmail) {
      return res.status(400).json({ error: "email is required" })
    }

    const requestedFromIp = getRequestedIp(req)
    const requestedFromDevice = getRequestedDeviceId(
      body as Record<string, unknown>,
    )
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    })

    if (existingUser && !isAccountActive(existingUser.accountStatus)) {
      return res
        .status(403)
        .json(
          buildAuthError(
            "This account is not available. Contact support for help.",
            "ACCOUNT_UNAVAILABLE",
          ),
        )
    }

    const created = await createAuthChallenge({
      channel: "email",
      identifier: normalizedEmail,
      requestedFromIp,
      requestedFromDevice,
      userId: existingUser?.id ?? null,
    })

    if (created.error) {
      return res.status(created.error.status).json(created.error.body)
    }

    await sendAuthOtpEmail({
      email: normalizedEmail,
      name: existingUser?.name,
      otp: created.otp!,
    })

    logAuthEvent("otp_sent", {
      channel: "email",
      existingUser: existingUser != null,
      requestedFromIp,
      requestedFromDevice,
      identifierEnding: normalizedEmail.slice(-6),
    })

    return res.status(200).json({
      message: "Code sent.",
      channel: "email",
      nextStep: "verify_otp",
      resendAvailableInSeconds: Math.floor(AUTH_OTP_RESEND_COOLDOWN_MS / 1000),
    })
  } catch (err) {
    console.error("POST /auth/continue/email error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/continue/email/verify
 * Body: { email, otp, deviceId? }
 */
export async function verifyContinueEmailOtp(req: AuthRequest, res: Response) {
  try {
    const body = (req.body ?? {}) as VerifyContinueAuthBody
    const normalizedEmail = normalizeEmail(body.email)
    const otp = parseNonEmptyString(body.otp)

    if (!normalizedEmail || !otp) {
      return res.status(400).json({ error: "email and otp are required" })
    }

    const verification = await verifyAuthChallenge({
      channel: "email",
      identifier: normalizedEmail,
      otp,
    })

    if (verification.error) {
      return res.status(verification.error.status).json(verification.error.body)
    }

    const verifiedChallenge = verification.challenge!
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    })

    if (existingUser) {
      if (!isAccountActive(existingUser.accountStatus)) {
        return res
          .status(403)
          .json(
            buildAuthError(
              "This account is not available. Contact support for help.",
              "ACCOUNT_UNAVAILABLE",
            ),
          )
      }

      const updatedUser = await markSuccessfulAuth(
        existingUser.id,
        authMethodForChannel("email"),
        {
          emailVerified: true,
          emailVerifiedAt: existingUser.emailVerifiedAt ?? new Date(),
        },
      )

      await prisma.authChallenge.update({
        where: { id: verifiedChallenge.id },
        data: {
          userId: existingUser.id,
          consumedAt: new Date(),
        },
      })

      logAuthEvent("otp_verified", {
        channel: "email",
        outcome: "existing_user",
        userId: existingUser.id,
      })

      const response = await buildAuthResponse(updatedUser!)
      return res.status(200).json({
        nextStep: "home",
        isNewUser: false,
        ...response,
      })
    }

    const onboardingToken = signOnboardingToken({
      challengeId: verifiedChallenge.id,
      channel: "email",
      identifier: normalizedEmail,
    })

    logAuthEvent("otp_verified", {
      channel: "email",
      outcome: "new_user",
      identifierEnding: normalizedEmail.slice(-6),
    })

    return res.status(200).json({
      nextStep: "complete_profile",
      isNewUser: true,
      onboardingToken,
      onboarding: {
        email: normalizedEmail,
        emailVerified: true,
      },
    })
  } catch (err) {
    console.error("POST /auth/continue/email/verify error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/onboarding/complete
 * Body: { onboardingToken, firstName, lastName, email?, phone?, deviceId? }
 */
export async function completeOnboarding(req: AuthRequest, res: Response) {
  try {
    const body = (req.body ?? {}) as CompleteOnboardingBody
    const onboardingToken = parseNonEmptyString(body.onboardingToken)
    const firstName = parseNonEmptyString(body.firstName)
    const lastName = parseNonEmptyString(body.lastName)

    if (!onboardingToken || !firstName || !lastName) {
      return res.status(400).json({
        error: "onboardingToken, firstName, and lastName are required",
      })
    }

    let payload: {
      challengeId: string
      channel: "phone" | "email"
      identifier: string
    }
    try {
      payload = verifyOnboardingToken(onboardingToken)
    } catch {
      return res
        .status(401)
        .json(
          buildAuthError(
            "This onboarding session has expired.",
            "ONBOARDING_EXPIRED",
          ),
        )
    }

    const challenge = await prisma.authChallenge.findUnique({
      where: { id: payload.challengeId },
    })

    if (
      !challenge ||
      challenge.channel !== payload.channel ||
      challenge.identifier !== payload.identifier ||
      !challenge.verifiedAt ||
      challenge.consumedAt
    ) {
      return res
        .status(401)
        .json(
          buildAuthError(
            "This onboarding session has expired.",
            "ONBOARDING_EXPIRED",
          ),
        )
    }

    const fullName = splitNameParts(firstName, lastName)
    const normalizedEmail =
      payload.channel === "email"
        ? payload.identifier
        : normalizeEmail(body.email)
    const normalizedPhone =
      payload.channel === "phone"
        ? payload.identifier
        : body.phone
          ? parsePhoneOrThrow(body.phone)
          : null

    if (normalizedEmail) {
      const emailOwner = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true },
      })
      if (emailOwner) {
        return res
          .status(409)
          .json(
            buildAuthError(
              "That email is already linked to another account.",
              "EMAIL_ALREADY_LINKED",
            ),
          )
      }
    }

    if (normalizedPhone) {
      const phoneOwner = await prisma.user.findUnique({
        where: { phone: normalizedPhone },
        select: { id: true },
      })
      if (phoneOwner) {
        return res
          .status(409)
          .json(
            buildAuthError(
              "That phone number is already linked to another account.",
              "PHONE_ALREADY_LINKED",
            ),
          )
      }
    }

    const user = await prisma.user.create({
      data: {
        name: fullName,
        email: normalizedEmail,
        phone: normalizedPhone,
        roleDefault: "passenger",
        emailVerified: payload.channel === "email",
        emailVerifiedAt: payload.channel === "email" ? new Date() : null,
        phoneVerified: payload.channel === "phone",
        phoneVerifiedAt: payload.channel === "phone" ? new Date() : null,
        authMethods: [authMethodForChannel(payload.channel)],
        lastLoginAt: new Date(),
      },
    })

    await prisma.authChallenge.update({
      where: { id: challenge.id },
      data: {
        userId: user.id,
        consumedAt: new Date(),
      },
    })

    logAuthEvent("new_user_created", {
      channel: payload.channel,
      userId: user.id,
    })

    const response = await buildAuthResponse(user)
    return res.status(201).json({
      nextStep: "home",
      isNewUser: true,
      needsPhoneVerification: Boolean(user.phone) && !user.phoneVerified,
      ...response,
    })
  } catch (err) {
    if (err instanceof PhoneValidationError) {
      return res.status(400).json({ error: err.message })
    }
    console.error("POST /auth/onboarding/complete error", err)
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
      phone: user.phone,
      pendingEmail: user.pendingEmail,
      pendingPhone: user.pendingPhone,
      phoneVerified: user.phoneVerified,
      emailVerified: user.emailVerified,
      phoneVerifiedAt: user.phoneVerifiedAt,
      emailVerifiedAt: user.emailVerifiedAt,
      authMethods: user.authMethods,
      accountStatus: user.accountStatus,
      lastLoginAt: user.lastLoginAt,
      appleProviderId: user.appleProviderId,
      googleProviderId: user.googleProviderId,
      roleDefault: user.roleDefault,
      providerAvatarUrl: user.providerAvatarUrl,
      driverProfile: user.driverProfile,
    })
  } catch (err) {
    console.error("GET /auth/me error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/refresh
 * Body: { refreshToken }
 */
export async function refreshTokens(req: AuthRequest, res: Response) {
  try {
    const { refreshToken } = (req.body ?? {}) as Partial<RefreshBody>
    if (!refreshToken) {
      return res.status(400).json({ error: "refreshToken is required" })
    }

    let payload: { sub: string; roleDefault: "passenger" | "driver" }
    try {
      payload = verifyRefreshToken(refreshToken)
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired refresh token" })
    }

    const tokenHash = hashToken(refreshToken)
    const storedToken = await prisma.refreshToken.findUnique({
      where: { tokenHash },
    })

    if (
      !storedToken ||
      storedToken.revokedAt ||
      storedToken.expiresAt < new Date()
    ) {
      return res.status(401).json({ error: "Invalid or expired refresh token" })
    }

    if (storedToken.userId !== payload.sub) {
      return res.status(401).json({ error: "Invalid refresh token" })
    }

    const user = await prisma.user.findUnique({
      where: { id: storedToken.userId },
    })

    if (!user) {
      return res.status(401).json({ error: "Invalid refresh token" })
    }

    if (user.deletedAt) {
      return res.status(401).json({ error: "Invalid refresh token" })
    }

    const newPayload = {
      sub: user.id,
      roleDefault: user.roleDefault,
    }
    const newAccessToken = signAccessToken(newPayload)
    const newRefreshToken = signRefreshToken(newPayload)
    const newTokenHash = hashToken(newRefreshToken)
    const newTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS)
    const now = new Date()

    await prisma.$transaction(async (tx) => {
      const replacement = await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: newTokenHash,
          expiresAt: newTokenExpiresAt,
        },
      })

      await tx.refreshToken.update({
        where: { id: storedToken.id },
        data: {
          revokedAt: now,
          replacedByTokenId: replacement.id,
        },
      })
    })

    return res.status(200).json({
      tokens: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      },
    })
  } catch (err) {
    console.error("POST /auth/refresh error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/logout
 * Body: { refreshToken }
 */
export async function logout(req: AuthRequest, res: Response) {
  try {
    const { refreshToken } = (req.body ?? {}) as Partial<RefreshBody>
    if (!refreshToken) {
      return res.status(400).json({ error: "refreshToken is required" })
    }

    const tokenHash = hashToken(refreshToken)
    await prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    })

    return res.status(200).json({ message: "Logged out successfully." })
  } catch (err) {
    console.error("POST /auth/logout error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/verify-email/send-otp
 * Body: { email }
 * Resend OTP if user exists and not verified.
 */
export async function sendEmailVerifyOtp(req: AuthRequest, res: Response) {
  try {
    const normalizedEmail = normalizeEmail((req.body ?? {})?.email)

    if (!normalizedEmail) {
      return res.status(400).json({ error: "email is required" })
    }

    const user = await findUserByEmailForVerification(normalizedEmail)

    if (!user) {
      // Don't leak existence
      return res.status(200).json({
        message: "If an account exists for this email, an OTP has been sent.",
      })
    }

    const { otp, expiresAt } = generateEmailOtp()

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifyOtp: otp,
        emailVerifyOtpExpiresAt: expiresAt,
        emailVerifyOtpAttempts: 0,
      },
    })

    await sendEmailVerificationOtp({
      email:
        updated.pendingEmail === normalizedEmail
          ? updated.pendingEmail
          : (updated.email ?? normalizedEmail),
      name: updated.name,
      otp,
    })

    return res.status(200).json({
      message: "Verification OTP sent.",
    })
  } catch (err) {
    console.error("POST /auth/verify-email/send-otp error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/verify-email/verify-otp
 * Body: { email, otp }
 */
export async function verifyEmailWithOtp(req: AuthRequest, res: Response) {
  try {
    const { otp } = (req.body ?? {}) as {
      otp?: string
    }
    const normalizedEmail = normalizeEmail((req.body ?? {})?.email)

    if (!normalizedEmail || !otp) {
      return res.status(400).json({ error: "email and otp are required" })
    }

    const user = await findUserByEmailForVerification(normalizedEmail)

    if (!user) {
      return res.status(400).json({ error: "Invalid email or OTP" })
    }

    const verifyingPendingEmail = user.pendingEmail === normalizedEmail

    if (
      !user.emailVerifyOtp ||
      !user.emailVerifyOtpExpiresAt ||
      user.emailVerifyOtpExpiresAt < new Date()
    ) {
      const { otp: newOtp, expiresAt } = generateEmailOtp()
      await prisma.user.update({
        where: { id: user.id },
        data: {
          emailVerifyOtp: newOtp,
          emailVerifyOtpExpiresAt: expiresAt,
          emailVerifyOtpAttempts: 0,
        },
      })

      let emailSendFailed = false
      try {
        await sendEmailVerificationOtp({
          email: verifyingPendingEmail
            ? (user.pendingEmail ?? normalizedEmail)
            : (user.email ?? normalizedEmail),
          name: user.name,
          otp: newOtp,
        })
      } catch (err) {
        console.error("Failed to resend verification OTP", err)
        emailSendFailed = true
      }

      if (emailSendFailed) {
        return res.status(400).json({
          error:
            "OTP expired or not requested. Failed to send a new OTP, please try again.",
        })
      }

      return res.status(400).json({
        error: "OTP expired or not requested. A new OTP has been sent.",
      })
    }

    // Optional: simple brute-force protection
    if (user.emailVerifyOtpAttempts >= 5) {
      return res.status(429).json({
        error: "Too many attempts. Please request a new OTP.",
      })
    }

    if (user.emailVerifyOtp !== otp) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          emailVerifyOtpAttempts: { increment: 1 },
        },
      })

      console.warn(
        `Email verification failed: invalid OTP for userId=${user.id}, email=${user.email}, providedOtp=${otp}`,
      )
      return res.status(400).json({ error: "Invalid email or OTP" })
    }
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(verifyingPendingEmail
          ? {
              email: normalizedEmail,
              pendingEmail: null,
            }
          : {}),
        emailVerified: true,
        emailVerifiedAt: new Date(),
        emailVerifyOtp: null,
        emailVerifyOtpExpiresAt: null,
        emailVerifyOtpAttempts: 0,
      },
    })

    const authenticatedUser = await markSuccessfulAuth(
      updated.id,
      authMethodForChannel("email"),
    )
    const response = await buildAuthResponse(authenticatedUser ?? updated)

    console.log(response)
    return res.status(200).json(response)
  } catch (err) {
    console.error("POST /auth/verify-email/verify-otp error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/verify-phone/send-otp
 * Body: { phone }
 */
export async function sendPhoneVerifyOtp(req: AuthRequest, res: Response) {
  try {
    const { phone } = (req.body ?? {}) as Partial<SendPhoneOtpBody>
    const normalizedPhone = parsePhoneOrThrow(phone)

    const user = await findUserByPhoneForVerification(normalizedPhone)

    if (!user) {
      return res.status(200).json({
        message: "If an account exists for this phone, an OTP has been sent.",
      })
    }

    const { otp, expiresAt } = generatePhoneOtp({
      phone: normalizedPhone,
    })
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        phoneVerifyOtp: otp,
        phoneVerifyOtpExpiresAt: expiresAt,
        phoneVerifyOtpAttempts: 0,
      },
    })

    if (!isTestPhoneOtpNumber(normalizedPhone)) {
      await sendPhoneVerificationOtpSms({
        phone:
          updated.pendingPhone === normalizedPhone
            ? updated.pendingPhone
            : (updated.phone ?? normalizedPhone),
        name: updated.name,
        otp,
      })
    }

    return res.status(200).json({
      message: "Phone verification OTP sent.",
    })
  } catch (err) {
    if (err instanceof PhoneValidationError) {
      return res.status(400).json({ error: err.message })
    }
    if (err instanceof TwilioNotConfiguredError) {
      return res.status(503).json({ error: "SMS service is not configured" })
    }
    console.error("POST /auth/verify-phone/send-otp error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/verify-phone/verify-otp
 * Body: { phone, otp }
 */
export async function verifyPhoneWithOtp(req: AuthRequest, res: Response) {
  try {
    const { phone, otp } = (req.body ?? {}) as Partial<VerifyPhoneOtpBody>
    const normalizedPhone = parsePhoneOrThrow(phone)

    if (!otp) {
      return res.status(400).json({ error: "phone and otp are required" })
    }

    const user = await findUserByPhoneForVerification(normalizedPhone)

    if (!user) {
      return res.status(400).json({ error: "Invalid phone or OTP" })
    }

    const verifyingPendingPhone = user.pendingPhone === normalizedPhone

    if (
      !user.phoneVerifyOtp ||
      !user.phoneVerifyOtpExpiresAt ||
      user.phoneVerifyOtpExpiresAt < new Date()
    ) {
      const { otp: newOtp, expiresAt } = generatePhoneOtp({
        phone: normalizedPhone,
      })
      await prisma.user.update({
        where: { id: user.id },
        data: {
          phoneVerifyOtp: newOtp,
          phoneVerifyOtpExpiresAt: expiresAt,
          phoneVerifyOtpAttempts: 0,
        },
      })

      let smsSendFailed = false
      if (!isTestPhoneOtpNumber(normalizedPhone)) {
        try {
          await sendPhoneVerificationOtpSms({
            phone: verifyingPendingPhone
              ? (user.pendingPhone ?? normalizedPhone)
              : (user.phone ?? normalizedPhone),
            name: user.name,
            otp: newOtp,
          })
        } catch (sendErr) {
          console.error("Failed to resend phone verification OTP", sendErr)
          smsSendFailed = true
        }
      }

      if (smsSendFailed) {
        return res.status(400).json({
          error:
            "OTP expired or not requested. Failed to send a new OTP, please try again.",
        })
      }

      return res.status(400).json({
        error: "OTP expired or not requested. A new OTP has been sent.",
      })
    }

    if (user.phoneVerifyOtpAttempts >= 5) {
      return res.status(429).json({
        error: "Too many attempts. Please request a new OTP.",
      })
    }

    if (user.phoneVerifyOtp !== otp) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          phoneVerifyOtpAttempts: { increment: 1 },
        },
      })

      return res.status(400).json({ error: "Invalid phone or OTP" })
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(verifyingPendingPhone
          ? {
              phone: normalizedPhone,
              pendingPhone: null,
            }
          : {}),
        phoneVerified: true,
        phoneVerifiedAt: new Date(),
        phoneVerifyOtp: null,
        phoneVerifyOtpExpiresAt: null,
        phoneVerifyOtpAttempts: 0,
      },
    })

    const authenticatedUser = await markSuccessfulAuth(
      updated.id,
      authMethodForChannel("phone"),
    )
    const response = await buildAuthResponse(authenticatedUser ?? updated)
    return res.status(200).json(response)
  } catch (err) {
    if (err instanceof PhoneValidationError) {
      return res.status(400).json({ error: err.message })
    }
    if (err instanceof TwilioNotConfiguredError) {
      return res.status(503).json({ error: "SMS service is not configured" })
    }
    console.error("POST /auth/verify-phone/verify-otp error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/password-reset/send-otp
 * Body: { email }
 */
export async function sendPasswordResetOtpEmail(
  req: AuthRequest,
  res: Response,
) {
  try {
    const { email } = (req.body ?? {}) as { email?: string }

    if (!email) {
      return res.status(400).json({ error: "email is required" })
    }

    const user = await prisma.user.findUnique({
      where: { email },
    })

    if (!user) {
      return res.status(200).json({
        message: "If an account exists for this email, an OTP has been sent.",
      })
    }

    const { otp, expiresAt } = generateEmailOtp()

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetOtp: otp,
        passwordResetOtpExpiresAt: expiresAt,
        passwordResetOtpAttempts: 0,
      },
    })

    await sendPasswordResetOtp({
      email: updated.email ?? email ?? "",
      name: updated.name,
      otp,
    })

    return res.status(200).json({
      message: "Password reset OTP sent.",
    })
  } catch (err) {
    console.error("POST /auth/password-reset/send-otp error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/password-reset/verify-otp
 * Body: { email, otp, newPassword }
 */
export async function resetPasswordWithOtp(req: AuthRequest, res: Response) {
  try {
    const { email, otp, newPassword } = (req.body ??
      {}) as Partial<ResetPasswordBody>

    if (!email || !otp || !newPassword) {
      return res
        .status(400)
        .json({ error: "email, otp, and newPassword are required" })
    }

    if (newPassword.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters long" })
    }

    const user = await prisma.user.findUnique({
      where: { email },
    })

    if (!user) {
      return res.status(400).json({ error: "Invalid email or OTP" })
    }

    if (
      !user.passwordResetOtp ||
      !user.passwordResetOtpExpiresAt ||
      user.passwordResetOtpExpiresAt < new Date()
    ) {
      const { otp: newOtp, expiresAt } = generateEmailOtp()
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetOtp: newOtp,
          passwordResetOtpExpiresAt: expiresAt,
          passwordResetOtpAttempts: 0,
        },
      })

      let emailSendFailed = false
      try {
        await sendPasswordResetOtp({
          email: user.email ?? email ?? "",
          name: user.name,
          otp: newOtp,
        })
      } catch (err) {
        console.error("Failed to resend password reset OTP", err)
        emailSendFailed = true
      }

      if (emailSendFailed) {
        return res.status(400).json({
          error:
            "OTP expired or not requested. Failed to send a new OTP, please try again.",
        })
      }

      return res.status(400).json({
        error: "OTP expired or not requested. A new OTP has been sent.",
      })
    }

    if (user.passwordResetOtpAttempts >= 5) {
      return res.status(429).json({
        error: "Too many attempts. Please request a new OTP.",
      })
    }

    if (user.passwordResetOtp !== otp) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetOtpAttempts: { increment: 1 },
        },
      })

      return res.status(400).json({ error: "Invalid email or OTP" })
    }

    const passwordHash = await bcrypt.hash(newPassword, 10)
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetOtp: null,
        passwordResetOtpExpiresAt: null,
        passwordResetOtpAttempts: 0,
      },
    })

    return res.status(200).json({ message: "Password reset successful." })
  } catch (err) {
    console.error("POST /auth/password-reset/verify-otp error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/password-reset/send-otp-phone
 * Body: { phone }
 */
export async function sendPasswordResetOtpPhone(
  req: AuthRequest,
  res: Response,
) {
  try {
    const { phone } = (req.body ?? {}) as Partial<SendPhoneOtpBody>
    const normalizedPhone = parsePhoneOrThrow(phone)

    const user = await prisma.user.findUnique({
      where: { phone: normalizedPhone },
    })

    if (!user) {
      return res.status(200).json({
        message: "If an account exists for this phone, an OTP has been sent.",
      })
    }

    const { otp, expiresAt } = generateEmailOtp()

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetOtp: otp,
        passwordResetOtpExpiresAt: expiresAt,
        passwordResetOtpAttempts: 0,
      },
    })

    await sendPasswordResetOtpSms({
      phone: updated.phone ?? normalizedPhone,
      name: updated.name,
      otp,
    })

    return res.status(200).json({
      message: "Password reset OTP sent.",
    })
  } catch (err) {
    if (err instanceof PhoneValidationError) {
      return res.status(400).json({ error: err.message })
    }
    if (err instanceof TwilioNotConfiguredError) {
      return res.status(503).json({ error: "SMS service is not configured" })
    }
    console.error("POST /auth/password-reset/send-otp-phone error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/auth/password-reset/verify-otp-phone
 * Body: { phone, otp, newPassword }
 */
export async function resetPasswordWithOtpPhone(
  req: AuthRequest,
  res: Response,
) {
  try {
    const { phone, otp, newPassword } = (req.body ??
      {}) as Partial<ResetPasswordWithPhoneBody>
    const normalizedPhone = parsePhoneOrThrow(phone)

    if (!otp || !newPassword) {
      return res
        .status(400)
        .json({ error: "phone, otp, and newPassword are required" })
    }

    if (newPassword.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters long" })
    }

    const user = await prisma.user.findUnique({
      where: { phone: normalizedPhone },
    })

    if (!user) {
      return res.status(400).json({ error: "Invalid phone or OTP" })
    }

    if (
      !user.passwordResetOtp ||
      !user.passwordResetOtpExpiresAt ||
      user.passwordResetOtpExpiresAt < new Date()
    ) {
      const { otp: newOtp, expiresAt } = generateEmailOtp()
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetOtp: newOtp,
          passwordResetOtpExpiresAt: expiresAt,
          passwordResetOtpAttempts: 0,
        },
      })

      let smsSendFailed = false
      try {
        await sendPasswordResetOtpSms({
          phone: user.phone ?? normalizedPhone,
          name: user.name,
          otp: newOtp,
        })
      } catch (sendErr) {
        console.error("Failed to resend SMS password reset OTP", sendErr)
        smsSendFailed = true
      }

      if (smsSendFailed) {
        return res.status(400).json({
          error:
            "OTP expired or not requested. Failed to send a new OTP, please try again.",
        })
      }

      return res.status(400).json({
        error: "OTP expired or not requested. A new OTP has been sent.",
      })
    }

    if (user.passwordResetOtpAttempts >= 5) {
      return res.status(429).json({
        error: "Too many attempts. Please request a new OTP.",
      })
    }

    if (user.passwordResetOtp !== otp) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetOtpAttempts: { increment: 1 },
        },
      })

      return res.status(400).json({ error: "Invalid phone or OTP" })
    }

    const passwordHash = await bcrypt.hash(newPassword, 10)
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetOtp: null,
        passwordResetOtpExpiresAt: null,
        passwordResetOtpAttempts: 0,
      },
    })

    return res.status(200).json({ message: "Password reset successful." })
  } catch (err) {
    if (err instanceof PhoneValidationError) {
      return res.status(400).json({ error: err.message })
    }
    if (err instanceof TwilioNotConfiguredError) {
      return res.status(503).json({ error: "SMS service is not configured" })
    }
    console.error("POST /auth/password-reset/verify-otp-phone error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
