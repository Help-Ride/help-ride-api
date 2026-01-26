// src/controllers/fixedRoutePrice.controller.ts
import type { Response } from "express"
import prisma from "../lib/prisma.js"
import { AuthRequest } from "../middleware/auth.js"
import { Prisma } from "../generated/prisma/client.js"

interface CreateFixedRoutePriceBody {
  fromCity?: string
  toCity?: string
  pricePerSeat?: number
  isActive?: boolean
}

interface UpdateFixedRoutePriceBody {
  fromCity?: string
  toCity?: string
  pricePerSeat?: number
  isActive?: boolean
}

function normalizeCity(value: string) {
  return value.trim().toLowerCase()
}

/**
 * POST /api/fixed-route-prices
 * Create a fixed per-seat price for a route
 */
export async function createFixedRoutePrice(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { fromCity, toCity, pricePerSeat, isActive } =
      (req.body ?? {}) as CreateFixedRoutePriceBody

    if (
      !fromCity ||
      !toCity ||
      typeof pricePerSeat !== "number" ||
      pricePerSeat < 0
    ) {
      return res.status(400).json({
        error: "fromCity, toCity, and non-negative pricePerSeat are required",
      })
    }

    const created = await prisma.fixedRoutePrice.create({
      data: {
        fromCity: normalizeCity(fromCity),
        toCity: normalizeCity(toCity),
        pricePerSeat: new Prisma.Decimal(pricePerSeat),
        isActive: isActive ?? true,
      },
    })

    return res.status(201).json(created)
  } catch (err) {
    console.error("POST /fixed-route-prices error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/fixed-route-prices
 * List fixed route prices
 */
export async function listFixedRoutePrices(req: AuthRequest, res: Response) {
  try {
    const { fromCity, toCity, isActive } = req.query as {
      fromCity?: string
      toCity?: string
      isActive?: string
    }

    const where: any = {}
    if (fromCity) {
      where.fromCity = normalizeCity(fromCity)
    }
    if (toCity) {
      where.toCity = normalizeCity(toCity)
    }
    if (isActive !== undefined) {
      where.isActive = isActive === "true"
    }

    const routes = await prisma.fixedRoutePrice.findMany({
      where,
      orderBy: { createdAt: "desc" },
    })

    return res.json(routes)
  } catch (err) {
    console.error("GET /fixed-route-prices error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * PUT /api/fixed-route-prices/:id
 * Update a fixed route price
 */
export async function updateFixedRoutePrice(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "id is required" })
    }

    const body = (req.body ?? {}) as UpdateFixedRoutePriceBody
    const updateData: any = {}

    if (body.fromCity) {
      updateData.fromCity = normalizeCity(body.fromCity)
    }
    if (body.toCity) {
      updateData.toCity = normalizeCity(body.toCity)
    }
    if (body.pricePerSeat !== undefined) {
      if (typeof body.pricePerSeat !== "number" || body.pricePerSeat < 0) {
        return res
          .status(400)
          .json({ error: "pricePerSeat must be a non-negative number" })
      }
      updateData.pricePerSeat = new Prisma.Decimal(body.pricePerSeat)
    }
    if (body.isActive !== undefined) {
      updateData.isActive = body.isActive
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" })
    }

    const updated = await prisma.fixedRoutePrice.update({
      where: { id },
      data: updateData,
    })

    return res.json(updated)
  } catch (err) {
    console.error("PUT /fixed-route-prices/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * DELETE /api/fixed-route-prices/:id
 * Delete a fixed route price
 */
export async function deleteFixedRoutePrice(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: "id is required" })
    }

    await prisma.fixedRoutePrice.delete({ where: { id } })
    return res.status(204).send()
  } catch (err) {
    console.error("DELETE /fixed-route-prices/:id error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
