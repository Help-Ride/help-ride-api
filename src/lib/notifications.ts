import prisma from "../lib/prisma.js"
import { firebaseAdmin, firebaseConfigured } from "./firebase.js"

type NotificationPayload = {
  userId: string
  title: string
  body: string
  type?: "ride_update" | "payment" | "system"
  data?: Record<string, string | number | boolean>
}

const INVALID_TOKEN_ERRORS = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
])

function serializeData(
  data?: Record<string, string | number | boolean>
): Record<string, string> | undefined {
  if (!data) return undefined
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, String(value)])
  )
}

export async function notifyUser(payload: NotificationPayload) {
  try {
    const notification = await prisma.notification.create({
      data: {
        userId: payload.userId,
        title: payload.title,
        body: payload.body,
        type: payload.type ?? "system",
      },
    })

    await sendPushToUser(payload.userId, {
      title: payload.title,
      body: payload.body,
      data: { notificationId: notification.id, ...(payload.data ?? {}) },
    })

    return notification
  } catch (err) {
    console.error("notification create/send error", err)
    return null
  }
}

export async function sendPushToUser(
  userId: string,
  payload: {
    title: string
    body: string
    data?: Record<string, string | number | boolean>
  }
) {
  if (!firebaseConfigured || !firebaseAdmin) {
    return
  }

  const tokens = await prisma.deviceToken.findMany({
    where: { userId },
    select: { token: true },
  })

  if (tokens.length === 0) {
    return
  }

  const data = serializeData(payload.data)
  const response = await firebaseAdmin.messaging().sendEachForMulticast({
    tokens: tokens.map((t) => t.token),
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data,
  })

  if (response.failureCount > 0) {
    const invalidTokens: string[] = []
    response.responses.forEach((result, index) => {
      if (result.success) return
      const code = result.error?.code
      if (code && INVALID_TOKEN_ERRORS.has(code)) {
        invalidTokens.push(tokens[index].token)
      }
    })

    if (invalidTokens.length > 0) {
      await prisma.deviceToken.deleteMany({
        where: { token: { in: invalidTokens } },
      })
    }
  }
}
