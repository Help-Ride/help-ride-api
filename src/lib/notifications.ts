import prisma from "../lib/prisma.js"
import { firebaseAdmin, firebaseConfigured } from "./firebase.js"

type NotificationPayload = {
  userId: string
  title: string
  body: string
  type?: "ride_update" | "payment" | "system"
  data?: Record<string, string | number | boolean>
}

type BroadcastPayload = {
  role: "passenger" | "driver"
  title: string
  body: string
  type?: "ride_update" | "payment" | "system"
  data?: Record<string, string | number | boolean>
  excludeUserId?: string
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

  await sendPushToTokens(tokens.map((t) => t.token), payload)
}

async function sendPushToTokens(
  tokens: string[],
  payload: {
    title: string
    body: string
    data?: Record<string, string | number | boolean>
  }
) {
  if (!firebaseConfigured || !firebaseAdmin || tokens.length === 0) {
    return
  }

  const data = serializeData(payload.data)
  const invalidTokens: string[] = []

  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500)
    const response = await firebaseAdmin.messaging().sendEachForMulticast({
      tokens: batch,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data,
    })

    if (response.failureCount > 0) {
      response.responses.forEach((result, index) => {
        if (result.success) return
        const code = result.error?.code
        if (code && INVALID_TOKEN_ERRORS.has(code)) {
          invalidTokens.push(batch[index])
        }
      })
    }
  }

  if (invalidTokens.length > 0) {
    await prisma.deviceToken.deleteMany({
      where: { token: { in: invalidTokens } },
    })
  }
}

export async function notifyUsersByRole(payload: BroadcastPayload) {
  try {
    const tokens = await prisma.deviceToken.findMany({
      where: {
        user: {
          roleDefault: payload.role,
          ...(payload.excludeUserId ? { id: { not: payload.excludeUserId } } : {}),
        },
      },
      select: {
        token: true,
        userId: true,
      },
    })

    if (tokens.length === 0) {
      return { notified: 0 }
    }

    const userIds = Array.from(new Set(tokens.map((t) => t.userId)))

    await prisma.notification.createMany({
      data: userIds.map((userId) => ({
        userId,
        title: payload.title,
        body: payload.body,
        type: payload.type ?? "system",
      })),
    })

    await sendPushToTokens(
      tokens.map((t) => t.token),
      {
        title: payload.title,
        body: payload.body,
        data: payload.data,
      }
    )

    return { notified: userIds.length }
  } catch (err) {
    console.error("broadcast notification error", err)
    return { notified: 0 }
  }
}
