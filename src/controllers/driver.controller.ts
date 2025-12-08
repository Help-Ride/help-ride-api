// src/controllers/driver.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"

interface DriverProfileBody {
  carMake?: string
  carModel?: string
  carYear?: string
  carColor?: string
  plateNumber?: string
  licenseNumber?: string
  insuranceInfo?: string
}

/**
 * POST /api/drivers
 * Create driver profile for logged-in user
 */
export async function createDriverProfile(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const existing = await prisma.driverProfile.findUnique({
      where: { userId: req.userId },
    })

    if (existing) {
      return res.status(400).json({
        error: "Driver profile already exists for this user",
      })
    }

    const body = (req.body ?? {}) as DriverProfileBody

    const profile = await prisma.driverProfile.create({
      data: {
        userId: req.userId,
        carMake: body.carMake ?? null,
        carModel: body.carModel ?? null,
        carYear: body.carYear ?? null,
        carColor: body.carColor ?? null,
        plateNumber: body.plateNumber ?? null,
        licenseNumber: body.licenseNumber ?? null,
        insuranceInfo: body.insuranceInfo ?? null,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            providerAvatarUrl: true,
          },
        },
      },
    })

    return res.status(201).json(profile)
  } catch (err) {
    console.error("POST /api/drivers error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/drivers/:id
 * :id = userId
 * Public: passengers can view driver info
 */
export async function getDriverProfile(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params

    if (!id) {
      return res.status(400).json({ error: "Driver user id is required" })
    }

    const profile = await prisma.driverProfile.findUnique({
      where: { userId: id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            providerAvatarUrl: true,
          },
        },
      },
    })

    if (!profile) {
      return res.status(404).json({ error: "Driver profile not found" })
    }

    return res.json(profile)
  } catch (err) {
    console.error("GET /api/drivers/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * PUT /api/drivers/:id
 * :id = userId
 * Only owner can update (later you can add admin override)
 */
export async function updateDriverProfile(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "Driver user id is required" })
    }

    if (id !== req.userId) {
      return res.status(403).json({
        error: "Forbidden",
        message: "You can only update your own driver profile",
      })
    }

    const existing = await prisma.driverProfile.findUnique({
      where: { userId: id },
    })

    if (!existing) {
      return res.status(404).json({ error: "Driver profile not found" })
    }

    const body = (req.body ?? {}) as DriverProfileBody

    const updated = await prisma.driverProfile.update({
      where: { userId: id },
      data: {
        carMake: body.carMake ?? existing.carMake,
        carModel: body.carModel ?? existing.carModel,
        carYear: body.carYear ?? existing.carYear,
        carColor: body.carColor ?? existing.carColor,
        plateNumber: body.plateNumber ?? existing.plateNumber,
        licenseNumber: body.licenseNumber ?? existing.licenseNumber,
        insuranceInfo: body.insuranceInfo ?? existing.insuranceInfo,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            providerAvatarUrl: true,
          },
        },
      },
    })

    return res.json(updated)
  } catch (err) {
    console.error("PUT /api/drivers/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
