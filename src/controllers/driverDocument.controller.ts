// src/controllers/driverDocument.controller.ts
import type { Response } from "express"
import { randomUUID } from "crypto"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"
import { getUploadUrl, getDownloadUrl } from "../lib/s3.js"

interface PresignBody {
  type?: "license" | "insurance" | "ownership" | "other"
  fileName?: string
  mimeType?: string
}

/**
 * POST /api/drivers/:id/documents/presign
 * Returns a presigned S3 URL + creates a pending DriverDocument row
 */
export async function createDriverDocumentPresign(
  req: AuthRequest,
  res: Response
) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id: userIdParam } = req.params
    if (!userIdParam) {
      return res.status(400).json({ error: "user id is required in path" })
    }

    // Only owner can upload their docs (you can extend later for admin)
    if (userIdParam !== req.userId) {
      return res.status(403).json({
        error: "You can only upload documents for your own account",
      })
    }

    const { type, fileName, mimeType } = (req.body ?? {}) as PresignBody

    if (!type || !fileName || !mimeType) {
      return res.status(400).json({
        error: "type, fileName, and mimeType are required",
      })
    }

    const docId = randomUUID()
    const safeFileName = fileName.replace(/[^\w.\-]/g, "_")
    const key = `drivers/${req.userId}/${type}/${docId}-${safeFileName}`

    const doc = await prisma.driverDocument.create({
      data: {
        id: docId,
        userId: req.userId,
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
 * GET /api/drivers/:id/documents
 * List driver documents for current user
 */
export async function listDriverDocuments(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id: userIdParam } = req.params
    if (!userIdParam) {
      return res.status(400).json({ error: "user id is required in path" })
    }

    if (userIdParam !== req.userId) {
      return res.status(403).json({
        error: "You can only view your own documents",
      })
    }

    const docs = await prisma.driverDocument.findMany({
      where: { userId: userIdParam },
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
