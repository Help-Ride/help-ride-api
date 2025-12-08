// src/controllers/auth.controller.ts
import type { Response } from "express"
import bcrypt from "bcryptjs"
import prisma from "../lib/prisma.js"
import { signAccessToken, signRefreshToken } from "../lib/jwt.js"
import { AuthRequest } from "../middleware/auth.js"
import { sendEmailVerificationOtp } from "../lib/email.js"

interface OAuthBody {
  provider: "google" | "apple"
  providerUserId: string
  email: string
  name: string
  avatarUrl?: string
}

interface RegisterBody {
  name: string
  email: string
  password: string
}

interface LoginBody {
  email: string
  password: string
}

// Helper for issuing tokens + response shape
function buildAuthResponse(user: {
  id: string
  name: string
  email: string
  roleDefault: "passenger" | "driver"
  providerAvatarUrl: string | null
}) {
  const payload = {
    sub: user.id,
    roleDefault: user.roleDefault,
  }

  const accessToken = signAccessToken(payload)
  const refreshToken = signRefreshToken(payload)

  return {
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
  }
}

function generateEmailOtp() {
  // 6-digit numeric OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString()
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
  return { otp, expiresAt }
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

    // Upsert user by email
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
        emailVerified: true, // for OAuth we can consider them verified
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

    const response = buildAuthResponse(user)
    return res.status(200).json(response)
  } catch (err) {
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
    const { name, email, password } = (req.body ?? {}) as Partial<RegisterBody>

    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ error: "name, email, and password are required" })
    }

    if (password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters long" })
    }

    const existing = await prisma.user.findUnique({
      where: { email },
      include: { oauthAccounts: true },
    })

    if (existing && !existing.passwordHash) {
      // Account exists via OAuth, allow them to set a password and use both
      const hash = await bcrypt.hash(password, 10)

      const updated = await prisma.user.update({
        where: { id: existing.id },
        data: {
          name,
          passwordHash: hash,
        },
      })

      const response = buildAuthResponse(updated)
      return res.status(200).json(response)
    }

    if (existing && existing.passwordHash) {
      return res.status(409).json({
        error:
          "An account with this email already exists. Please log in instead.",
      })
    }

    const passwordHash = await bcrypt.hash(password, 10)

    const { otp, expiresAt } = generateEmailOtp()

    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        roleDefault: "passenger",
        emailVerified: false,
        emailVerifyOtp: otp,
        emailVerifyOtpExpiresAt: expiresAt,
        emailVerifyOtpAttempts: 0,
      },
    })

    // Attempt to send verification OTP email, notify user if it fails
    let emailSendFailed = false;
    try {
      await sendEmailVerificationOtp({
        email: user.email,
        name: user.name,
        otp,
      });
    } catch (err) {
      console.error("Failed to send verification OTP", err);
      emailSendFailed = true;
    }

    const response = buildAuthResponse(user);
    if (emailSendFailed) {
      return res.status(201).json({
        ...response,
        warning: "Account created but email verification failed. Please request a new OTP."
      });
    }
    return res.status(201).json(response);
  } catch (err) {
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

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" })
    }

    const user = await prisma.user.findUnique({
      where: { email },
    })

    if (!user || !user.passwordHash) {
      // Either no user or only OAuth account with no password
      return res.status(401).json({ error: "Invalid credentials" })
    }

    const isValid = await bcrypt.compare(password, user.passwordHash)
    if (!isValid) {
      return res.status(401).json({ error: "Invalid credentials" })
    }

    const response = buildAuthResponse(user)
    return res.status(200).json(response)
  } catch (err) {
    console.error("POST /auth/login error", err)
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

/**
 * POST /api/auth/verify-email/send-otp
 * Body: { email }
 * Resend OTP if user exists and not verified.
 */
export async function sendEmailVerifyOtp(req: AuthRequest, res: Response) {
  try {
    const { email } = (req.body ?? {}) as { email?: string }

    if (!email) {
      return res.status(400).json({ error: "email is required" })
    }

    const user = await prisma.user.findUnique({
      where: { email },
    })

    if (!user) {
      // Don't leak existence
      return res.status(200).json({
        message: "If an account exists for this email, an OTP has been sent.",
      })
    }

    if (user.emailVerified) {
      return res.status(200).json({
        message: "Email is already verified.",
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
      email: updated.email,
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
    const { email, otp } = (req.body ?? {}) as {
      email?: string
      otp?: string
    }

    if (!email || !otp) {
      return res.status(400).json({ error: "email and otp are required" })
    }

    const user = await prisma.user.findUnique({
      where: { email },
    })

    if (!user) {
      return res.status(400).json({ error: "Invalid email or OTP" })
    }

    if (user.emailVerified) {
      return res.status(200).json({ message: "Email already verified." })
    }

    if (
      !user.emailVerifyOtp ||
      !user.emailVerifyOtpExpiresAt ||
      user.emailVerifyOtpExpiresAt < new Date()
    ) {
      return res.status(400).json({ error: "OTP expired or not requested" })
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
        `Email verification failed: invalid OTP for userId=${user.id}, email=${user.email}, providedOtp=${otp}`
      )
      return res.status(400).json({ error: "Invalid email or OTP" })

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerifyOtp: null,
        emailVerifyOtpExpiresAt: null,
        emailVerifyOtpAttempts: 0,
      },
    })

    return res.status(200).json({
      message: "Email verified successfully.",
    })
  } catch (err) {
    console.error("POST /auth/verify-email/verify-otp error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
