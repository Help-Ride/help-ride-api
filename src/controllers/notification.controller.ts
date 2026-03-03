// src/controllers/notification.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { notifyUser } from "../lib/notifications.js"
import { AuthRequest } from "../middleware/auth.js"

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

interface RegisterDeviceTokenBody {
  token?: string
  platform?: "ios" | "android" | "web"
}

interface TriggerTestPushBody {
  title?: string
  body?: string
  type?: "ride_update" | "payment" | "system"
  data?: Record<string, string | number | boolean>
}

/**
 * GET /api/notifications?isRead=false&limit=50&cursor=<notificationId>
 */
export async function listNotifications(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const isReadParam = req.query.isRead
    let isReadFilter: boolean | undefined
    if (typeof isReadParam === "string") {
      if (isReadParam === "true") {
        isReadFilter = true
      } else if (isReadParam === "false") {
        isReadFilter = false
      } else {
        return res.status(400).json({ error: "Invalid isRead filter" })
      }
    }

    const limit = Math.min(
      Number(req.query.limit ?? DEFAULT_PAGE_SIZE),
      MAX_PAGE_SIZE
    )
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null

    const notifications = await prisma.notification.findMany({
      where: {
        userId: req.userId,
        ...(typeof isReadFilter === "boolean" ? { isRead: isReadFilter } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: Number.isFinite(limit) ? limit : DEFAULT_PAGE_SIZE,
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
    })

    const nextCursor =
      notifications.length > 0 ? notifications[notifications.length - 1].id : null

    return res.json({ notifications, nextCursor })
  } catch (err) {
    console.error("GET /notifications error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/notifications/tokens/register
 * Body: { token, platform? }
 */
export async function registerDeviceToken(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { token, platform } = (req.body ?? {}) as RegisterDeviceTokenBody
    const normalizedToken =
      typeof token === "string" ? token.trim() : undefined

    if (!normalizedToken) {
      return res.status(400).json({ error: "token is required" })
    }

    if (platform && !["ios", "android", "web"].includes(platform)) {
      return res.status(400).json({ error: "Invalid platform" })
    }

    const saved = await prisma.deviceToken.upsert({
      where: { token: normalizedToken },
      update: {
        userId: req.userId,
        platform: platform ?? undefined,
      },
      create: {
        userId: req.userId,
        token: normalizedToken,
        platform: platform ?? undefined,
      },
    })

    return res.status(201).json(saved)
  } catch (err) {
    console.error("POST /notifications/tokens/register error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/notifications/tokens/unregister
 * Body: { token }
 */
export async function unregisterDeviceToken(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { token } = (req.body ?? {}) as RegisterDeviceTokenBody
    const normalizedToken =
      typeof token === "string" ? token.trim() : undefined

    if (!normalizedToken) {
      return res.status(400).json({ error: "token is required" })
    }

    const removed = await prisma.deviceToken.deleteMany({
      where: { userId: req.userId, token: normalizedToken },
    })

    return res.json({ removed: removed.count })
  } catch (err) {
    console.error("POST /notifications/tokens/unregister error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/notifications/:id/read
 */
export async function markNotificationRead(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "notification id is required" })
    }

    const notification = await prisma.notification.findUnique({ where: { id } })
    if (!notification) {
      return res.status(404).json({ error: "Notification not found" })
    }

    if (notification.userId !== req.userId) {
      return res.status(403).json({ error: "Forbidden" })
    }

    const updated = await prisma.notification.update({
      where: { id },
      data: { isRead: true },
    })

    return res.json(updated)
  } catch (err) {
    console.error("POST /notifications/:id/read error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/notifications/read-all
 */
export async function markAllNotificationsRead(
  req: AuthRequest,
  res: Response
) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const updated = await prisma.notification.updateMany({
      where: { userId: req.userId, isRead: false },
      data: { isRead: true },
    })

    return res.json(updated)
  } catch (err) {
    console.error("POST /notifications/read-all error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/notifications/test-push
 * Body: { title?, body?, type?, data? }
 */
export async function triggerTestPushNotification(
  req: AuthRequest,
  res: Response
) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { title, body, type, data } = (req.body ?? {}) as TriggerTestPushBody

    if (typeof title !== "undefined" && (typeof title !== "string" || !title.trim())) {
      return res.status(400).json({ error: "title must be a non-empty string" })
    }

    if (typeof body !== "undefined" && (typeof body !== "string" || !body.trim())) {
      return res.status(400).json({ error: "body must be a non-empty string" })
    }

    if (type && !["ride_update", "payment", "system"].includes(type)) {
      return res.status(400).json({ error: "Invalid notification type" })
    }

    if (typeof data !== "undefined") {
      const isValidDataObject =
        typeof data === "object" &&
        data !== null &&
        !Array.isArray(data) &&
        Object.values(data).every(
          (value) =>
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
        )

      if (!isValidDataObject) {
        return res.status(400).json({
          error:
            "data must be an object with string, number, or boolean values",
        })
      }
    }

    const notification = await notifyUser({
      userId: req.userId,
      title: title?.trim() || "Test notification",
      body: body?.trim() || "This is a test push notification.",
      type: type ?? "system",
      data: data ?? { test: true },
    })

    if (!notification) {
      return res.status(500).json({ error: "Failed to trigger test push" })
    }

    return res.status(201).json({
      message: "Test notification triggered",
      notification,
    })
  } catch (err) {
    console.error("POST /notifications/test-push error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
