import crypto from "crypto"
import jwt from "jsonwebtoken"

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET!
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!
const ONBOARDING_SECRET = process.env.JWT_ONBOARDING_SECRET || ACCESS_SECRET

if (!ACCESS_SECRET || !REFRESH_SECRET) {
  console.warn(
    "JWT secrets are not set – set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET in env."
  )
}

export interface JwtPayload {
  sub: string // user id
  roleDefault: "passenger" | "driver"
}

export interface OnboardingJwtPayload {
  challengeId: string
  channel: "phone" | "email"
  identifier: string
}

export function signAccessToken(payload: JwtPayload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: "15m" })
}

export function signRefreshToken(payload: JwtPayload) {
  return jwt.sign(payload, REFRESH_SECRET, {
    expiresIn: "7d",
    jwtid: crypto.randomUUID(),
  })
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, ACCESS_SECRET) as JwtPayload
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, REFRESH_SECRET) as JwtPayload
}

export function signOnboardingToken(payload: OnboardingJwtPayload) {
  return jwt.sign(payload, ONBOARDING_SECRET, {
    expiresIn: "20m",
    jwtid: crypto.randomUUID(),
  })
}

export function verifyOnboardingToken(token: string): OnboardingJwtPayload {
  return jwt.verify(token, ONBOARDING_SECRET) as OnboardingJwtPayload
}
