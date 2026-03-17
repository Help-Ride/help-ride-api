import type { Request, Response } from "express"
import type { SupportTicketStatus } from "../generated/prisma/enums.js"
import prisma from "../lib/prisma.js"

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const SUPPORT_TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"]

interface UpdateSupportTicketBody {
  status?: string
  adminResponse?: string | null
}

interface CreateSupportTicketAdminBody {
  userId?: string
  relatedUserId?: string
  subject?: string
  description?: string
}

interface UpdateAppConfigBody {
  maintenanceMode?: boolean
  maintenanceMessage?: string | null
}

/**
 * GET /api/admin/support-tickets?status=open&userId=<id>&limit=50&cursor=<ticketId>
 */
export async function listSupportTicketsAdmin(req: Request, res: Response) {
  try {
    const statusParam =
      typeof req.query.status === "string" ? req.query.status : undefined
    if (statusParam && !SUPPORT_TICKET_STATUSES.includes(statusParam)) {
      return res.status(400).json({ error: "Invalid status filter" })
    }

    const userId = typeof req.query.userId === "string" ? req.query.userId : null

    const limit = Math.min(
      Number(req.query.limit ?? DEFAULT_PAGE_SIZE),
      MAX_PAGE_SIZE
    )
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null

    const tickets = await prisma.supportTicket.findMany({
      where: {
        ...(statusParam ? { status: statusParam as SupportTicketStatus } : {}),
        ...(userId ? { userId } : {}),
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
    console.error("GET /admin/support-tickets error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/admin/support-tickets/:id
 */
export async function getSupportTicketAdmin(req: Request, res: Response) {
  try {
    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "ticket id is required" })
    }

    const ticket = await prisma.supportTicket.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
      },
    })

    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found" })
    }

    return res.json(ticket)
  } catch (err) {
    console.error("GET /admin/support-tickets/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/admin/support-tickets
 */
export async function createSupportTicketAdmin(req: Request, res: Response) {
  try {
    const { userId, relatedUserId, subject, description } =
      (req.body ?? {}) as CreateSupportTicketAdminBody

    const resolvedUserId =
      typeof userId === "string" && userId.trim().length > 0
        ? userId.trim()
        : typeof relatedUserId === "string" && relatedUserId.trim().length > 0
          ? relatedUserId.trim()
          : null

    if (!resolvedUserId) {
      return res
        .status(400)
        .json({ error: "userId (or relatedUserId) is required" })
    }

    if (!subject || typeof subject !== "string") {
      return res.status(400).json({ error: "subject is required" })
    }
    if (!description || typeof description !== "string") {
      return res.status(400).json({ error: "description is required" })
    }

    const user = await prisma.user.findUnique({
      where: { id: resolvedUserId },
      select: { id: true },
    })
    if (!user) {
      return res.status(404).json({ error: "User not found for ticket" })
    }

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: resolvedUserId,
        subject: subject.trim(),
        description: description.trim(),
      },
    })

    return res.status(201).json({ ticket })
  } catch (err) {
    console.error("POST /admin/support-tickets error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * PATCH /api/admin/support-tickets/:id
 * Body: { status?, adminResponse? }
 */
export async function updateSupportTicketAdmin(req: Request, res: Response) {
  try {
    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "ticket id is required" })
    }

    const { status, adminResponse } = (req.body ?? {}) as UpdateSupportTicketBody

    if (status && !SUPPORT_TICKET_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Invalid status" })
    }

    if (
      typeof adminResponse !== "undefined" &&
      adminResponse !== null &&
      typeof adminResponse !== "string"
    ) {
      return res.status(400).json({ error: "Invalid adminResponse" })
    }

    if (!status && typeof adminResponse === "undefined") {
      return res.status(400).json({ error: "No updates provided" })
    }

    const ticket = await prisma.supportTicket.findUnique({ where: { id } })
    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found" })
    }

    const updated = await prisma.supportTicket.update({
      where: { id },
      data: {
        ...(status ? { status: status as SupportTicketStatus } : {}),
        ...(typeof adminResponse !== "undefined" ? { adminResponse } : {}),
      },
    })

    return res.json(updated)
  } catch (err) {
    console.error("PATCH /admin/support-tickets/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/admin/support-tickets/:id/resolve
 * Body: { resolution: string }
 */
export async function resolveSupportTicketAdmin(req: Request, res: Response) {
  try {
    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "ticket id is required" })
    }

    const resolution = (req.body ?? {}).resolution
    if (!resolution || typeof resolution !== "string") {
      return res.status(400).json({ error: "resolution is required" })
    }

    const ticket = await prisma.supportTicket.findUnique({ where: { id } })
    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found" })
    }

    const updated = await prisma.supportTicket.update({
      where: { id },
      data: {
        status: "resolved",
        adminResponse: resolution.trim(),
      },
    })

    return res.json({ ticket: updated })
  } catch (err) {
    console.error("POST /admin/support-tickets/:id/resolve error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/admin/app-config
 */
export async function getAppConfig(req: Request, res: Response) {
  try {
    const config = await prisma.appConfig.upsert({
      where: { id: "global" },
      update: {},
      create: {
        id: "global",
        maintenanceMode: false,
      },
    })

    return res.json(config)
  } catch (err) {
    console.error("GET /admin/app-config error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * PATCH /api/admin/app-config
 * Body: { maintenanceMode?, maintenanceMessage? }
 */
export async function updateAppConfig(req: Request, res: Response) {
  try {
    const { maintenanceMode, maintenanceMessage } =
      (req.body ?? {}) as UpdateAppConfigBody

    if (
      typeof maintenanceMode === "undefined" &&
      typeof maintenanceMessage === "undefined"
    ) {
      return res.status(400).json({ error: "No updates provided" })
    }

    if (
      typeof maintenanceMode !== "undefined" &&
      typeof maintenanceMode !== "boolean"
    ) {
      return res.status(400).json({ error: "maintenanceMode must be boolean" })
    }

    if (
      typeof maintenanceMessage !== "undefined" &&
      maintenanceMessage !== null &&
      typeof maintenanceMessage !== "string"
    ) {
      return res.status(400).json({ error: "maintenanceMessage must be string" })
    }

    const config = await prisma.appConfig.upsert({
      where: { id: "global" },
      update: {
        ...(typeof maintenanceMode === "boolean"
          ? { maintenanceMode }
          : {}),
        ...(typeof maintenanceMessage !== "undefined"
          ? { maintenanceMessage }
          : {}),
      },
      create: {
        id: "global",
        maintenanceMode: maintenanceMode ?? false,
        maintenanceMessage: maintenanceMessage ?? null,
      },
    })

    return res.json(config)
  } catch (err) {
    console.error("PATCH /admin/app-config error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
