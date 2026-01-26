// src/controllers/notification.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

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
