// src/controllers/chat.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"
import { pusher, pusherConfigured } from "../lib/pusher.js"
import { notifyUser } from "../lib/notifications.js"

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const PREVIEW_MAX_LEN = 160
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

const conversationInclude = {
  passenger: {
    select: { id: true, name: true, email: true, providerAvatarUrl: true },
  },
  driver: {
    select: { id: true, name: true, email: true, providerAvatarUrl: true },
  },
  ride: {
    select: {
      id: true,
      fromCity: true,
      toCity: true,
      startTime: true,
      status: true,
      pricePerSeat: true,
      seatsTotal: true,
      seatsAvailable: true,
    },
  },
} as const

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

interface ChatBlockState {
  blockedByMe: boolean
  blockedByOtherUser: boolean
  chatDisabled: boolean
}

interface ChatAccessState extends ChatBlockState {
  paymentRequired: boolean
}

interface BlockRelationship {
  blockerId: string
  blockedUserId: string
}

const EMPTY_CHAT_BLOCK_STATE: ChatBlockState = {
  blockedByMe: false,
  blockedByOtherUser: false,
  chatDisabled: false,
}

const EMPTY_CHAT_ACCESS_STATE: ChatAccessState = {
  ...EMPTY_CHAT_BLOCK_STATE,
  paymentRequired: false,
}

const CHAT_UNLOCKED_PAYMENT_STATUSES = ["paid", "succeeded"] as const

function buildPreview(body: string) {
  const trimmed = body.trim()
  if (trimmed.length <= PREVIEW_MAX_LEN) {
    return trimmed
  }
  return `${trimmed.slice(0, PREVIEW_MAX_LEN - 3)}...`
}

function formatRideTimeLabel(value: Date | null | undefined) {
  if (!value) return null
  const month = MONTH_LABELS[value.getMonth()] ?? ""
  const day = value.getDate()
  const hour24 = value.getHours()
  const minute = value.getMinutes().toString().padStart(2, "0")
  const suffix = hour24 >= 12 ? "PM" : "AM"
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  return `${month} ${day}, ${hour12}:${minute} ${suffix}`
}

function buildRideReference(rideId: string | null | undefined) {
  const id = rideId?.trim() ?? ""
  if (id.length === 0) return null
  return `Ride #${id.slice(0, 8).toUpperCase()}`
}

function serializeConversation(
  conversation: any,
  accessState: ChatAccessState = EMPTY_CHAT_ACCESS_STATE
) {
  const ride = conversation.ride ?? null
  const ridePricePerSeat =
    ride?.pricePerSeat == null ? null : Number(ride.pricePerSeat)
  const tripSummary =
    ride?.fromCity && ride?.toCity ? `${ride.fromCity} → ${ride.toCity}` : null
  const tripTimeLabel = formatRideTimeLabel(ride?.startTime)
  const rideReference = buildRideReference(ride?.id ?? conversation.rideId)

  return {
    ...conversation,
    ride:
      ride == null
        ? null
        : {
            ...ride,
            pricePerSeat: ridePricePerSeat,
          },
    tripSummary,
    tripTime: tripTimeLabel,
    tripTimeLabel,
    rideReference,
    rideStatus: ride?.status ?? null,
    ridePricePerSeat,
    rideStartTime: ride?.startTime ?? null,
    blockedByMe: accessState.blockedByMe,
    blockedByOtherUser: accessState.blockedByOtherUser,
    paymentRequired: accessState.paymentRequired,
    chatDisabled: accessState.chatDisabled,
  }
}

function getOtherParticipantId(
  conversation: { passengerId: string; driverId: string },
  currentUserId: string
) {
  return conversation.passengerId === currentUserId
    ? conversation.driverId
    : conversation.passengerId
}

function buildChatBlockState(
  currentUserId: string,
  otherUserId: string,
  relationships: BlockRelationship[]
): ChatBlockState {
  let blockedByMe = false
  let blockedByOtherUser = false

  for (const relationship of relationships) {
    if (
      relationship.blockerId === currentUserId &&
      relationship.blockedUserId === otherUserId
    ) {
      blockedByMe = true
    } else if (
      relationship.blockerId === otherUserId &&
      relationship.blockedUserId === currentUserId
    ) {
      blockedByOtherUser = true
    }
  }

  return {
    blockedByMe,
    blockedByOtherUser,
    chatDisabled: blockedByMe || blockedByOtherUser,
  }
}

function buildChatAccessState(
  blockState: ChatBlockState,
  paymentRequired: boolean
): ChatAccessState {
  return {
    ...blockState,
    paymentRequired,
    chatDisabled: blockState.chatDisabled || paymentRequired,
  }
}

function conversationPaymentKey(
  rideId: string | null | undefined,
  passengerId: string | null | undefined
) {
  const normalizedRideId = rideId?.trim() ?? ""
  const normalizedPassengerId = passengerId?.trim() ?? ""
  if (!normalizedRideId || !normalizedPassengerId) {
    return null
  }
  return `${normalizedRideId}:${normalizedPassengerId}`
}

function chatPaymentRequiredMessage() {
  return "Chat unlocks after payment is completed for this booking."
}

function chatPaymentRequiredErrorResponse(
  accessState: ChatAccessState = EMPTY_CHAT_ACCESS_STATE
) {
  return {
    error: chatPaymentRequiredMessage(),
    code: "CHAT_PAYMENT_REQUIRED",
    blockedByMe: accessState.blockedByMe,
    blockedByOtherUser: accessState.blockedByOtherUser,
    paymentRequired: true,
    chatDisabled: true,
  }
}

async function hasConversationPaymentAccess(params: {
  rideId: string | null | undefined
  passengerId: string
}) {
  const key = conversationPaymentKey(params.rideId, params.passengerId)
  if (!key) {
    return true
  }

  const booking = await prisma.booking.findFirst({
    where: {
      rideId: params.rideId!.trim(),
      passengerId: params.passengerId,
      paymentStatus: {
        in: [...CHAT_UNLOCKED_PAYMENT_STATUSES],
      },
    },
    select: { id: true },
  })

  return booking != null
}

async function listPaidConversationKeys(
  conversations: Array<{ rideId: string | null; passengerId: string }>
) {
  const rideIds = Array.from(
    new Set(
      conversations
        .map((conversation) => conversation.rideId?.trim() ?? "")
        .filter((value) => value.length > 0)
    )
  )
  const passengerIds = Array.from(
    new Set(
      conversations
        .map((conversation) => conversation.passengerId.trim())
        .filter((value) => value.length > 0)
    )
  )

  if (rideIds.length === 0 || passengerIds.length === 0) {
    return new Set<string>()
  }

  const paidBookings = await prisma.booking.findMany({
    where: {
      rideId: { in: rideIds },
      passengerId: { in: passengerIds },
      paymentStatus: {
        in: [...CHAT_UNLOCKED_PAYMENT_STATUSES],
      },
    },
    select: {
      rideId: true,
      passengerId: true,
    },
  })

  return new Set(
    paidBookings
      .map((booking) => conversationPaymentKey(booking.rideId, booking.passengerId))
      .filter((value): value is string => value != null)
  )
}

async function getChatBlockState(
  currentUserId: string,
  otherUserId: string
): Promise<ChatBlockState> {
  if (!currentUserId || !otherUserId || currentUserId === otherUserId) {
    return EMPTY_CHAT_BLOCK_STATE
  }

  const relationships = await prisma.blockedUser.findMany({
    where: {
      OR: [
        { blockerId: currentUserId, blockedUserId: otherUserId },
        { blockerId: otherUserId, blockedUserId: currentUserId },
      ],
    },
    select: {
      blockerId: true,
      blockedUserId: true,
    },
  })

  return buildChatBlockState(currentUserId, otherUserId, relationships)
}

function chatBlockedMessage(state: ChatBlockState) {
  if (state.blockedByMe) {
    return "You blocked this user. Unblock them to continue chatting."
  }
  if (state.blockedByOtherUser) {
    return "This user is not available for chat."
  }
  return "Chat is unavailable."
}

function chatBlockedErrorResponse(state: ChatBlockState) {
  return {
    error: chatBlockedMessage(state),
    code: "CHAT_BLOCKED",
    blockedByMe: state.blockedByMe,
    blockedByOtherUser: state.blockedByOtherUser,
    chatDisabled: state.chatDisabled,
  }
}

async function ensureParticipant(conversationId: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      rideId: true,
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

    const otherUserId = req.userId === driverId ? passengerId : driverId
    const chatBlockState = await getChatBlockState(req.userId, otherUserId)
    const paymentRequired = !(await hasConversationPaymentAccess({
      rideId,
      passengerId,
    }))
    const chatAccessState = buildChatAccessState(
      chatBlockState,
      paymentRequired
    )

    const existing = await prisma.conversation.findFirst({
      where: {
        rideId,
        passengerId,
        driverId,
      },
      include: conversationInclude,
    })

    if (existing) {
      if (chatAccessState.paymentRequired) {
        return res.status(403).json(chatPaymentRequiredErrorResponse(chatAccessState))
      }
      return res.status(200).json(serializeConversation(existing, chatAccessState))
    }

    if (chatAccessState.paymentRequired) {
      return res.status(403).json(chatPaymentRequiredErrorResponse(chatAccessState))
    }

    if (chatBlockState.chatDisabled) {
      return res.status(403).json(chatBlockedErrorResponse(chatBlockState))
    }

    const conversation = await prisma.conversation.create({
      data: {
        rideId,
        passengerId,
        driverId,
      },
      include: conversationInclude,
    })

    return res.status(201).json(serializeConversation(conversation, chatAccessState))
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
      include: conversationInclude,
    })
    const relationships = await prisma.blockedUser.findMany({
      where: {
        OR: [{ blockerId: req.userId }, { blockedUserId: req.userId }],
      },
      select: {
        blockerId: true,
        blockedUserId: true,
      },
    })
    const paidConversationKeys = await listPaidConversationKeys(
      conversations.map((conversation) => ({
        rideId: conversation.rideId,
        passengerId: conversation.passengerId,
      }))
    )

    return res.json(
      conversations.map((conversation) =>
        serializeConversation(
          conversation,
          buildChatAccessState(
            buildChatBlockState(
              req.userId!,
              getOtherParticipantId(conversation, req.userId!),
              relationships
            ),
            (() => {
              const key = conversationPaymentKey(
                conversation.rideId,
                conversation.passengerId
              )
              return key == null ? false : !paidConversationKeys.has(key)
            })()
          )
        )
      )
    )
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

    const paymentAllowed = await hasConversationPaymentAccess({
      rideId: participantCheck.conversation.rideId,
      passengerId: participantCheck.conversation.passengerId,
    })
    if (!paymentAllowed) {
      return res.status(403).json(chatPaymentRequiredErrorResponse())
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

    const paymentAllowed = await hasConversationPaymentAccess({
      rideId: participantCheck.conversation.rideId,
      passengerId: participantCheck.conversation.passengerId,
    })
    if (!paymentAllowed) {
      return res.status(403).json(chatPaymentRequiredErrorResponse())
    }

    const otherUserId = getOtherParticipantId(
      participantCheck.conversation,
      req.userId
    )
    const chatBlockState = await getChatBlockState(req.userId, otherUserId)
    if (chatBlockState.chatDisabled) {
      return res.status(403).json(chatBlockedErrorResponse(chatBlockState))
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

    const recipientId =
      participantCheck.conversation.passengerId === req.userId
        ? participantCheck.conversation.driverId
        : participantCheck.conversation.passengerId
    const senderName = message.sender.name?.trim() || "Someone"
    const notificationBody = `${senderName}: ${preview}`

    const notification = await notifyUser({
      userId: recipientId,
      title: "New message",
      body: notificationBody,
      type: "system",
      data: {
        conversationId,
        messageId: message.id,
        kind: "chat_message",
      },
    })

    if (!notification) {
      console.warn("chat notification dispatch failed", {
        conversationId,
        messageId: message.id,
        recipientId,
      })
    }

    console.log("chat message saved", {
      conversationId,
      messageId: message.id,
    })

    const refreshedConversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: conversationInclude,
    })

    if (pusherConfigured && pusher) {
      const pusherClient = pusher
      const conversationChannel = `private-conversation-${conversationId}`
      const inboxPayload =
        refreshedConversation == null
          ? {
              conversationId,
              lastMessageAt: now,
              lastMessagePreview: preview,
              lastMessage: message,
            }
          : {
              conversation: serializeConversation(refreshedConversation),
              lastMessage: message,
            }

      try {
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

        await Promise.all([
          ...inboxChannels.map((channel) =>
            pusherClient.trigger(channel, "conversation:updated", inboxPayload)
          ),
          pusherClient.trigger(`private-user-${recipientId}`, "notification:new", {
            title: "New message",
            body: notificationBody,
            type: "system",
            data: {
              conversationId,
              messageId: message.id,
              kind: "chat_message",
            },
          }),
        ])

        console.log("pusher event sent", {
          event: "conversation:updated",
          channels: inboxChannels,
        })
      } catch (realtimeErr) {
        console.error("chat realtime broadcast failed", {
          conversationId,
          messageId: message.id,
          realtimeErr,
        })
      }
    }

    return res.status(201).json(message)
  } catch (err) {
    console.error("POST /chat/conversations/:id/messages error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/chat/conversations/:id/read
 * Mark unread incoming messages as read for the current user.
 */
export async function markConversationMessagesRead(
  req: AuthRequest,
  res: Response
) {
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

    const paymentAllowed = await hasConversationPaymentAccess({
      rideId: participantCheck.conversation.rideId,
      passengerId: participantCheck.conversation.passengerId,
    })
    if (!paymentAllowed) {
      return res.status(403).json(chatPaymentRequiredErrorResponse())
    }

    const unreadMessages = await prisma.message.findMany({
      where: {
        conversationId,
        senderId: { not: req.userId },
        readAt: null,
      },
      select: { id: true },
    })

    if (unreadMessages.length === 0) {
      return res.json({
        conversationId,
        readCount: 0,
        readAt: null,
        messageIds: [],
      })
    }

    const now = new Date()

    await prisma.message.updateMany({
      where: {
        id: { in: unreadMessages.map((message) => message.id) },
        readAt: null,
      },
      data: { readAt: now },
    })

    if (pusherConfigured && pusher) {
      const pusherClient = pusher
      const conversationChannel = `private-conversation-${conversationId}`

      await pusherClient.trigger(conversationChannel, "message:read", {
        conversationId,
        readerId: req.userId,
        readAt: now,
        messageIds: unreadMessages.map((message) => message.id),
      })
    }

    return res.json({
      conversationId,
      readCount: unreadMessages.length,
      readAt: now,
      messageIds: unreadMessages.map((message) => message.id),
    })
  } catch (err) {
    console.error("POST /chat/conversations/:id/read error", err)
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
      const paymentAllowed = await hasConversationPaymentAccess({
        rideId: participantCheck.conversation.rideId,
        passengerId: participantCheck.conversation.passengerId,
      })
      if (!paymentAllowed) {
        return res.status(403).json(chatPaymentRequiredErrorResponse())
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

export async function blockChatUser(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const blockedUserId = req.params.userId?.trim()
    if (!blockedUserId) {
      return res.status(400).json({ error: "user id is required" })
    }

    if (blockedUserId === req.userId) {
      return res.status(400).json({ error: "You cannot block yourself" })
    }

    const targetUser = await prisma.user.findFirst({
      where: {
        id: blockedUserId,
        deletedAt: null,
      },
      select: { id: true },
    })

    if (!targetUser) {
      return res.status(404).json({ error: "User not found" })
    }

    await prisma.blockedUser.upsert({
      where: {
        blockerId_blockedUserId: {
          blockerId: req.userId,
          blockedUserId,
        },
      },
      create: {
        blockerId: req.userId,
        blockedUserId,
      },
      update: {},
    })

    const state = await getChatBlockState(req.userId, blockedUserId)
    return res.json({
      blockedUserId,
      ...state,
    })
  } catch (err) {
    console.error("POST /chat/users/:userId/block error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function unblockChatUser(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const blockedUserId = req.params.userId?.trim()
    if (!blockedUserId) {
      return res.status(400).json({ error: "user id is required" })
    }

    await prisma.blockedUser.deleteMany({
      where: {
        blockerId: req.userId,
        blockedUserId,
      },
    })

    const state = await getChatBlockState(req.userId, blockedUserId)
    return res.json({
      blockedUserId,
      ...state,
    })
  } catch (err) {
    console.error("DELETE /chat/users/:userId/block error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
