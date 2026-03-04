// src/controllers/driverDocument.controller.ts
import type { Response } from "express"
import { randomUUID } from "crypto"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"
import { getUploadUrl, getDownloadUrl } from "../lib/s3.js"

interface PresignBody {
  type?: string
  fileName?: string
  mimeType?: string
}

const DRIVER_DOCUMENT_TYPES = ["license", "insurance", "ownership", "other"] as const
type DriverDocumentType = (typeof DRIVER_DOCUMENT_TYPES)[number]

const DRIVER_DOCUMENT_TYPE_ALIASES: Record<string, DriverDocumentType> = {
  registration: "ownership",
}

function resolveCurrentDriverUserId(req: AuthRequest, res: Response): string | null {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthorized" })
    return null
  }

  const { id: userIdParam } = req.params
  if (userIdParam && userIdParam !== req.userId) {
    res.status(403).json({
      error: "You can only access documents for your own account",
    })
    return null
  }

  return req.userId
}

function normalizeDriverDocumentType(input?: string): DriverDocumentType | null {
  if (!input) return null

  const type = input.trim().toLowerCase()
  if (DRIVER_DOCUMENT_TYPES.includes(type as DriverDocumentType)) {
    return type as DriverDocumentType
  }

  return DRIVER_DOCUMENT_TYPE_ALIASES[type] ?? null
}

/**
 * POST /api/drivers/me/documents/presign
 * Legacy alias: POST /api/drivers/:id/documents/presign
 * Returns a presigned S3 URL + creates a pending DriverDocument row
 */
export async function createDriverDocumentPresign(
  req: AuthRequest,
  res: Response
) {
  try {
    const userId = resolveCurrentDriverUserId(req, res)
    if (!userId) {
      return
    }

    const { type: rawType, fileName, mimeType } = (req.body ?? {}) as PresignBody
    const type = normalizeDriverDocumentType(rawType)

    if (!rawType || !fileName || !mimeType) {
      return res.status(400).json({
        error: "type, fileName, and mimeType are required",
      })
    }
    if (!type) {
      return res.status(400).json({
        error:
          "Invalid type. Allowed: license, insurance, ownership, other (registration is accepted as ownership).",
      })
    }

    const docId = randomUUID()
    const safeFileName = fileName.replace(/[^\w.\-]/g, "_")
    const key = `drivers/${userId}/${type}/${docId}-${safeFileName}`

    const doc = await prisma.driverDocument.create({
      data: {
        id: docId,
        userId,
        type,
        s3Key: key,
        fileName: safeFileName,
        mimeType,
        status: "pending",
      },
    })

    const uploadUrl = await getUploadUrl({
      key,
      contentType: mimeType,
    })

    return res.status(201).json({
      uploadUrl,
      document: {
        id: doc.id,
        type: doc.type,
        status: doc.status,
        fileName: doc.fileName,
        s3Key: doc.s3Key,
      },
    })
  } catch (err) {
    console.error("POST /drivers/:id/documents/presign error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/drivers/me/documents
 * Legacy alias: GET /api/drivers/:id/documents
 * List driver documents for current user
 */
export async function listDriverDocuments(req: AuthRequest, res: Response) {
  try {
    const userId = resolveCurrentDriverUserId(req, res)
    if (!userId) {
      return
    }

    const docs = await prisma.driverDocument.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    })

    // If you don't want to generate signed URLs here, remove getDownloadUrl
    const withUrls = await Promise.all(
      docs.map(async (d) => ({
        id: d.id,
        type: d.type,
        status: d.status,
        fileName: d.fileName,
        createdAt: d.createdAt,
        downloadUrl: await getDownloadUrl(d.s3Key),
      }))
    )

    return res.json(withUrls)
  } catch (err) {
    console.error("GET /drivers/:id/documents error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
