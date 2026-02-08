import type { Response } from "express"
import type { SupportTicketStatus } from "../generated/prisma/enums.js"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const SUPPORT_TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"]

interface CreateSupportTicketBody {
  subject?: string
  description?: string
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

    const { subject, description } = (req.body ?? {}) as CreateSupportTicketBody

    if (!subject || typeof subject !== "string") {
      return res.status(400).json({ error: "subject is required" })
    }

    if (!description || typeof description !== "string") {
      return res.status(400).json({ error: "description is required" })
    }

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.userId,
        subject: subject.trim(),
        description: description.trim(),
      },
    })

    return res.status(201).json(ticket)
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

    return res.json({ tickets, nextCursor })
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

    return res.json(ticket)
  } catch (err) {
    console.error("GET /support-tickets/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
