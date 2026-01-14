// src/controllers/chat.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"
import { pusher, pusherConfigured } from "../lib/pusher.js"

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const PREVIEW_MAX_LEN = 160

interface CreateConversationBody {
  rideId?: string
  passengerId?: string
}

interface SendMessageBody {
  body?: string
}

interface PusherAuthBody {
  socket_id?: string
  channel_name?: string
}

function buildPreview(body: string) {
  const trimmed = body.trim()
  if (trimmed.length <= PREVIEW_MAX_LEN) {
    return trimmed
  }
  return `${trimmed.slice(0, PREVIEW_MAX_LEN - 3)}...`
}

async function ensureParticipant(conversationId: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      passengerId: true,
      driverId: true,
    },
  })

  if (!conversation) {
    return { ok: false as const, error: "Conversation not found" }
  }

  const isParticipant =
    conversation.passengerId === userId || conversation.driverId === userId

  if (!isParticipant) {
    return { ok: false as const, error: "Unauthorized" }
  }

  return { ok: true as const, conversation }
}

/**
 * POST /api/chat/conversations
 * Body: { rideId, passengerId? }
 */
export async function createConversation(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { rideId, passengerId: passengerIdInput } =
      (req.body ?? {}) as CreateConversationBody

    if (!rideId) {
      return res.status(400).json({ error: "rideId is required" })
    }

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      select: { id: true, driverId: true },
    })

    if (!ride) {
      return res.status(404).json({ error: "Ride not found" })
    }

    const isDriver = ride.driverId === req.userId
    const passengerId = isDriver ? passengerIdInput : req.userId
    const driverId = ride.driverId

    if (isDriver && !passengerId) {
      return res.status(400).json({ error: "passengerId is required" })
    }

    if (!passengerId) {
      return res.status(400).json({ error: "passengerId is required" })
    }

    if (passengerId === driverId) {
      return res.status(400).json({
        error: "Passenger and driver must be different users",
      })
    }

    const existing = await prisma.conversation.findFirst({
      where: {
        rideId,
        passengerId,
        driverId,
      },
      include: {
        passenger: {
          select: { id: true, name: true, email: true, providerAvatarUrl: true },
        },
        driver: {
          select: { id: true, name: true, email: true, providerAvatarUrl: true },
        },
      },
    })

    if (existing) {
      return res.status(200).json(existing)
    }

    const conversation = await prisma.conversation.create({
      data: {
        rideId,
        passengerId,
        driverId,
      },
      include: {
        passenger: {
          select: { id: true, name: true, email: true, providerAvatarUrl: true },
        },
        driver: {
          select: { id: true, name: true, email: true, providerAvatarUrl: true },
        },
      },
    })

    return res.status(201).json(conversation)
  } catch (err) {
    console.error("POST /chat/conversations error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/chat/conversations
 */
export async function listConversations(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [{ passengerId: req.userId }, { driverId: req.userId }],
      },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      include: {
        passenger: {
          select: { id: true, name: true, email: true, providerAvatarUrl: true },
        },
        driver: {
          select: { id: true, name: true, email: true, providerAvatarUrl: true },
        },
      },
    })

    return res.json(conversations)
  } catch (err) {
    console.error("GET /chat/conversations error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/chat/conversations/:id/messages?limit=50&cursor=<messageId>
 */
export async function listMessages(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id: conversationId } = req.params
    if (!conversationId) {
      return res.status(400).json({ error: "conversation id is required" })
    }

    const participantCheck = await ensureParticipant(conversationId, req.userId)
    if (!participantCheck.ok) {
      return res.status(401).json({ error: participantCheck.error })
    }

    const limit = Math.min(
      Number(req.query.limit ?? DEFAULT_PAGE_SIZE),
      MAX_PAGE_SIZE
    )
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null

    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: Number.isFinite(limit) ? limit : DEFAULT_PAGE_SIZE,
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
      include: {
        sender: {
          select: { id: true, name: true, providerAvatarUrl: true },
        },
      },
    })

    const nextCursor =
      messages.length > 0 ? messages[messages.length - 1].id : null

    return res.json({ messages, nextCursor })
  } catch (err) {
    console.error("GET /chat/conversations/:id/messages error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/chat/conversations/:id/messages
 * Body: { body }
 */
export async function sendMessage(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id: conversationId } = req.params
    if (!conversationId) {
      return res.status(400).json({ error: "conversation id is required" })
    }

    const { body } = (req.body ?? {}) as SendMessageBody
    const messageBody = body?.trim()

    if (!messageBody) {
      return res.status(400).json({ error: "body is required" })
    }

    if (messageBody.length > 2000) {
      return res.status(400).json({ error: "body is too long" })
    }

    const participantCheck = await ensureParticipant(conversationId, req.userId)
    if (!participantCheck.ok) {
      return res.status(401).json({ error: participantCheck.error })
    }

    const now = new Date()
    const preview = buildPreview(messageBody)

    const [message] = await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId,
          senderId: req.userId,
          body: messageBody,
        },
        include: {
          sender: {
            select: { id: true, name: true, providerAvatarUrl: true },
          },
        },
      }),
      prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: now,
          lastMessagePreview: preview,
        },
      }),
    ])

    console.log("chat message saved", {
      conversationId,
      messageId: message.id,
    })

    if (pusherConfigured && pusher) {
      const pusherClient = pusher
      const conversationChannel = `private-conversation-${conversationId}`
      const inboxPayload = {
        conversationId,
        lastMessageAt: now,
        lastMessagePreview: preview,
        lastMessage: message,
      }

      await pusherClient.trigger(conversationChannel, "message:new", {
        message,
      })

      console.log("pusher event sent", {
        event: "message:new",
        channel: conversationChannel,
      })

      const inboxChannels = [
        `private-user-${participantCheck.conversation.passengerId}`,
        `private-user-${participantCheck.conversation.driverId}`,
      ]

      await Promise.all(
        inboxChannels.map((channel) =>
          pusherClient.trigger(channel, "conversation:updated", inboxPayload)
        )
      )

      console.log("pusher event sent", {
        event: "conversation:updated",
        channels: inboxChannels,
      })
    }

    return res.status(201).json(message)
  } catch (err) {
    console.error("POST /chat/conversations/:id/messages error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/chat/pusher/auth
 * Body: { socket_id, channel_name }
 */
export async function pusherAuth(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    if (!pusherConfigured || !pusher) {
      return res.status(503).json({ error: "Realtime is not configured" })
    }

    const { socket_id, channel_name } = (req.body ?? {}) as PusherAuthBody

    if (!socket_id || !channel_name) {
      return res.status(400).json({ error: "socket_id and channel_name required" })
    }

    const conversationPrefix = "private-conversation-"
    const userPrefix = "private-user-"
    if (channel_name.startsWith(conversationPrefix)) {
      const conversationId = channel_name.slice(conversationPrefix.length)
      const participantCheck = await ensureParticipant(conversationId, req.userId)
      if (!participantCheck.ok) {
        return res.status(403).json({ error: "Unauthorized" })
      }
    } else if (channel_name.startsWith(userPrefix)) {
      const channelUserId = channel_name.slice(userPrefix.length)
      if (channelUserId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" })
      }
    } else {
      return res.status(400).json({ error: "Invalid channel name" })
    }

    const authResponse = pusher.authenticate(socket_id, channel_name)
    return res.send(authResponse)
  } catch (err) {
    console.error("POST /chat/pusher/auth error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
