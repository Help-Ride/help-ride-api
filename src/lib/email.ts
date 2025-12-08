// src/lib/email.ts
import { Resend } from "resend"

const resend = new Resend(process.env.RESEND_API_KEY)

const APP_NAME = "HelpRide"
const EMAIL_FROM =
  process.env.EMAIL_FROM ?? `${APP_NAME} <no-reply@exocodelabs.tech>`

export async function sendEmailVerificationOtp(params: {
  email: string
  name: string
  otp: string
}) {
  const { email, name, otp } = params

  const html = `
    <p>Hi ${name || "there"},</p>
    <p>Your ${APP_NAME} email verification code is:</p>
    <p style="font-size: 24px; font-weight: bold; letter-spacing: 4px;">${otp}</p>
    <p>This code will expire in 10 minutes.</p>
    <p>If you didn’t sign up, you can ignore this email.</p>
  `

  await resend.emails.send({
    from: EMAIL_FROM,
    to: email,
    subject: `Your ${APP_NAME} verification code`,
    html,
  })
}
