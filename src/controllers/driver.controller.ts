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

const DEFAULT_EARNINGS_PAGE_SIZE = 25
const MAX_EARNINGS_PAGE_SIZE = 100

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

    // Build update data, allowing fields to be cleared (set to null or empty string)
    const updateData: Record<string, any> = {}
    const fields: (keyof DriverProfileBody)[] = [
      "carMake",
      "carModel",
      "carYear",
      "carColor",
      "plateNumber",
      "licenseNumber",
      "insuranceInfo",
    ]
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        updateData[field] = body[field]
      } else {
        updateData[field] = existing[field]
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

/**
 * PUT /api/drivers/:id/vehicles/:vehicleId
 * Compatibility endpoint for frontend "vehicle management".
 * Backed by the single DriverProfile record (vehicleId = driverProfile.id).
 */
export async function updateDriverVehicle(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id, vehicleId } = req.params
    if (!id || !vehicleId) {
      return res.status(400).json({ error: "id and vehicleId are required" })
    }

    if (id !== req.userId) {
      return res.status(403).json({
        error: "Forbidden",
        message: "You can only update your own vehicles",
      })
    }

    const profile = await prisma.driverProfile.findUnique({
      where: { userId: id },
      select: { id: true },
    })

    if (!profile) {
      return res.status(404).json({ error: "Driver profile not found" })
    }

    if (profile.id !== vehicleId) {
      return res.status(404).json({ error: "Vehicle not found" })
    }

    return updateDriverProfile(req, res)
  } catch (err) {
    console.error("PUT /api/drivers/:id/vehicles/:vehicleId error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * DELETE /api/drivers/:id/vehicles/:vehicleId
 * Removes the driver's single vehicle (DriverProfile).
 */
export async function deleteDriverVehicle(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { id, vehicleId } = req.params
    if (!id || !vehicleId) {
      return res.status(400).json({ error: "id and vehicleId are required" })
    }

    if (id !== req.userId) {
      return res.status(403).json({
        error: "Forbidden",
        message: "You can only delete your own vehicles",
      })
    }

    const profile = await prisma.driverProfile.findUnique({
      where: { userId: id },
      select: { id: true },
    })

    if (!profile) {
      return res.status(404).json({ error: "Driver profile not found" })
    }

    if (profile.id !== vehicleId) {
      return res.status(404).json({ error: "Vehicle not found" })
    }

    const activeRidesCount = await prisma.ride.count({
      where: {
        driverId: id,
        status: { in: ["open", "ongoing"] },
      },
    })

    if (activeRidesCount > 0) {
      return res.status(409).json({
        error: "Cannot delete vehicle while you have active rides",
      })
    }

    await prisma.driverProfile.delete({ where: { userId: id } })
    return res.status(204).send()
  } catch (err) {
    console.error("DELETE /api/drivers/:id/vehicles/:vehicleId error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/drivers/me/summary
 * Authenticated driver's rides + earnings summary.
 */
export async function getDriverSummary(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const [
      totalRides,
      completedRides,
      pendingAgg,
      paidAgg,
      refundedAgg,
      failedAgg,
    ] = await Promise.all([
      prisma.ride.count({
        where: { driverId: req.userId },
      }),
      prisma.ride.count({
        where: { driverId: req.userId, status: "completed" },
      }),
      prisma.payment.aggregate({
        where: {
          status: "pending",
          booking: { ride: { driverId: req.userId } },
        },
        _count: { _all: true },
        _sum: {
          amountCents: true,
          platformFeeCents: true,
        },
      }),
      prisma.payment.aggregate({
        where: {
          status: { in: ["succeeded", "paid"] },
          booking: { ride: { driverId: req.userId } },
        },
        _count: { _all: true },
        _sum: {
          amountCents: true,
          platformFeeCents: true,
        },
      }),
      prisma.payment.aggregate({
        where: {
          status: "refunded",
          booking: { ride: { driverId: req.userId } },
        },
        _count: { _all: true },
        _sum: {
          amountCents: true,
          platformFeeCents: true,
        },
      }),
      prisma.payment.aggregate({
        where: {
          status: "failed",
          booking: { ride: { driverId: req.userId } },
        },
        _count: { _all: true },
        _sum: {
          amountCents: true,
          platformFeeCents: true,
        },
      }),
    ])

    const toDriverNet = (amountCents: number | null, feeCents: number | null) =>
      (amountCents ?? 0) - (feeCents ?? 0)

    const pendingDriverEarningsCents = toDriverNet(
      pendingAgg._sum.amountCents,
      pendingAgg._sum.platformFeeCents
    )
    const paidDriverEarningsCents = toDriverNet(
      paidAgg._sum.amountCents,
      paidAgg._sum.platformFeeCents
    )
    const refundedDriverEarningsCents = toDriverNet(
      refundedAgg._sum.amountCents,
      refundedAgg._sum.platformFeeCents
    )
    const failedDriverEarningsCents = toDriverNet(
      failedAgg._sum.amountCents,
      failedAgg._sum.platformFeeCents
    )

    return res.json({
      rides: {
        total: totalRides,
        completed: completedRides,
      },
      earnings: {
        pending: {
          paymentsCount: pendingAgg._count._all,
          amountCents: pendingDriverEarningsCents,
        },
        paid: {
          paymentsCount: paidAgg._count._all,
          amountCents: paidDriverEarningsCents,
        },
        refunded: {
          paymentsCount: refundedAgg._count._all,
          amountCents: refundedDriverEarningsCents,
        },
        failed: {
          paymentsCount: failedAgg._count._all,
          amountCents: failedDriverEarningsCents,
        },
        netCollectedCents: paidDriverEarningsCents - refundedDriverEarningsCents,
      },
    })
  } catch (err) {
    console.error("GET /api/drivers/me/summary error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * GET /api/drivers/me/earnings?status=succeeded&limit=25&cursor=<paymentId>
 * Authenticated driver's payment records ledger.
 */
export async function getDriverEarnings(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const status =
      typeof req.query.status === "string" && req.query.status.length > 0
        ? req.query.status
        : null
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null
    const limit = Math.min(
      Number(req.query.limit ?? DEFAULT_EARNINGS_PAGE_SIZE),
      MAX_EARNINGS_PAGE_SIZE
    )

    const allowedStatuses = new Set([
      "pending",
      "succeeded",
      "failed",
      "refunded",
      "paid",
    ])

    if (status && !allowedStatuses.has(status)) {
      return res.status(400).json({ error: "Invalid status filter" })
    }

    const payments = await prisma.payment.findMany({
      where: {
        ...(status ? { status: status as any } : {}),
        booking: {
          ride: {
            driverId: req.userId,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take:
        Number.isFinite(limit) && limit > 0
          ? limit
          : DEFAULT_EARNINGS_PAGE_SIZE,
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
      select: {
        id: true,
        paymentIntentId: true,
        amountCents: true,
        platformFeeCents: true,
        currency: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        booking: {
          select: {
            id: true,
            status: true,
            paymentStatus: true,
            seatsBooked: true,
            passenger: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            ride: {
              select: {
                id: true,
                fromCity: true,
                toCity: true,
                startTime: true,
                status: true,
              },
            },
          },
        },
      },
    })

    const nextCursor = payments.length > 0 ? payments[payments.length - 1].id : null

    return res.json({
      payments: payments.map((payment) => ({
        ...payment,
        driverEarningsCents: payment.amountCents - payment.platformFeeCents,
      })),
      nextCursor,
    })
  } catch (err) {
    console.error("GET /api/drivers/me/earnings error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
