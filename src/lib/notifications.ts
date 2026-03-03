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

type MultiUserPayload = {
  userIds: string[]
  title: string
  body: string
  type?: "ride_update" | "payment" | "system"
  data?: Record<string, string | number | boolean>
}

const INVALID_TOKEN_ERRORS = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
])

type PushDispatchResult = {
  attemptedTokens: number
  successCount: number
  failureCount: number
  invalidTokensDeleted: number
}

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
): Promise<PushDispatchResult> {
  if (!firebaseConfigured || !firebaseAdmin) {
    return {
      attemptedTokens: 0,
      successCount: 0,
      failureCount: 0,
      invalidTokensDeleted: 0,
    }
  }

  const tokens = await prisma.deviceToken.findMany({
    where: { userId },
    select: { token: true },
  })

  if (tokens.length === 0) {
    return {
      attemptedTokens: 0,
      successCount: 0,
      failureCount: 0,
      invalidTokensDeleted: 0,
    }
  }

  return sendPushToTokens(tokens.map((t) => t.token), payload)
}

async function sendPushToTokens(
  tokens: string[],
  payload: {
    title: string
    body: string
    data?: Record<string, string | number | boolean>
  }
): Promise<PushDispatchResult> {
  if (!firebaseConfigured || !firebaseAdmin || tokens.length === 0) {
    return {
      attemptedTokens: 0,
      successCount: 0,
      failureCount: 0,
      invalidTokensDeleted: 0,
    }
  }

  const data = serializeData(payload.data)
  const invalidTokens: string[] = []
  let successCount = 0
  let failureCount = 0

  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500)
    const response = await firebaseAdmin.messaging().sendEachForMulticast({
      tokens: batch,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data,
      android: {
        priority: "high",
        notification: {
          sound: "default",
        },
      },
      apns: {
        headers: {
          "apns-priority": "10",
          "apns-push-type": "alert",
        },
        payload: {
          aps: {
            sound: "default",
          },
        },
      },
    })

    successCount += response.successCount
    failureCount += response.failureCount

    if (response.failureCount > 0) {
      const failureCodes = response.responses
        .filter((result) => !result.success)
        .map((result) => result.error?.code ?? "unknown")

      const failureCodeSummary = failureCodes.reduce<Record<string, number>>(
        (acc, code) => {
          acc[code] = (acc[code] ?? 0) + 1
          return acc
        },
        {}
      )

      console.error("FCM push failures detected", {
        batchSize: batch.length,
        failureCount: response.failureCount,
        failureCodes: failureCodeSummary,
      })

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

  if (successCount === 0 && failureCount > 0) {
    console.warn("No push notification was delivered", {
      attemptedTokens: tokens.length,
      failureCount,
    })
  }

  return {
    attemptedTokens: tokens.length,
    successCount,
    failureCount,
    invalidTokensDeleted: invalidTokens.length,
  }
}

export async function notifyUsersByIds(payload: MultiUserPayload) {
  try {
    const userIds = Array.from(
      new Set(payload.userIds.filter((userId) => userId.trim().length > 0))
    )

    if (userIds.length === 0) {
      return { notified: 0 }
    }

    await prisma.notification.createMany({
      data: userIds.map((userId) => ({
        userId,
        title: payload.title,
        body: payload.body,
        type: payload.type ?? "system",
      })),
    })

    const tokens = await prisma.deviceToken.findMany({
      where: { userId: { in: userIds } },
      select: { token: true },
    })

    await sendPushToTokens(
      tokens.map((tokenRecord) => tokenRecord.token),
      {
        title: payload.title,
        body: payload.body,
        data: payload.data,
      }
    )

    return { notified: userIds.length }
  } catch (err) {
    console.error("multi-user notification broadcast error", err)
    return { notified: 0 }
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
