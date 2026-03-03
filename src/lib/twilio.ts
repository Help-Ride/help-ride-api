import twilio from "twilio"

const APP_NAME = "HelpRide"
const E164_PHONE_REGEX = /^\+[1-9]\d{7,14}$/

const accountSid = process.env.TWILIO_ACCOUNT_SID
const authToken = process.env.TWILIO_AUTH_TOKEN
const fromPhone = process.env.TWILIO_FROM_PHONE

export const twilioConfigured = Boolean(accountSid && authToken && fromPhone)

if (!twilioConfigured) {
  console.warn(
    "Twilio is not fully configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_PHONE."
  )
}

const client = twilioConfigured ? twilio(accountSid!, authToken!) : null

export const smsNotificationsEnabled =
  twilioConfigured &&
  String(process.env.TWILIO_SMS_NOTIFICATIONS_ENABLED ?? "true")
    .trim()
    .toLowerCase() === "true"

export class TwilioNotConfiguredError extends Error {
  constructor() {
    super("Twilio is not configured")
    this.name = "TwilioNotConfiguredError"
  }
}

export function normalizePhoneNumber(phone: string) {
  return phone.trim().replace(/[\s()-]/g, "")
}

export function isValidE164Phone(phone: string) {
  return E164_PHONE_REGEX.test(phone)
}

function ensureTwilioClient() {
  if (!client || !fromPhone) {
    throw new TwilioNotConfiguredError()
  }
  return client
}

async function sendSms(to: string, body: string) {
  if (!isValidE164Phone(to)) {
    throw new Error(
      "Phone number must be in E.164 format (for example: +14165551234)"
    )
  }

  const twilioClient = ensureTwilioClient()
  await twilioClient.messages.create({
    from: fromPhone!,
    to,
    body,
  })
}

export async function sendPhoneVerificationOtpSms(params: {
  phone: string
  name: string
  otp: string
}) {
  const { phone, otp } = params
  const body = `Your ${APP_NAME} verification code is ${otp}. It expires in 10 minutes.`
  await sendSms(phone, body)
}

export async function sendPasswordResetOtpSms(params: {
  phone: string
  name: string
  otp: string
}) {
  const { phone, otp } = params
  const body = `Your ${APP_NAME} password reset code is ${otp}. It expires in 10 minutes.`
  await sendSms(phone, body)
}

export async function sendTextNotificationSms(params: {
  phone: string
  title: string
  body: string
}) {
  const { phone, title, body } = params
  const content = `${APP_NAME}: ${title}\n${body}`.trim()
  await sendSms(phone, content)
}

export async function sendTextNotificationsSms(params: {
  phones: string[]
  title: string
  body: string
}) {
  const { phones, title, body } = params
  if (!smsNotificationsEnabled || phones.length === 0) {
    return
  }

  const uniquePhones = Array.from(new Set(phones))
  await Promise.all(uniquePhones.map((phone) => sendTextNotificationSms({
    phone,
    title,
    body,
  })))
}
