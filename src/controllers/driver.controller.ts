// src/controllers/driver.controller.ts
import type { Response } from "express"
import { z } from "zod"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"

// Zod schema for driver profile validation
const driverProfileSchema = z.object({
  carMake: z
    .string()
    .min(1, "Car make must not be empty")
    .max(50, "Car make must not exceed 50 characters")
    .optional(),
  carModel: z
    .string()
    .min(1, "Car model must not be empty")
    .max(50, "Car model must not exceed 50 characters")
    .optional(),
  carYear: z
    .string()
    .regex(/^\d{4}$/, "Car year must be a 4-digit number")
    .refine(
      (year) => {
        const yearNum = parseInt(year, 10)
        return yearNum >= 1900 && yearNum <= 2100
      },
      { message: "Car year must be between 1900 and 2100" }
    )
    .optional(),
  carColor: z
    .string()
    .min(1, "Car color must not be empty")
    .max(30, "Car color must not exceed 30 characters")
    .optional(),
  plateNumber: z
    .string()
    .min(1, "Plate number must not be empty")
    .max(20, "Plate number must not exceed 20 characters")
    .regex(
      /^[A-Z0-9\-\s]+$/i,
      "Plate number must contain only letters, numbers, hyphens, and spaces"
    )
    .optional(),
  licenseNumber: z
    .string()
    .min(1, "License number must not be empty")
    .max(30, "License number must not exceed 30 characters")
    .regex(
      /^[A-Z0-9\-]+$/i,
      "License number must contain only letters, numbers, and hyphens"
    )
    .optional(),
  insuranceInfo: z
    .string()
    .min(1, "Insurance info must not be empty")
    .max(200, "Insurance info must not exceed 200 characters")
    .optional(),
})

// Helper function to format Zod validation errors
function formatValidationErrors(error: z.ZodError) {
  return error.issues.map((err) => ({
    field: err.path.join("."),
    message: err.message,
  }))
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

    // Validate request body with Zod
    const validationResult = driverProfileSchema.safeParse(req.body ?? {})

    if (!validationResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: formatValidationErrors(validationResult.error),
      })
    }

    const body = validationResult.data

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

    // Validate request body with Zod
    const validationResult = driverProfileSchema.safeParse(req.body ?? {})

    if (!validationResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: formatValidationErrors(validationResult.error),
      })
    }

    const body = validationResult.data

    // Build update data, allowing fields to be cleared (set to null or empty string)
    const updateData: Record<string, any> = {};
    const fields: (keyof typeof body)[] = [
      "carMake",
      "carModel",
      "carYear",
      "carColor",
      "plateNumber",
      "licenseNumber",
      "insuranceInfo",
    ];
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        updateData[field] = body[field];
      } else {
        updateData[field] = existing[field];
      }
    }

    const updated = await prisma.driverProfile.update({
      where: { userId: id },
      data: updateData,
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
