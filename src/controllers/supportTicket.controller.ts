import type { Response } from "express"
import { randomUUID } from "crypto"
import type { SupportTicketStatus } from "../generated/prisma/enums.js"
import prisma from "../lib/prisma.js"
import { getDownloadUrl, getUploadUrl } from "../lib/s3.js"
import { AuthRequest } from "../middleware/auth.js"

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const SUPPORT_TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"]

interface CreateSupportTicketBody {
  subject?: string
  description?: string
  attachmentKey?: string
}

interface PresignSupportTicketAttachmentBody {
  fileName?: string
  mimeType?: string
}

function buildSupportTicketAttachmentKey(userId: string, fileName: string) {
  const safeFileName = fileName.replace(/[^\w.\-]/g, "_")
  return `support-tickets/${userId}/attachments/${randomUUID()}-${safeFileName}`
}

function isValidSupportTicketAttachmentKey(userId: string, key: string) {
  return key.startsWith(`support-tickets/${userId}/attachments/`)
}

async function serializeSupportTicket<
  T extends { attachmentS3Key: string | null }
>(ticket: T) {
  return {
    ...ticket,
    attachmentUrl: ticket.attachmentS3Key
      ? await getDownloadUrl(ticket.attachmentS3Key)
      : null,
  }
}

/**
 * POST /api/support-tickets/attachments/presign
 * Body: { fileName, mimeType }
 */
export async function createSupportTicketAttachmentPresign(
  req: AuthRequest,
  res: Response
) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { fileName, mimeType } = (req.body ??
      {}) as PresignSupportTicketAttachmentBody

    if (!fileName || !mimeType) {
      return res.status(400).json({
        error: "fileName and mimeType are required",
      })
    }

    if (!mimeType.toLowerCase().startsWith("image/")) {
      return res.status(400).json({
        error: "mimeType must be an image/* type",
      })
    }

    const attachmentKey = buildSupportTicketAttachmentKey(req.userId, fileName)
    const uploadUrl = await getUploadUrl({
      key: attachmentKey,
      contentType: mimeType,
    })

    return res.status(201).json({
      uploadUrl,
      attachmentKey,
    })
  } catch (err) {
    console.error("POST /support-tickets/attachments/presign error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/support-tickets
 * Body: { subject, description }
 */
export async function createSupportTicket(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { subject, description, attachmentKey } =
      (req.body ?? {}) as CreateSupportTicketBody

    if (!subject || typeof subject !== "string") {
      return res.status(400).json({ error: "subject is required" })
    }

    if (!description || typeof description !== "string") {
      return res.status(400).json({ error: "description is required" })
    }

    if (
      typeof attachmentKey !== "undefined" &&
      attachmentKey !== null &&
      (typeof attachmentKey !== "string" ||
        !isValidSupportTicketAttachmentKey(req.userId, attachmentKey))
    ) {
      return res.status(400).json({ error: "attachmentKey is invalid" })
    }

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.userId,
        subject: subject.trim(),
        description: description.trim(),
        attachmentS3Key: attachmentKey?.trim() || null,
      },
    })

    return res.status(201).json(await serializeSupportTicket(ticket))
  } catch (err) {
    console.error("POST /support-tickets error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/support-tickets?status=open&limit=25&cursor=<ticketId>
 */
export async function listSupportTickets(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const statusParam =
      typeof req.query.status === "string" ? req.query.status : undefined
    if (statusParam && !SUPPORT_TICKET_STATUSES.includes(statusParam)) {
      return res.status(400).json({ error: "Invalid status filter" })
    }

    const limit = Math.min(
      Number(req.query.limit ?? DEFAULT_PAGE_SIZE),
      MAX_PAGE_SIZE
    )
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null

    const tickets = await prisma.supportTicket.findMany({
      where: {
        userId: req.userId,
        ...(statusParam ? { status: statusParam as SupportTicketStatus } : {}),
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

    const nextCursor = tickets.length > 0 ? tickets[tickets.length - 1].id : null

    return res.json({
      tickets: await Promise.all(tickets.map((ticket) => serializeSupportTicket(ticket))),
      nextCursor,
    })
  } catch (err) {
    console.error("GET /support-tickets error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/support-tickets/:id
 */
export async function getSupportTicket(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "ticket id is required" })
    }

    const ticket = await prisma.supportTicket.findUnique({ where: { id } })
    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found" })
    }

    if (ticket.userId !== req.userId) {
      return res.status(403).json({ error: "Forbidden" })
    }

    return res.json(await serializeSupportTicket(ticket))
  } catch (err) {
    console.error("GET /support-tickets/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
