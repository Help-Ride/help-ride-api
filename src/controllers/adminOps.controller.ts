import type { Request, Response } from "express"
import Stripe from "stripe"
import type {
  BookingStatus,
  DriverDocumentStatus,
  PaymentStatus,
  RideRequestStatus,
  RideStatus,
} from "../generated/prisma/enums.js"
import prisma from "../lib/prisma.js"
import { getDownloadUrl } from "../lib/s3.js"
import { initiateBookingRefundIfPaid } from "../lib/refunds.js"
import { stripe } from "../lib/stripe.js"
import { notifyUser, notifyUsersByIds } from "../lib/notifications.js"

const DEFAULT_PAGE = 1
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

const ACTIVE_BOOKING_STATUSES = new Set<BookingStatus>([
  "pending",
  "confirmed",
  "ACCEPTED",
  "PAYMENT_PENDING",
  "CONFIRMED",
])

const CONFIRMED_BOOKING_STATUSES = new Set<BookingStatus>([
  "confirmed",
  "ACCEPTED",
  "PAYMENT_PENDING",
  "CONFIRMED",
])

const RIDE_OPEN_STATUSES = new Set<RideStatus>(["open", "ongoing"])

const OFFER_ACTIVE_STATUSES = new Set(["SENT", "pending"])
const OFFER_REOPENABLE_STATUSES = new Set(["REJECTED", "EXPIRED", "rejected", "cancelled"])
const REQUEST_OPEN_STATUSES = new Set(["PENDING", "OFFERING", "pending"])

const RIDE_AMENITIES = [
  "ac",
  "music",
  "wifi",
  "pet_friendly",
  "luggage_space",
  "child_seat",
] as const

const DRIVER_VERIFICATION_FILTERS = new Set([
  "pending",
  "approved",
  "rejected",
  "suspended",
])

interface Pagination {
  page: number
  limit: number
  skip: number
}

interface CsvRow {
  [key: string]: string | number | boolean | null
}

interface AdminRideInput {
  clientRowId?: string
  driverId?: string
  fromCity?: string
  fromLat?: number
  fromLng?: number
  toCity?: string
  toLat?: number
  toLng?: number
  startTime?: string
  arrivalTime?: string | null
  stops?: string[] | null
  amenities?: string[] | null
  additionalNotes?: string | null
  pricePerSeat?: number
  seatsTotal?: number
  status?: string
}

function parsePagination(req: Request): Pagination {
  const pageRaw = Number(req.query.page ?? DEFAULT_PAGE)
  const limitRaw = Number(req.query.limit ?? DEFAULT_LIMIT)

  const page =
    Number.isFinite(pageRaw) && pageRaw > 0
      ? Math.floor(pageRaw)
      : DEFAULT_PAGE
  const limitCandidate =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : DEFAULT_LIMIT
  const limit = Math.min(limitCandidate, MAX_LIMIT)

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  }
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase()
    if (lowered === "true") return true
    if (lowered === "false") return false
  }
  return null
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return parsed
}

function parseDateWindow(dateFrom: unknown, dateTo: unknown) {
  const from = parseIsoDate(dateFrom)
  const to = parseIsoDate(dateTo)
  if (!from && !to) {
    return null
  }

  return {
    ...(from ? { gte: from } : {}),
    ...(to ? { lte: to } : {}),
  }
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  if (!value.every((item) => typeof item === "string")) {
    return null
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0)
}

function isFiniteLatitude(value: number) {
  return Number.isFinite(value) && value >= -90 && value <= 90
}

function isFiniteLongitude(value: number) {
  return Number.isFinite(value) && value >= -180 && value <= 180
}

function normalizeRideStatusInput(value?: string): RideStatus | null {
  if (!value) {
    return null
  }
  const lowered = value.trim().toLowerCase()
  if (lowered === "in_progress") {
    return "ongoing"
  }
  if (
    lowered === "open" ||
    lowered === "ongoing" ||
    lowered === "completed" ||
    lowered === "cancelled"
  ) {
    return lowered as RideStatus
  }
  return null
}

function normalizeBookingStatusFilter(value?: string) {
  if (!value) return null
  const lowered = value.trim().toLowerCase()
  switch (lowered) {
    case "pending":
      return { status: "pending" as BookingStatus }
    case "confirmed":
      return {
        status: {
          in: ["confirmed", "ACCEPTED", "PAYMENT_PENDING", "CONFIRMED"] as BookingStatus[],
        },
      }
    case "completed":
      return { status: "completed" as BookingStatus }
    case "cancelled":
      return {
        status: {
          in: ["cancelled_by_passenger", "cancelled_by_driver"] as BookingStatus[],
        },
      }
    case "no_show":
      return { id: "__no_show_unsupported__" }
    default:
      return "invalid"
  }
}

function normalizePaymentStatusFilter(value?: string) {
  if (!value) return null
  const lowered = value.trim().toLowerCase()
  switch (lowered) {
    case "paid":
      return { in: ["paid", "succeeded"] as PaymentStatus[] }
    case "pending":
      return { in: ["pending", "unpaid"] as PaymentStatus[] }
    case "refunded":
      return "refunded" as PaymentStatus
    case "failed":
      return "failed" as PaymentStatus
    default:
      return "invalid"
  }
}

function normalizeRideRequestStatusFilter(value?: string) {
  if (!value) return null
  const lowered = value.trim().toLowerCase()
  switch (lowered) {
    case "pending":
      return { in: ["PENDING", "OFFERING", "pending"] as RideRequestStatus[] }
    case "matched":
      return { in: ["matched", "ACCEPTED"] as RideRequestStatus[] }
    case "accepted":
      return { in: ["ACCEPTED", "matched"] as RideRequestStatus[] }
    case "rejected":
      return { in: ["CANCELLED", "cancelled"] as RideRequestStatus[] }
    default:
      return "invalid"
  }
}

function normalizeRideRequestStatusUpdate(value?: string): RideRequestStatus | null {
  if (!value) return null
  const lowered = value.trim().toLowerCase()
  switch (lowered) {
    case "awaiting_payment":
      return "matched"
    case "matched":
      return "matched"
    case "accepted":
      return "ACCEPTED"
    case "rejected":
      return "cancelled"
    case "pending":
      return "PENDING"
    default:
      return null
  }
}

function extractDriverDocuments(
  profile: any
): Array<{ status: DriverDocumentStatus; [key: string]: unknown }> {
  if (Array.isArray(profile?.documents)) {
    return profile.documents
  }
  if (Array.isArray(profile?.user?.driverDocuments)) {
    return profile.user.driverDocuments
  }
  return []
}

function extractDriverConflictRides(profile: any): Array<{ id: string }> {
  if (Array.isArray(profile?.rides)) {
    return profile.rides
  }
  if (Array.isArray(profile?.user?.rides)) {
    return profile.user.rides
  }
  return []
}

function mapDriverVerificationStatus(profile: any) {
  const documents = extractDriverDocuments(profile)
  if (profile.isVerified) return "approved"
  if (documents.some((document) => document.status === "rejected")) {
    return "rejected"
  }
  return "pending"
}

function serializeRide(ride: any) {
  return {
    ...ride,
    pricePerSeat:
      ride?.pricePerSeat != null ? Number(ride.pricePerSeat) : ride?.pricePerSeat,
  }
}

function serializeOffer(offer: any) {
  return {
    ...offer,
    pricePerSeat:
      offer?.pricePerSeat != null ? Number(offer.pricePerSeat) : offer?.pricePerSeat,
  }
}

function serializePayment(payment: any) {
  return {
    ...payment,
    amountCents: payment.amountCents,
    platformFeeCents: payment.platformFeeCents,
  }
}

function mapDriverAdminShape(profile: any) {
  const verificationStatus = mapDriverVerificationStatus(profile)
  const documents = extractDriverDocuments(profile)
  return {
    id: profile.id,
    userId: profile.userId,
    name: profile.user?.name ?? null,
    email: profile.user?.email ?? null,
    phone: profile.user?.phone ?? null,
    verificationStatus,
    vehicle: {
      make: profile.carMake,
      model: profile.carModel,
      year: profile.carYear,
      color: profile.carColor,
      plateNumber: profile.plateNumber,
    },
    licenseNumber: profile.licenseNumber,
    insuranceInfo: profile.insuranceInfo,
    documents: documents.map((document: any) => ({
      id: document.id,
      type: document.type,
      fileName: document.fileName,
      status: document.status,
      uploadedAt: document.createdAt,
      s3Key: document.s3Key,
    })),
    assignedRouteIds: [],
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}

function csvEscape(value: unknown) {
  if (value === null || typeof value === "undefined") {
    return ""
  }
  const asString = String(value)
  if (/[",\n]/.test(asString)) {
    return `"${asString.replace(/"/g, "\"\"")}"`
  }
  return asString
}

function sendCsvResponse(
  res: Response,
  filename: string,
  rows: CsvRow[],
  preferredColumns?: string[]
) {
  const columns =
    preferredColumns && preferredColumns.length > 0
      ? preferredColumns
      : rows.length > 0
        ? Object.keys(rows[0])
        : []

  const header = columns.join(",")
  const lines = rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))
  const csv = [header, ...lines].join("\n")

  res.setHeader("Content-Type", "text/csv; charset=utf-8")
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
  res.send(csv)
}

async function resolveRideForOffer(input: {
  request: any
  body: Record<string, unknown>
}) {
  const requestedRideId = parseNonEmptyString(input.body.rideId)
  if (requestedRideId) {
    const ride = await prisma.ride.findUnique({ where: { id: requestedRideId } })
    if (!ride) {
      throw new Error("Ride not found")
    }
    return ride
  }

  const driverId = parseNonEmptyString(input.body.driverId)
  if (!driverId) {
    throw new Error("driverId is required when rideId is not provided")
  }

  const ridePayload = {
    driverId,
    fromCity: parseNonEmptyString(input.body.fromCity),
    fromLat: parseNumber(input.body.fromLat),
    fromLng: parseNumber(input.body.fromLng),
    toCity: parseNonEmptyString(input.body.toCity),
    toLat: parseNumber(input.body.toLat),
    toLng: parseNumber(input.body.toLng),
    startTime: parseIsoDate(input.body.startTime),
    arrivalTime: parseIsoDate(input.body.arrivalTime),
    pricePerSeat: parseNumber(input.body.pricePerSeat),
    seatsTotal: parseNumber(input.body.seatsTotal),
    additionalNotes: parseNonEmptyString(input.body.notes),
  }

  if (
    !ridePayload.fromCity ||
    ridePayload.fromLat == null ||
    ridePayload.fromLng == null ||
    !ridePayload.toCity ||
    ridePayload.toLat == null ||
    ridePayload.toLng == null ||
    !ridePayload.startTime ||
    ridePayload.pricePerSeat == null ||
    ridePayload.seatsTotal == null
  ) {
    throw new Error(
      "rideId or complete ride fields are required (driverId, from/to city+coords, startTime, pricePerSeat, seatsTotal)"
    )
  }

  if (
    !isFiniteLatitude(ridePayload.fromLat) ||
    !isFiniteLongitude(ridePayload.fromLng) ||
    !isFiniteLatitude(ridePayload.toLat) ||
    !isFiniteLongitude(ridePayload.toLng)
  ) {
    throw new Error("Ride coordinates are invalid")
  }

  if (!Number.isInteger(ridePayload.seatsTotal) || ridePayload.seatsTotal <= 0) {
    throw new Error("seatsTotal must be a positive integer")
  }

  if (!Number.isFinite(ridePayload.pricePerSeat) || ridePayload.pricePerSeat < 0) {
    throw new Error("pricePerSeat must be a valid non-negative number")
  }

  const driver = await prisma.user.findUnique({
    where: { id: driverId },
    select: { id: true },
  })
  if (!driver) {
    throw new Error("driverId does not exist")
  }

  return prisma.ride.create({
    data: {
      driverId,
      fromCity: ridePayload.fromCity,
      fromLat: ridePayload.fromLat,
      fromLng: ridePayload.fromLng,
      toCity: ridePayload.toCity,
      toLat: ridePayload.toLat,
      toLng: ridePayload.toLng,
      startTime: ridePayload.startTime,
      arrivalTime: ridePayload.arrivalTime,
      additionalNotes: ridePayload.additionalNotes,
      pricePerSeat: ridePayload.pricePerSeat,
      seatsTotal: ridePayload.seatsTotal,
      seatsAvailable: ridePayload.seatsTotal,
      status: "open",
    },
  })
}

async function upsertAdminOfferForRequest(input: {
  request: any
  body: Record<string, unknown>
}) {
  const rideRequest = input.request
  if (!REQUEST_OPEN_STATUSES.has(rideRequest.status)) {
    throw new Error("Ride request is not open for offers")
  }

  const ride = await resolveRideForOffer({
    request: rideRequest,
    body: input.body,
  })

  const seatsOfferedRaw = parseNumber(input.body.seatsOffered)
  const seatsOffered =
    seatsOfferedRaw != null ? Math.floor(seatsOfferedRaw) : rideRequest.seatsNeeded

  if (!Number.isFinite(seatsOffered) || seatsOffered <= 0) {
    throw new Error("seatsOffered must be a positive integer")
  }
  if (ride.seatsAvailable < seatsOffered) {
    throw new Error("Ride does not have enough seats available")
  }

  const existingOffer = await prisma.rideRequestOffer.findUnique({
    where: {
      rideRequestId_driverId: {
        rideRequestId: rideRequest.id,
        driverId: ride.driverId,
      },
    },
  })

  if (existingOffer && OFFER_ACTIVE_STATUSES.has(existingOffer.status)) {
    throw new Error("An active offer already exists for this request and driver")
  }

  let offer
  if (existingOffer && OFFER_REOPENABLE_STATUSES.has(existingOffer.status)) {
    offer = await prisma.rideRequestOffer.update({
      where: { id: existingOffer.id },
      data: {
        rideId: ride.id,
        seatsOffered,
        pricePerSeat: ride.pricePerSeat,
        status: "SENT",
      },
    })
  } else {
    offer = await prisma.rideRequestOffer.create({
      data: {
        rideRequestId: rideRequest.id,
        driverId: ride.driverId,
        rideId: ride.id,
        seatsOffered,
        pricePerSeat: ride.pricePerSeat,
        status: "SENT",
      },
    })
  }

  const updatedRequest = await prisma.rideRequest.update({
    where: { id: rideRequest.id },
    data: {
      status: rideRequest.status === "pending" ? "matched" : rideRequest.status,
    },
  })

  return { offer, request: updatedRequest, ride }
}

async function buildRideCreateData(
  rawBody: Record<string, unknown>,
  fallbackDriverId?: string
) {
  const driverId = parseNonEmptyString(rawBody.driverId) ?? fallbackDriverId ?? null
  const fromCity = parseNonEmptyString(rawBody.fromCity)
  const fromLat = parseNumber(rawBody.fromLat)
  const fromLng = parseNumber(rawBody.fromLng)
  const toCity = parseNonEmptyString(rawBody.toCity)
  const toLat = parseNumber(rawBody.toLat)
  const toLng = parseNumber(rawBody.toLng)
  const startTime = parseIsoDate(rawBody.startTime)
  const arrivalTimeProvided = Object.prototype.hasOwnProperty.call(rawBody, "arrivalTime")
  const arrivalTimeRaw = parseIsoDate(rawBody.arrivalTime)
  const pricePerSeat = parseNumber(rawBody.pricePerSeat)
  const seatsTotalRaw = parseNumber(rawBody.seatsTotal)
  const statusRaw = parseNonEmptyString(rawBody.status)
  const additionalNotes = parseNonEmptyString(rawBody.additionalNotes)
  const stops = parseStringArray(rawBody.stops)
  const amenitiesInput = parseStringArray(rawBody.amenities)

  if (
    !driverId ||
    !fromCity ||
    fromLat == null ||
    fromLng == null ||
    !toCity ||
    toLat == null ||
    toLng == null ||
    !startTime ||
    pricePerSeat == null ||
    seatsTotalRaw == null
  ) {
    throw new Error(
      "driverId, fromCity/fromLat/fromLng, toCity/toLat/toLng, startTime, pricePerSeat, and seatsTotal are required"
    )
  }

  if (
    !isFiniteLatitude(fromLat) ||
    !isFiniteLongitude(fromLng) ||
    !isFiniteLatitude(toLat) ||
    !isFiniteLongitude(toLng)
  ) {
    throw new Error("Coordinates are invalid")
  }

  const seatsTotal = Math.floor(seatsTotalRaw)
  if (!Number.isInteger(seatsTotal) || seatsTotal <= 0) {
    throw new Error("seatsTotal must be a positive integer")
  }

  if (!Number.isFinite(pricePerSeat) || pricePerSeat < 0) {
    throw new Error("pricePerSeat must be a valid non-negative number")
  }

  if (arrivalTimeProvided && !arrivalTimeRaw && rawBody.arrivalTime !== null) {
    throw new Error("arrivalTime must be null or a valid ISO date string")
  }

  if (arrivalTimeRaw && arrivalTimeRaw <= startTime) {
    throw new Error("arrivalTime must be after startTime")
  }

  if (stops === null) {
    throw new Error("stops must be an array of strings")
  }

  if (amenitiesInput === null) {
    throw new Error("amenities must be an array of strings")
  }

  const amenities = (amenitiesInput ?? []).map((item) => item.toLowerCase())
  const invalidAmenities = amenities.filter(
    (item) => !RIDE_AMENITIES.includes(item as (typeof RIDE_AMENITIES)[number])
  )
  if (invalidAmenities.length > 0) {
    throw new Error(
      `Invalid amenities: ${invalidAmenities.join(", ")}. Allowed: ${RIDE_AMENITIES.join(", ")}`
    )
  }

  const driver = await prisma.user.findUnique({
    where: { id: driverId },
    select: { id: true },
  })
  if (!driver) {
    throw new Error("driverId does not exist")
  }

  const status = normalizeRideStatusInput(statusRaw ?? undefined) ?? "open"

  return {
    driverId,
    fromCity,
    fromLat,
    fromLng,
    toCity,
    toLat,
    toLng,
    startTime,
    arrivalTime: arrivalTimeRaw,
    stops: stops ?? [],
    amenities: amenities as (typeof RIDE_AMENITIES)[number][],
    additionalNotes: additionalNotes ?? null,
    pricePerSeat,
    seatsTotal,
    seatsAvailable: seatsTotal,
    status,
  }
}

/**
 * Driver management
 */
export async function listDriversAdmin(req: Request, res: Response) {
  try {
    const statusParam =
      typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : null
    const { page, limit, skip } = parsePagination(req)

    if (statusParam && !DRIVER_VERIFICATION_FILTERS.has(statusParam)) {
      return res.status(400).json({
        error: "Invalid status filter. Use pending|approved|rejected|suspended",
      })
    }

    if (statusParam === "suspended") {
      return res.json({ drivers: [], total: 0, page, limit })
    }

    const profiles = await prisma.driverProfile.findMany({
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            driverDocuments: {
              orderBy: { createdAt: "desc" },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    })

    const filtered = statusParam
      ? profiles.filter(
          (profile) => mapDriverVerificationStatus(profile) === statusParam
        )
      : profiles

    const paged = filtered.slice(skip, skip + limit).map(mapDriverAdminShape)

    return res.json({
      drivers: paged,
      total: filtered.length,
      page,
      limit,
    })
  } catch (err) {
    console.error("GET /admin/drivers error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function getDriverDetailsAdmin(req: Request, res: Response) {
  try {
    const { driverId } = req.params
    if (!driverId) {
      return res.status(400).json({ error: "driverId is required" })
    }

    const profile = await prisma.driverProfile.findUnique({
      where: { userId: driverId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            driverDocuments: {
              orderBy: { createdAt: "desc" },
            },
            userLocation: true,
          },
        },
      },
    })

    if (!profile) {
      return res.status(404).json({ error: "Driver profile not found" })
    }

    return res.json({ driver: mapDriverAdminShape(profile) })
  } catch (err) {
    console.error("GET /admin/drivers/:driverId error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function verifyDriverAdmin(req: Request, res: Response) {
  try {
    const { driverId } = req.params
    if (!driverId) {
      return res.status(400).json({ error: "driverId is required" })
    }

    const action = parseNonEmptyString((req.body ?? {}).action)?.toLowerCase()
    const reason = parseNonEmptyString((req.body ?? {}).reason)
    const sendNotification = parseBoolean((req.body ?? {}).sendNotification) ?? false

    if (!action || !["approve", "reject", "suspend"].includes(action)) {
      return res.status(400).json({
        error: "action must be one of: approve | reject | suspend",
      })
    }

    if (action === "suspend") {
      return res.status(400).json({
        error: "Suspend action is not supported by current schema",
      })
    }

    const profile = await prisma.driverProfile.findUnique({
      where: { userId: driverId },
      include: {
        user: {
          include: {
            driverDocuments: true,
          },
        },
      },
    })

    if (!profile) {
      return res.status(404).json({ error: "Driver profile not found" })
    }

    const updated = await prisma.driverProfile.update({
      where: { userId: driverId },
      data: {
        isVerified: action === "approve",
      },
      include: {
        user: {
          include: {
            driverDocuments: true,
          },
        },
      },
    })

    if (sendNotification) {
      await notifyUser({
        userId: driverId,
        type: "system",
        title: action === "approve" ? "Driver account approved" : "Driver account update",
        body:
          action === "approve"
            ? "Your driver profile has been approved."
            : reason
              ? `Driver verification update: ${reason}`
              : "Your driver profile verification was not approved.",
      })
    }

    return res.json({
      driver: mapDriverAdminShape(updated),
      action,
      reason: reason ?? null,
    })
  } catch (err) {
    console.error("POST /admin/drivers/:driverId/verify error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function reviewDriverDocumentAdmin(req: Request, res: Response) {
  try {
    const { driverId, docId } = req.params
    if (!driverId || !docId) {
      return res.status(400).json({ error: "driverId and docId are required" })
    }

    const status = parseNonEmptyString((req.body ?? {}).status)?.toLowerCase()
    if (!status || (status !== "approved" && status !== "rejected")) {
      return res.status(400).json({
        error: "status must be one of: approved | rejected",
      })
    }

    const existing = await prisma.driverDocument.findFirst({
      where: { id: docId, userId: driverId },
    })
    if (!existing) {
      return res.status(404).json({ error: "Driver document not found" })
    }

    const updated = await prisma.driverDocument.update({
      where: { id: docId },
      data: { status: status as DriverDocumentStatus },
    })

    if (status === "rejected") {
      await prisma.driverProfile.updateMany({
        where: { userId: driverId },
        data: { isVerified: false },
      })
    }

    return res.json({ document: updated })
  } catch (err) {
    console.error("PATCH /admin/drivers/:driverId/documents/:docId error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function requestAdditionalDriverDocumentAdmin(
  req: Request,
  res: Response
) {
  try {
    const { driverId } = req.params
    if (!driverId) {
      return res.status(400).json({ error: "driverId is required" })
    }

    const documentType = parseNonEmptyString((req.body ?? {}).documentType)?.toLowerCase()
    const reason = parseNonEmptyString((req.body ?? {}).reason)

    if (!documentType || !["license", "insurance", "registration", "ownership"].includes(documentType)) {
      return res.status(400).json({
        error: "documentType must be one of: license | insurance | registration | ownership",
      })
    }

    if (!reason) {
      return res.status(400).json({ error: "reason is required" })
    }

    const profile = await prisma.driverProfile.findUnique({
      where: { userId: driverId },
      select: { userId: true },
    })
    if (!profile) {
      return res.status(404).json({ error: "Driver profile not found" })
    }

    await notifyUser({
      userId: driverId,
      type: "system",
      title: "Additional document requested",
      body: `Please upload ${documentType} document. Reason: ${reason}`,
      data: {
        documentType,
      },
    })

    return res.json({
      message: "Additional document request sent",
      requested: {
        driverId,
        documentType,
        reason,
      },
    })
  } catch (err) {
    console.error("POST /admin/drivers/:driverId/documents/request error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function getDriverDocumentUrlAdmin(req: Request, res: Response) {
  try {
    const { driverId, docId } = req.params
    if (!driverId || !docId) {
      return res.status(400).json({ error: "driverId and docId are required" })
    }

    const rawExpires = Number(req.query.expiresIn ?? 3600)
    const expiresInSeconds =
      Number.isFinite(rawExpires) && rawExpires > 0
        ? Math.min(Math.floor(rawExpires), 86400)
        : 3600

    const document = await prisma.driverDocument.findFirst({
      where: { id: docId, userId: driverId },
    })

    if (!document) {
      return res.status(404).json({ error: "Driver document not found" })
    }

    const url = await getDownloadUrl(document.s3Key, expiresInSeconds)
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000)

    return res.json({
      url,
      expiresAt: expiresAt.toISOString(),
    })
  } catch (err) {
    console.error("GET /admin/drivers/:driverId/documents/:docId/url error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * Ride management
 */
export async function listRidesAdmin(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req)
    const statusParam =
      typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : null
    const driverId =
      typeof req.query.driverId === "string" ? req.query.driverId.trim() : null
    const dateParam = typeof req.query.date === "string" ? req.query.date : null

    const where: Record<string, unknown> = {}

    if (driverId) {
      where.driverId = driverId
    }

    if (statusParam) {
      if (statusParam === "draft") {
        return res.json({ rides: [], total: 0, page, limit })
      }
      if (statusParam === "full") {
        where.status = "open"
        where.seatsAvailable = 0
      } else {
        const normalizedStatus = normalizeRideStatusInput(statusParam)
        if (!normalizedStatus) {
          return res.status(400).json({
            error:
              "Invalid status filter. Use open|full|in_progress|completed|cancelled|draft",
          })
        }
        where.status = normalizedStatus
      }
    }

    if (dateParam) {
      const parsed = parseIsoDate(dateParam)
      if (!parsed) {
        return res.status(400).json({ error: "date must be a valid ISO date" })
      }
      const start = new Date(parsed)
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setDate(end.getDate() + 1)
      where.startTime = { gte: start, lt: end }
    }

    const [rides, total] = await Promise.all([
      prisma.ride.findMany({
        where,
        orderBy: { startTime: "desc" },
        skip,
        take: limit,
        include: {
          driver: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          _count: {
            select: { bookings: true },
          },
        },
      }),
      prisma.ride.count({ where }),
    ])

    return res.json({
      rides: rides.map(serializeRide),
      total,
      page,
      limit,
    })
  } catch (err) {
    console.error("GET /admin/rides error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function getRideDetailsAdmin(req: Request, res: Response) {
  try {
    const { rideId } = req.params
    if (!rideId) {
      return res.status(400).json({ error: "rideId is required" })
    }

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: {
        driver: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        bookings: {
          orderBy: { createdAt: "desc" },
          include: {
            passenger: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            payments: true,
          },
        },
        conversations: {
          select: { id: true, createdAt: true, updatedAt: true },
        },
      },
    })

    if (!ride) {
      return res.status(404).json({ error: "Ride not found" })
    }

    return res.json({ ride: serializeRide(ride) })
  } catch (err) {
    console.error("GET /admin/rides/:rideId error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function createRideAdmin(req: Request, res: Response) {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const data = await buildRideCreateData(body)

    const created = await prisma.ride.create({ data })

    return res.status(201).json({ ride: serializeRide(created) })
  } catch (err) {
    console.error("POST /admin/rides error", err)
    if (err instanceof Error) {
      return res.status(400).json({ error: err.message })
    }
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function bulkCreateRidesAdmin(req: Request, res: Response) {
  try {
    const body = (req.body ?? {}) as {
      rides?: AdminRideInput[]
      driverId?: string
    }

    if (!Array.isArray(body.rides) || body.rides.length === 0) {
      return res.status(400).json({ error: "rides must be a non-empty array" })
    }

    const fallbackDriverId = parseNonEmptyString(body.driverId)
    const results: Array<{
      clientRowId?: string
      rideId?: string
      error?: string
    }> = []
    let created = 0

    for (const row of body.rides) {
      try {
        const rowBody = row as unknown as Record<string, unknown>
        const data = await buildRideCreateData(rowBody, fallbackDriverId ?? undefined)
        const ride = await prisma.ride.create({ data })
        created += 1
        results.push({
          ...(row.clientRowId ? { clientRowId: row.clientRowId } : {}),
          rideId: ride.id,
        })
      } catch (rowErr) {
        const message =
          rowErr instanceof Error ? rowErr.message : "Failed to create ride row"
        results.push({
          ...(row.clientRowId ? { clientRowId: row.clientRowId } : {}),
          error: message,
        })
      }
    }

    return res.json({
      created,
      failed: results.length - created,
      results,
    })
  } catch (err) {
    console.error("POST /admin/rides/bulk error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function updateRideAdmin(req: Request, res: Response) {
  try {
    const { rideId } = req.params
    if (!rideId) {
      return res.status(400).json({ error: "rideId is required" })
    }

    const existing = await prisma.ride.findUnique({
      where: { id: rideId },
    })
    if (!existing) {
      return res.status(404).json({ error: "Ride not found" })
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const updateData: Record<string, unknown> = {}

    const fromCity = parseNonEmptyString(body.fromCity)
    const toCity = parseNonEmptyString(body.toCity)
    const fromLat = parseNumber(body.fromLat)
    const fromLng = parseNumber(body.fromLng)
    const toLat = parseNumber(body.toLat)
    const toLng = parseNumber(body.toLng)
    const pricePerSeat = parseNumber(body.pricePerSeat)
    const seatsTotalRaw = parseNumber(body.seatsTotal)
    const startTime = parseIsoDate(body.startTime)
    const arrivalTimeProvided = Object.prototype.hasOwnProperty.call(body, "arrivalTime")
    const arrivalTime = parseIsoDate(body.arrivalTime)
    const statusInput = parseNonEmptyString(body.status)
    const driverId = parseNonEmptyString(body.driverId)

    if (fromCity) updateData.fromCity = fromCity
    if (toCity) updateData.toCity = toCity

    if (fromLat != null || fromLng != null) {
      if (fromLat == null || fromLng == null) {
        return res.status(400).json({ error: "fromLat and fromLng must be sent together" })
      }
      if (!isFiniteLatitude(fromLat) || !isFiniteLongitude(fromLng)) {
        return res.status(400).json({ error: "fromLat/fromLng are invalid" })
      }
      updateData.fromLat = fromLat
      updateData.fromLng = fromLng
    }

    if (toLat != null || toLng != null) {
      if (toLat == null || toLng == null) {
        return res.status(400).json({ error: "toLat and toLng must be sent together" })
      }
      if (!isFiniteLatitude(toLat) || !isFiniteLongitude(toLng)) {
        return res.status(400).json({ error: "toLat/toLng are invalid" })
      }
      updateData.toLat = toLat
      updateData.toLng = toLng
    }

    if (pricePerSeat != null) {
      if (!Number.isFinite(pricePerSeat) || pricePerSeat < 0) {
        return res.status(400).json({ error: "pricePerSeat must be non-negative" })
      }
      updateData.pricePerSeat = pricePerSeat
    }

    if (seatsTotalRaw != null) {
      const seatsTotal = Math.floor(seatsTotalRaw)
      if (!Number.isInteger(seatsTotal) || seatsTotal <= 0) {
        return res.status(400).json({ error: "seatsTotal must be a positive integer" })
      }
      const bookedSeats = Math.max(0, existing.seatsTotal - existing.seatsAvailable)
      if (seatsTotal < bookedSeats) {
        return res.status(400).json({
          error: `seatsTotal cannot be less than currently booked seats (${bookedSeats})`,
        })
      }
      updateData.seatsTotal = seatsTotal
      updateData.seatsAvailable = seatsTotal - bookedSeats
    }

    if (startTime) {
      updateData.startTime = startTime
    } else if (Object.prototype.hasOwnProperty.call(body, "startTime")) {
      return res.status(400).json({ error: "startTime must be a valid ISO date" })
    }

    if (arrivalTimeProvided) {
      if (body.arrivalTime === null) {
        updateData.arrivalTime = null
      } else if (!arrivalTime) {
        return res.status(400).json({ error: "arrivalTime must be null or valid ISO date" })
      } else {
        const compareStart =
          (updateData.startTime as Date | undefined) ?? existing.startTime
        if (arrivalTime <= compareStart) {
          return res.status(400).json({ error: "arrivalTime must be after startTime" })
        }
        updateData.arrivalTime = arrivalTime
      }
    }

    if (statusInput) {
      const status = normalizeRideStatusInput(statusInput)
      if (!status) {
        return res.status(400).json({
          error: "status must be one of open|in_progress|ongoing|completed|cancelled",
        })
      }
      updateData.status = status
    }

    if (driverId) {
      const driver = await prisma.user.findUnique({
        where: { id: driverId },
        select: { id: true },
      })
      if (!driver) {
        return res.status(400).json({ error: "driverId does not exist" })
      }
      updateData.driverId = driverId
    }

    const stops = parseStringArray(body.stops)
    if (Object.prototype.hasOwnProperty.call(body, "stops")) {
      if (!stops) {
        return res.status(400).json({ error: "stops must be an array of strings" })
      }
      updateData.stops = stops
    }

    const amenities = parseStringArray(body.amenities)
    if (Object.prototype.hasOwnProperty.call(body, "amenities")) {
      if (!amenities) {
        return res.status(400).json({ error: "amenities must be an array of strings" })
      }
      const normalizedAmenities = amenities.map((item) => item.toLowerCase())
      const invalidAmenities = normalizedAmenities.filter(
        (item) => !RIDE_AMENITIES.includes(item as (typeof RIDE_AMENITIES)[number])
      )
      if (invalidAmenities.length > 0) {
        return res.status(400).json({
          error: `Invalid amenities: ${invalidAmenities.join(", ")}`,
        })
      }
      updateData.amenities = normalizedAmenities
    }

    if (Object.prototype.hasOwnProperty.call(body, "additionalNotes")) {
      updateData.additionalNotes = parseNonEmptyString(body.additionalNotes)
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No updates provided" })
    }

    const updated = await prisma.ride.update({
      where: { id: rideId },
      data: updateData,
    })

    return res.json({ ride: serializeRide(updated) })
  } catch (err) {
    console.error("PATCH /admin/rides/:rideId error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function assignRideDriverAdmin(req: Request, res: Response) {
  try {
    const { rideId } = req.params
    if (!rideId) {
      return res.status(400).json({ error: "rideId is required" })
    }

    const driverId = parseNonEmptyString((req.body ?? {}).driverId)
    const sendNotification = parseBoolean((req.body ?? {}).sendNotification) ?? false
    if (!driverId) {
      return res.status(400).json({ error: "driverId is required" })
    }

    const [ride, driver] = await Promise.all([
      prisma.ride.findUnique({
        where: { id: rideId },
        select: { id: true, driverId: true, fromCity: true, toCity: true },
      }),
      prisma.user.findUnique({
        where: { id: driverId },
        select: { id: true },
      }),
    ])

    if (!ride) {
      return res.status(404).json({ error: "Ride not found" })
    }
    if (!driver) {
      return res.status(400).json({ error: "driverId does not exist" })
    }

    const updated = await prisma.ride.update({
      where: { id: rideId },
      data: { driverId },
    })

    if (sendNotification) {
      await notifyUser({
        userId: driverId,
        type: "ride_update",
        title: "Ride assigned",
        body: `You were assigned ${ride.fromCity} → ${ride.toCity}`,
        data: { rideId: ride.id },
      })
    }

    return res.json({ ride: serializeRide(updated) })
  } catch (err) {
    console.error("PUT /admin/rides/:rideId/assign error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function cancelRideAdmin(req: Request, res: Response) {
  try {
    const { rideId } = req.params
    if (!rideId) {
      return res.status(400).json({ error: "rideId is required" })
    }

    const sendNotification = parseBoolean((req.body ?? {}).sendNotification) ?? false
    const refundBookings = parseBoolean((req.body ?? {}).refundBookings) ?? false

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: {
        bookings: {
          where: {
            status: {
              in: [
                "pending",
                "confirmed",
                "ACCEPTED",
                "PAYMENT_PENDING",
                "CONFIRMED",
              ],
            },
          },
          include: {
            passenger: {
              select: { id: true },
            },
          },
        },
      },
    })

    if (!ride) {
      return res.status(404).json({ error: "Ride not found" })
    }

    const activeBookingIds = ride.bookings.map((booking) => booking.id)

    await prisma.$transaction([
      prisma.ride.update({
        where: { id: rideId },
        data: {
          status: "cancelled",
          seatsAvailable: ride.seatsTotal,
        },
      }),
      ...(activeBookingIds.length > 0
        ? [
            prisma.booking.updateMany({
              where: { id: { in: activeBookingIds } },
              data: {
                status: "cancelled_by_driver",
              },
            }),
          ]
        : []),
    ])

    if (refundBookings && activeBookingIds.length > 0) {
      for (const booking of ride.bookings) {
        try {
          await initiateBookingRefundIfPaid({
            bookingId: booking.id,
            paymentStatus: booking.paymentStatus,
            stripePaymentIntentId: booking.stripePaymentIntentId,
            source: "driver_cancel_ride",
          })
        } catch (refundErr) {
          console.error("Admin ride cancellation refund failed", {
            bookingId: booking.id,
            rideId,
            err: refundErr,
          })
        }
      }
    }

    if (sendNotification) {
      const passengerIds = Array.from(
        new Set(ride.bookings.map((booking) => booking.passengerId))
      )
      await notifyUsersByIds({
        userIds: passengerIds,
        title: "Ride cancelled",
        body: `${ride.fromCity} → ${ride.toCity} has been cancelled`,
        type: "ride_update",
        data: { rideId },
      })
    }

    const [updatedRide, cancelledBookings] = await Promise.all([
      prisma.ride.findUnique({ where: { id: rideId } }),
      activeBookingIds.length > 0
        ? prisma.booking.findMany({ where: { id: { in: activeBookingIds } } })
        : Promise.resolve([]),
    ])

    return res.json({
      ride: updatedRide ? serializeRide(updatedRide) : null,
      cancelledBookings,
    })
  } catch (err) {
    console.error("PUT /admin/rides/:rideId/cancel error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function updateRideStatusAdmin(req: Request, res: Response) {
  try {
    const { rideId } = req.params
    if (!rideId) {
      return res.status(400).json({ error: "rideId is required" })
    }

    const statusInput = parseNonEmptyString((req.body ?? {}).status)
    if (!statusInput) {
      return res.status(400).json({ error: "status is required" })
    }
    const status = normalizeRideStatusInput(statusInput)
    if (!status) {
      return res.status(400).json({
        error: "status must be one of open|in_progress|ongoing|completed|cancelled",
      })
    }

    const sendNotification = parseBoolean((req.body ?? {}).sendNotification) ?? false

    const existing = await prisma.ride.findUnique({
      where: { id: rideId },
      select: { id: true, fromCity: true, toCity: true },
    })
    if (!existing) {
      return res.status(404).json({ error: "Ride not found" })
    }

    const updated = await prisma.ride.update({
      where: { id: rideId },
      data: { status },
    })

    if (sendNotification) {
      const bookings = await prisma.booking.findMany({
        where: {
          rideId,
          status: {
            in: ["pending", "confirmed", "ACCEPTED", "PAYMENT_PENDING", "CONFIRMED"],
          },
        },
        select: { passengerId: true },
      })
      const passengerIds = Array.from(new Set(bookings.map((item) => item.passengerId)))
      if (passengerIds.length > 0) {
        await notifyUsersByIds({
          userIds: passengerIds,
          title: "Ride status updated",
          body: `${existing.fromCity} → ${existing.toCity} is now ${status}`,
          type: "ride_update",
          data: { rideId, status },
        })
      }
    }

    return res.json({ ride: serializeRide(updated) })
  } catch (err) {
    console.error("PUT /admin/rides/:rideId/status error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function listEligibleDriversForRideAdmin(req: Request, res: Response) {
  try {
    const { rideId } = req.params
    if (!rideId) {
      return res.status(400).json({ error: "rideId is required" })
    }

    const rawLimit = Number(req.query.limit ?? 50)
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), 200)
        : 50

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      select: {
        id: true,
        driverId: true,
        startTime: true,
        seatsTotal: true,
      },
    })

    if (!ride) {
      return res.status(404).json({ error: "Ride not found" })
    }

    const windowStart = new Date(ride.startTime.getTime() - 2 * 60 * 60 * 1000)
    const windowEnd = new Date(ride.startTime.getTime() + 2 * 60 * 60 * 1000)

    const driverProfiles = await prisma.driverProfile.findMany({
      where: {
        NOT: { userId: ride.driverId },
      },
      take: limit,
      orderBy: { updatedAt: "desc" },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            driverDocuments: true,
            rides: {
              where: {
                status: { in: ["open", "ongoing"] },
                startTime: { gte: windowStart, lte: windowEnd },
              },
              select: {
                id: true,
              },
            },
          },
        },
      },
    })

    const drivers = driverProfiles
      .map((profile) => {
        const verified = profile.isVerified
        const scheduleConflict = extractDriverConflictRides(profile).length > 0
        const routeMatch = true
        const vehicleCapacity = true
        const eligible = verified && !scheduleConflict

        return {
          driver: mapDriverAdminShape(profile),
          eligible,
          reasons: {
            verified,
            routeMatch,
            scheduleConflict,
            vehicleCapacity,
            other: [],
          },
        }
      })
      .sort((a, b) => Number(b.eligible) - Number(a.eligible))

    return res.json({ drivers })
  } catch (err) {
    console.error("GET /admin/rides/:rideId/eligible-drivers error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function exportRidesAdmin(req: Request, res: Response) {
  try {
    const format =
      typeof req.query.format === "string" ? req.query.format.toLowerCase() : "csv"

    const statusParam =
      typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : null
    const where: Record<string, unknown> = {}

    if (statusParam) {
      if (statusParam === "full") {
        where.status = "open"
        where.seatsAvailable = 0
      } else if (statusParam === "draft") {
        where.id = "__no_draft_supported__"
      } else {
        const normalized = normalizeRideStatusInput(statusParam)
        if (!normalized) {
          return res.status(400).json({ error: "Invalid status filter" })
        }
        where.status = normalized
      }
    }

    const dateWindow = parseDateWindow(req.query.dateFrom, req.query.dateTo)
    if (dateWindow) {
      where.startTime = dateWindow
    }

    const rides = await prisma.ride.findMany({
      where,
      orderBy: { startTime: "desc" },
      include: {
        _count: { select: { bookings: true } },
      },
      take: 5000,
    })

    const normalized = rides.map((ride) => ({
      id: ride.id,
      driverId: ride.driverId,
      fromCity: ride.fromCity,
      toCity: ride.toCity,
      startTime: ride.startTime.toISOString(),
      arrivalTime: ride.arrivalTime?.toISOString() ?? null,
      status: ride.status,
      pricePerSeat: Number(ride.pricePerSeat),
      seatsTotal: ride.seatsTotal,
      seatsAvailable: ride.seatsAvailable,
      bookings: ride._count.bookings,
      createdAt: ride.createdAt.toISOString(),
      updatedAt: ride.updatedAt.toISOString(),
    }))

    if (format === "json") {
      return res.json(normalized)
    }
    if (format !== "csv") {
      return res.status(400).json({ error: "format must be csv or json" })
    }

    return sendCsvResponse(res, "rides-export.csv", normalized)
  } catch (err) {
    console.error("GET /admin/rides/export error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * Ride requests and offers
 */
export async function listRideRequestsAdmin(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req)
    const statusParam =
      typeof req.query.status === "string" ? req.query.status.trim() : undefined
    const normalized = normalizeRideRequestStatusFilter(statusParam)
    if (normalized === "invalid") {
      return res.status(400).json({
        error: "Invalid status filter. Use pending|matched|accepted|rejected",
      })
    }

    const where: Record<string, unknown> = {}
    if (normalized) {
      where.status = normalized
    }

    const [requests, total] = await Promise.all([
      prisma.rideRequest.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          passenger: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          driver: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          _count: {
            select: { offers: true },
          },
        },
      }),
      prisma.rideRequest.count({ where }),
    ])

    return res.json({
      requests: requests.map((request) => ({
        ...request,
        quotedPricePerSeat:
          request.quotedPricePerSeat != null ? Number(request.quotedPricePerSeat) : null,
      })),
      total,
      page,
      limit,
    })
  } catch (err) {
    console.error("GET /admin/ride-requests error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function createRideOfferAdmin(req: Request, res: Response) {
  try {
    const { requestId } = req.params
    if (!requestId) {
      return res.status(400).json({ error: "requestId is required" })
    }

    const rideRequest = await prisma.rideRequest.findUnique({
      where: { id: requestId },
    })
    if (!rideRequest) {
      return res.status(404).json({ error: "Ride request not found" })
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const { offer, request } = await upsertAdminOfferForRequest({
      request: rideRequest,
      body,
    })

    await notifyUser({
      userId: rideRequest.passengerId,
      title: "New ride offer",
      body: `${rideRequest.fromCity} → ${rideRequest.toCity} has a new offer`,
      type: "ride_update",
      data: {
        rideRequestId: rideRequest.id,
        offerId: offer.id,
      },
    })

    return res.status(201).json({
      offer: serializeOffer(offer),
      request,
    })
  } catch (err) {
    console.error("POST /admin/ride-requests/:requestId/offers error", err)
    if (err instanceof Error) {
      return res.status(400).json({ error: err.message })
    }
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function bulkCreateRideOffersAdmin(req: Request, res: Response) {
  try {
    const { requestId } = req.params
    if (!requestId) {
      return res.status(400).json({ error: "requestId is required" })
    }

    const rideRequest = await prisma.rideRequest.findUnique({
      where: { id: requestId },
    })
    if (!rideRequest) {
      return res.status(404).json({ error: "Ride request not found" })
    }

    const body = (req.body ?? {}) as {
      offers?: Array<Record<string, unknown> & { clientRowId?: string }>
      driverId?: string
    }
    if (!Array.isArray(body.offers) || body.offers.length === 0) {
      return res.status(400).json({ error: "offers must be a non-empty array" })
    }

    const fallbackDriverId = parseNonEmptyString(body.driverId)

    const results: Array<{
      clientRowId?: string
      offerId?: string
      error?: string
    }> = []
    let created = 0

    for (const offerRow of body.offers) {
      try {
        const rowBody: Record<string, unknown> = {
          ...offerRow,
          ...(fallbackDriverId && !offerRow.driverId
            ? { driverId: fallbackDriverId }
            : {}),
        }
        const createdOffer = await upsertAdminOfferForRequest({
          request: rideRequest,
          body: rowBody,
        })
        created += 1
        results.push({
          ...(offerRow.clientRowId ? { clientRowId: offerRow.clientRowId } : {}),
          offerId: createdOffer.offer.id,
        })
      } catch (rowErr) {
        results.push({
          ...(offerRow.clientRowId ? { clientRowId: offerRow.clientRowId } : {}),
          error:
            rowErr instanceof Error ? rowErr.message : "Failed to create offer row",
        })
      }
    }

    return res.json({
      created,
      failed: results.length - created,
      results,
    })
  } catch (err) {
    console.error("POST /admin/ride-requests/:requestId/offers/bulk error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function updateRideRequestStatusAdmin(req: Request, res: Response) {
  try {
    const { requestId } = req.params
    if (!requestId) {
      return res.status(400).json({ error: "requestId is required" })
    }

    const statusInput = parseNonEmptyString((req.body ?? {}).status)
    if (!statusInput) {
      return res.status(400).json({ error: "status is required" })
    }

    const status = normalizeRideRequestStatusUpdate(statusInput)
    if (!status) {
      return res.status(400).json({
        error: "status must be awaiting_payment | matched | accepted | rejected | pending",
      })
    }

    const existing = await prisma.rideRequest.findUnique({
      where: { id: requestId },
    })
    if (!existing) {
      return res.status(404).json({ error: "Ride request not found" })
    }

    const updated = await prisma.rideRequest.update({
      where: { id: requestId },
      data: { status },
    })

    return res.json({ request: updated })
  } catch (err) {
    console.error("PUT /admin/ride-requests/:requestId/status error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * Booking management
 */
export async function listBookingsAdmin(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req)
    const rideId = typeof req.query.rideId === "string" ? req.query.rideId : null
    const passengerId =
      typeof req.query.passengerId === "string" ? req.query.passengerId : null
    const statusParam =
      typeof req.query.status === "string" ? req.query.status : undefined

    const statusWhere = normalizeBookingStatusFilter(statusParam)
    if (statusWhere === "invalid") {
      return res.status(400).json({
        error: "Invalid status filter. Use pending|confirmed|completed|cancelled|no_show",
      })
    }

    const where: Record<string, unknown> = {}
    if (rideId) {
      where.rideId = rideId
    }
    if (passengerId) {
      where.passengerId = passengerId
    }
    if (statusWhere) {
      Object.assign(where, statusWhere)
    }

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          ride: true,
          passenger: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
            },
          },
          payments: true,
        },
      }),
      prisma.booking.count({ where }),
    ])

    return res.json({
      bookings: bookings.map((booking) => ({
        ...booking,
        ride: booking.ride ? serializeRide(booking.ride) : null,
        payments: booking.payments.map(serializePayment),
      })),
      total,
      page,
      limit,
    })
  } catch (err) {
    console.error("GET /admin/bookings error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function getBookingDetailsAdmin(req: Request, res: Response) {
  try {
    const { bookingId } = req.params
    if (!bookingId) {
      return res.status(400).json({ error: "bookingId is required" })
    }

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        passenger: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        ride: {
          include: {
            driver: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
              },
            },
          },
        },
        payments: true,
      },
    })

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" })
    }

    return res.json({
      booking: {
        ...booking,
        ride: booking.ride ? serializeRide(booking.ride) : null,
        payments: booking.payments.map(serializePayment),
      },
    })
  } catch (err) {
    console.error("GET /admin/bookings/:bookingId error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function confirmBookingAdmin(req: Request, res: Response) {
  try {
    const { bookingId } = req.params
    if (!bookingId) {
      return res.status(400).json({ error: "bookingId is required" })
    }

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        ride: true,
      },
    })

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" })
    }

    if (booking.status !== "pending") {
      return res.status(400).json({ error: "Only pending bookings can be confirmed" })
    }
    if (!RIDE_OPEN_STATUSES.has(booking.ride.status)) {
      return res.status(400).json({ error: "Ride is not open for booking confirmation" })
    }
    if (booking.ride.seatsAvailable < booking.seatsBooked) {
      return res.status(400).json({
        error: "Not enough available seats to confirm this booking",
      })
    }

    const [updatedBooking, updatedRide] = await prisma.$transaction([
      prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: "ACCEPTED",
        },
      }),
      prisma.ride.update({
        where: { id: booking.rideId },
        data: {
          seatsAvailable: booking.ride.seatsAvailable - booking.seatsBooked,
        },
      }),
    ])

    await notifyUser({
      userId: booking.passengerId,
      type: "ride_update",
      title: "Booking accepted",
      body: `${booking.ride.fromCity} → ${booking.ride.toCity} is accepted`,
      data: {
        bookingId: booking.id,
        rideId: booking.rideId,
      },
    })

    return res.json({
      booking: updatedBooking,
      ride: serializeRide(updatedRide),
    })
  } catch (err) {
    console.error("PUT /admin/bookings/:bookingId/confirm error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function cancelBookingAdmin(req: Request, res: Response) {
  try {
    const { bookingId } = req.params
    if (!bookingId) {
      return res.status(400).json({ error: "bookingId is required" })
    }

    const refundRequired = parseBoolean((req.body ?? {}).refundRequired) ?? false

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        ride: true,
      },
    })
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" })
    }

    if (!ACTIVE_BOOKING_STATUSES.has(booking.status)) {
      return res.status(400).json({ error: "Only active bookings can be cancelled" })
    }

    if (refundRequired) {
      try {
        await initiateBookingRefundIfPaid({
          bookingId: booking.id,
          paymentStatus: booking.paymentStatus,
          stripePaymentIntentId: booking.stripePaymentIntentId,
          source: "driver_cancel_booking",
        })
      } catch (refundErr) {
        console.error("Admin booking cancel refund failed", {
          bookingId: booking.id,
          err: refundErr,
        })
        return res.status(502).json({
          error: "Unable to initiate refund for this booking",
        })
      }
    }

    const shouldRestoreSeats = CONFIRMED_BOOKING_STATUSES.has(booking.status)

    const [updatedBooking, updatedRide] = await prisma.$transaction([
      prisma.booking.update({
        where: { id: booking.id },
        data: {
          status: "cancelled_by_driver",
        },
      }),
      ...(shouldRestoreSeats
        ? [
            prisma.ride.update({
              where: { id: booking.rideId },
              data: {
                seatsAvailable: Math.min(
                  booking.ride.seatsTotal,
                  booking.ride.seatsAvailable + booking.seatsBooked
                ),
              },
            }),
          ]
        : []),
    ])

    await notifyUser({
      userId: booking.passengerId,
      type: "ride_update",
      title: "Booking cancelled",
      body: `${booking.ride.fromCity} → ${booking.ride.toCity} booking was cancelled`,
      data: {
        bookingId: booking.id,
        rideId: booking.rideId,
      },
    })

    return res.json({
      booking: updatedBooking,
      ride: updatedRide ? serializeRide(updatedRide) : booking.ride,
    })
  } catch (err) {
    console.error("PUT /admin/bookings/:bookingId/cancel error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function exportBookingsAdmin(req: Request, res: Response) {
  try {
    const format =
      typeof req.query.format === "string" ? req.query.format.toLowerCase() : "csv"
    const statusParam =
      typeof req.query.status === "string" ? req.query.status : undefined
    const dateWindow = parseDateWindow(req.query.dateFrom, req.query.dateTo)

    const where: Record<string, unknown> = {}
    const statusWhere = normalizeBookingStatusFilter(statusParam)
    if (statusWhere === "invalid") {
      return res.status(400).json({ error: "Invalid status filter" })
    }
    if (statusWhere) {
      Object.assign(where, statusWhere)
    }
    if (dateWindow) {
      where.createdAt = dateWindow
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: { ride: true },
      orderBy: { createdAt: "desc" },
      take: 5000,
    })

    const normalized = bookings.map((booking) => ({
      id: booking.id,
      rideId: booking.rideId,
      passengerId: booking.passengerId,
      status: booking.status,
      paymentStatus: booking.paymentStatus,
      seatsBooked: booking.seatsBooked,
      fromCity: booking.ride?.fromCity ?? null,
      toCity: booking.ride?.toCity ?? null,
      createdAt: booking.createdAt.toISOString(),
      updatedAt: booking.updatedAt.toISOString(),
    }))

    if (format === "json") {
      return res.json(normalized)
    }
    if (format !== "csv") {
      return res.status(400).json({ error: "format must be csv or json" })
    }

    return sendCsvResponse(res, "bookings-export.csv", normalized)
  } catch (err) {
    console.error("GET /admin/bookings/export error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * Payment management
 */
export async function listPaymentsAdmin(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req)
    const bookingId =
      typeof req.query.bookingId === "string" ? req.query.bookingId : undefined
    const driverId =
      typeof req.query.driverId === "string" ? req.query.driverId : undefined
    const statusFilter =
      typeof req.query.status === "string" ? req.query.status : undefined
    const dateWindow = parseDateWindow(req.query.dateFrom, req.query.dateTo)

    const status = normalizePaymentStatusFilter(statusFilter)
    if (status === "invalid") {
      return res
        .status(400)
        .json({ error: "Invalid status filter. Use paid|pending|refunded|failed" })
    }

    const where: Record<string, unknown> = {}
    if (bookingId) {
      where.bookingId = bookingId
    }
    if (status) {
      where.status = status
    }
    if (dateWindow) {
      where.createdAt = dateWindow
    }
    if (driverId) {
      where.booking = { ride: { driverId } }
    }

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          booking: {
            include: {
              ride: {
                select: {
                  id: true,
                  driverId: true,
                  fromCity: true,
                  toCity: true,
                },
              },
              passenger: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
            },
          },
        },
      }),
      prisma.payment.count({ where }),
    ])

    return res.json({
      payments: payments.map(serializePayment),
      total,
      page,
      limit,
    })
  } catch (err) {
    console.error("GET /admin/payments error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function getPaymentDetailsAdmin(req: Request, res: Response) {
  try {
    const { paymentId } = req.params
    if (!paymentId) {
      return res.status(400).json({ error: "paymentId is required" })
    }

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        booking: {
          include: {
            passenger: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
              },
            },
            ride: {
              include: {
                driver: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    phone: true,
                  },
                },
              },
            },
          },
        },
      },
    })

    if (!payment) {
      return res.status(404).json({ error: "Payment not found" })
    }

    return res.json({ payment: serializePayment(payment) })
  } catch (err) {
    console.error("GET /admin/payments/:paymentId error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function markPaymentPaidAdmin(req: Request, res: Response) {
  try {
    const { paymentId } = req.params
    if (!paymentId) {
      return res.status(400).json({ error: "paymentId is required" })
    }

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { booking: true },
    })
    if (!payment) {
      return res.status(404).json({ error: "Payment not found" })
    }

    const paymentIntentId = parseNonEmptyString((req.body ?? {}).paymentIntentId)

    const [updatedPayment] = await prisma.$transaction([
      prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: "paid",
          ...(paymentIntentId ? { paymentIntentId } : {}),
        },
      }),
      prisma.booking.update({
        where: { id: payment.bookingId },
        data: {
          paymentStatus: "paid",
          status:
            payment.booking.status === "ACCEPTED" || payment.booking.status === "PAYMENT_PENDING"
              ? "CONFIRMED"
              : payment.booking.status,
        },
      }),
    ])

    return res.json({ payment: serializePayment(updatedPayment) })
  } catch (err) {
    console.error("PUT /admin/payments/:paymentId/mark-paid error", err)
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return res.status(409).json({ error: "paymentIntentId is already in use" })
    }
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * POST /api/admin/payments/:paymentId/payout
 * Transfer driver earnings from platform balance to driver's connected Stripe account.
 */
export async function payoutPaymentToDriverAdmin(req: Request, res: Response) {
  try {
    const { paymentId } = req.params
    if (!paymentId) {
      return res.status(400).json({ error: "paymentId is required" })
    }

    const amountRaw = parseNumber((req.body ?? {}).amount)
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        booking: {
          include: {
            ride: {
              select: {
                id: true,
                driverId: true,
                fromCity: true,
                toCity: true,
              },
            },
          },
        },
      },
    })
    if (!payment) {
      return res.status(404).json({ error: "Payment not found" })
    }

    if (payment.driverTransferId) {
      return res.status(409).json({
        error: "Driver payout already created for this payment",
        payout: {
          id: payment.driverTransferId,
          amount: payment.driverTransferAmountCents,
          transferredAt: payment.driverTransferredAt,
        },
      })
    }

    if (payment.status === "refunded") {
      return res.status(409).json({
        error: "Cannot pay out a refunded payment",
      })
    }

    if (payment.status !== "paid" && payment.status !== "succeeded") {
      return res.status(409).json({
        error: "Payment must be paid before creating driver payout",
      })
    }

    const driverEarningsCents = payment.amountCents - payment.platformFeeCents
    if (!Number.isFinite(driverEarningsCents) || driverEarningsCents <= 0) {
      return res.status(400).json({ error: "Driver payout amount must be positive" })
    }

    const requestedAmountCents =
      amountRaw != null ? Math.round(amountRaw * 100) : driverEarningsCents
    if (!Number.isFinite(requestedAmountCents) || requestedAmountCents <= 0) {
      return res.status(400).json({
        error: "amount must be a positive number",
      })
    }

    if (requestedAmountCents !== driverEarningsCents) {
      return res.status(400).json({
        error: "Partial payouts are not supported",
        expectedAmountCents: driverEarningsCents,
      })
    }

    const transferAmountCents = driverEarningsCents

    const driver = await prisma.user.findUnique({
      where: { id: payment.booking.ride.driverId },
      select: {
        id: true,
        deletedAt: true,
        stripeAccountId: true,
        driverProfile: {
          select: { id: true },
        },
      },
    })

    if (!driver || (!driver.driverProfile && !driver.deletedAt)) {
      return res.status(409).json({
        error: "Assigned driver profile is missing",
      })
    }

    if (!driver.stripeAccountId) {
      return res.status(409).json({
        error: "Driver has not completed Stripe Connect onboarding",
      })
    }

    const account = await stripe.accounts.retrieve(driver.stripeAccountId)
    if ("deleted" in account && account.deleted) {
      return res.status(409).json({
        error: "Driver Stripe connected account was deleted. Re-onboard driver.",
      })
    }

    if (!account.payouts_enabled || !account.details_submitted) {
      return res.status(409).json({
        error: "Driver Stripe account is not ready for payouts",
        requirementsCurrentlyDue: account.requirements?.currently_due ?? [],
        disabledReason: account.requirements?.disabled_reason ?? null,
      })
    }

    let sourceTransactionId: string | undefined
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(
        payment.paymentIntentId
      )
      sourceTransactionId =
        typeof paymentIntent.latest_charge === "string"
          ? paymentIntent.latest_charge
          : paymentIntent.latest_charge?.id
    } catch (stripeErr) {
      if (!(stripeErr instanceof Stripe.errors.StripeInvalidRequestError)) {
        throw stripeErr
      }
    }

    const transfer = await stripe.transfers.create(
      {
        amount: transferAmountCents,
        currency: payment.currency,
        destination: driver.stripeAccountId,
        ...(sourceTransactionId
          ? {
              source_transaction: sourceTransactionId,
            }
          : {}),
        transfer_group: `booking:${payment.bookingId}`,
        metadata: {
          paymentId: payment.id,
          bookingId: payment.bookingId,
          driverId: payment.booking.ride.driverId,
          paymentIntentId: payment.paymentIntentId,
          source: "admin_manual_driver_payout",
        },
      },
      {
        idempotencyKey: `payment:${payment.id}:driver-payout`,
      }
    )

    const transferredAt = transfer.created
      ? new Date(transfer.created * 1000)
      : new Date()

    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        driverTransferId: transfer.id,
        driverTransferAmountCents: transfer.amount,
        driverTransferredAt: transferredAt,
      },
    })

    await notifyUser({
      userId: driver.id,
      title: "Payout initiated",
      body: `${payment.booking.ride.fromCity} → ${payment.booking.ride.toCity} payout is processing`,
      type: "payment",
      data: {
        paymentId: payment.id,
        bookingId: payment.bookingId,
        rideId: payment.booking.ride.id,
        transferId: transfer.id,
        kind: "driver_payout_initiated",
      },
    })

    return res.json({
      payment: serializePayment(updatedPayment),
      payout: {
        id: transfer.id,
        amount: transfer.amount,
        currency: transfer.currency,
        destination:
          typeof transfer.destination === "string"
            ? transfer.destination
            : transfer.destination?.id,
        sourceTransactionId:
          typeof transfer.source_transaction === "string"
            ? transfer.source_transaction
            : transfer.source_transaction?.id,
        created: transfer.created,
      },
    })
  } catch (err) {
    console.error("POST /admin/payments/:paymentId/payout error", err)
    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
      return res.status(409).json({
        error: "Stripe payout creation failed",
        details: err.message,
      })
    }
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function refundPaymentAdmin(req: Request, res: Response) {
  try {
    const { paymentId } = req.params
    if (!paymentId) {
      return res.status(400).json({ error: "paymentId is required" })
    }

    const reason = parseNonEmptyString((req.body ?? {}).reason)
    if (!reason) {
      return res.status(400).json({ error: "reason is required" })
    }

    const amountRaw = parseNumber((req.body ?? {}).amount)
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { booking: true },
    })
    if (!payment) {
      return res.status(404).json({ error: "Payment not found" })
    }

    if (payment.status === "refunded") {
      return res.status(409).json({ error: "Payment already refunded" })
    }

    if (payment.driverTransferId) {
      return res.status(409).json({
        error:
          "Cannot refund after driver payout transfer. Reverse transfer in Stripe first.",
        transferId: payment.driverTransferId,
      })
    }

    const requestedAmountCents =
      amountRaw != null ? Math.round(amountRaw * 100) : payment.amountCents

    if (
      !Number.isFinite(requestedAmountCents) ||
      requestedAmountCents <= 0 ||
      requestedAmountCents > payment.amountCents
    ) {
      return res.status(400).json({
        error:
          "amount must be a positive number and cannot exceed original payment amount",
      })
    }

    const idempotencyKey = req.header("Idempotency-Key") ?? undefined

    let refund
    try {
      refund = await stripe.refunds.create(
        {
          payment_intent: payment.paymentIntentId,
          amount: requestedAmountCents,
          reason: "requested_by_customer",
          metadata: {
            paymentId: payment.id,
            bookingId: payment.bookingId,
            source: "admin_refund",
            adminReason: reason,
          },
        },
        idempotencyKey ? { idempotencyKey } : undefined
      )
    } catch (stripeErr) {
      if (
        stripeErr instanceof Stripe.errors.StripeInvalidRequestError &&
        (stripeErr.code === "charge_already_refunded" ||
          String(stripeErr.message).toLowerCase().includes("already refunded"))
      ) {
        return res.status(409).json({ error: "Stripe reports payment already refunded" })
      }
      throw stripeErr
    }

    const [updatedPayment] = await prisma.$transaction([
      prisma.payment.update({
        where: { id: payment.id },
        data: { status: "refunded" },
      }),
      prisma.booking.update({
        where: { id: payment.bookingId },
        data: { paymentStatus: "refunded" },
      }),
    ])

    return res.json({
      payment: serializePayment(updatedPayment),
      refund: {
        id: refund.id,
        amount: refund.amount,
        status: refund.status,
        reason: reason,
      },
    })
  } catch (err) {
    console.error("POST /admin/payments/:paymentId/refund error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function exportPaymentsAdmin(req: Request, res: Response) {
  try {
    const format =
      typeof req.query.format === "string" ? req.query.format.toLowerCase() : "csv"
    const statusFilter =
      typeof req.query.status === "string" ? req.query.status : undefined
    const status = normalizePaymentStatusFilter(statusFilter)
    if (status === "invalid") {
      return res.status(400).json({ error: "Invalid status filter" })
    }

    const dateWindow = parseDateWindow(req.query.dateFrom, req.query.dateTo)
    const where: Record<string, unknown> = {}
    if (status) {
      where.status = status
    }
    if (dateWindow) {
      where.createdAt = dateWindow
    }

    const payments = await prisma.payment.findMany({
      where,
      include: {
        booking: {
          include: {
            ride: {
              select: {
                id: true,
                driverId: true,
                fromCity: true,
                toCity: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 5000,
    })

    const normalized = payments.map((payment) => ({
      id: payment.id,
      bookingId: payment.bookingId,
      rideId: payment.booking.rideId,
      driverId: payment.booking.ride?.driverId ?? null,
      amountCents: payment.amountCents,
      platformFeeCents: payment.platformFeeCents,
      currency: payment.currency,
      status: payment.status,
      paymentIntentId: payment.paymentIntentId,
      createdAt: payment.createdAt.toISOString(),
      updatedAt: payment.updatedAt.toISOString(),
    }))

    if (format === "json") {
      return res.json(normalized)
    }
    if (format !== "csv") {
      return res.status(400).json({ error: "format must be csv or json" })
    }

    return sendCsvResponse(res, "payments-export.csv", normalized)
  } catch (err) {
    console.error("GET /admin/payments/export error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * Analytics / utilities
 */
export async function getDashboardStatsAdmin(req: Request, res: Response) {
  try {
    const dateWindow = parseDateWindow(req.query.dateFrom, req.query.dateTo)
    const rideWhere = dateWindow ? { createdAt: dateWindow } : {}
    const bookingWhere = dateWindow ? { createdAt: dateWindow } : {}
    const paymentWhere = dateWindow ? { createdAt: dateWindow } : {}

    const [
      ridesTotal,
      ridesActive,
      ridesCompleted,
      ridesCancelled,
      bookingsTotal,
      bookingsPending,
      bookingsConfirmed,
      bookingsCompleted,
      driversTotal,
      driversApproved,
      paymentsTotal,
      paymentsPending,
      paymentsPaidAgg,
      routesActive,
      routesTotal,
    ] = await Promise.all([
      prisma.ride.count({ where: rideWhere }),
      prisma.ride.count({
        where: {
          ...rideWhere,
          status: { in: ["open", "ongoing"] },
        },
      }),
      prisma.ride.count({
        where: {
          ...rideWhere,
          status: "completed",
        },
      }),
      prisma.ride.count({
        where: {
          ...rideWhere,
          status: "cancelled",
        },
      }),
      prisma.booking.count({ where: bookingWhere }),
      prisma.booking.count({
        where: {
          ...bookingWhere,
          status: "pending",
        },
      }),
      prisma.booking.count({
        where: {
          ...bookingWhere,
          status: { in: ["confirmed", "ACCEPTED", "PAYMENT_PENDING", "CONFIRMED"] },
        },
      }),
      prisma.booking.count({
        where: {
          ...bookingWhere,
          status: "completed",
        },
      }),
      prisma.driverProfile.count(),
      prisma.driverProfile.count({
        where: { isVerified: true },
      }),
      prisma.payment.count({ where: paymentWhere }),
      prisma.payment.count({
        where: {
          ...paymentWhere,
          status: { in: ["pending", "unpaid"] },
        },
      }),
      prisma.payment.aggregate({
        where: {
          ...paymentWhere,
          status: { in: ["paid", "succeeded"] },
        },
        _sum: {
          amountCents: true,
          platformFeeCents: true,
        },
      }),
      prisma.fixedRoutePrice.count({
        where: { isActive: true },
      }),
      prisma.fixedRoutePrice.count(),
    ])

    const totalAmountCents = paymentsPaidAgg._sum.amountCents ?? 0
    const totalPlatformFeeCents = paymentsPaidAgg._sum.platformFeeCents ?? 0
    const totalDriverAmountCents = totalAmountCents - totalPlatformFeeCents

    return res.json({
      rides: {
        total: ridesTotal,
        active: ridesActive,
        completed: ridesCompleted,
        cancelled: ridesCancelled,
      },
      bookings: {
        total: bookingsTotal,
        pending: bookingsPending,
        confirmed: bookingsConfirmed,
        completed: bookingsCompleted,
      },
      drivers: {
        total: driversTotal,
        approved: driversApproved,
        pending: Math.max(0, driversTotal - driversApproved),
      },
      payments: {
        total: paymentsTotal,
        pending: paymentsPending,
        distributed: paymentsTotal - paymentsPending,
      },
      revenue: {
        total: totalAmountCents / 100,
        platformFee: totalPlatformFeeCents / 100,
        driverAmount: totalDriverAmountCents / 100,
      },
      routes: {
        active: routesActive,
        total: routesTotal,
      },
    })
  } catch (err) {
    console.error("GET /admin/dashboard/stats error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function globalSearchAdmin(req: Request, res: Response) {
  try {
    const q = parseNonEmptyString(req.query.q)
    if (!q) {
      return res.status(400).json({ error: "q is required" })
    }

    const rawTypes =
      typeof req.query.types === "string"
        ? req.query.types
            .split(",")
            .map((type) => type.trim().toLowerCase())
            .filter(Boolean)
        : ["rides", "drivers", "bookings", "users"]

    const allowed = new Set(["rides", "drivers", "bookings", "users"])
    const types = rawTypes.filter((type) => allowed.has(type))
    if (types.length === 0) {
      return res.status(400).json({
        error: "types must include at least one of rides|drivers|bookings|users",
      })
    }

    const rawLimit = Number(req.query.limit ?? 20)
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), 100)
        : 20

    const results: Record<string, unknown[]> = {}

    if (types.includes("rides")) {
      const rides = await prisma.ride.findMany({
        where: {
          OR: [
            { fromCity: { contains: q, mode: "insensitive" } },
            { toCity: { contains: q, mode: "insensitive" } },
            { id: { contains: q, mode: "insensitive" } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: limit,
      })
      results.rides = rides.map(serializeRide)
    }

    if (types.includes("drivers")) {
      const drivers = await prisma.driverProfile.findMany({
        where: {
          user: {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { id: { contains: q, mode: "insensitive" } },
            ],
          },
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              driverDocuments: true,
            },
          },
        },
        take: limit,
      })
      results.drivers = drivers.map(mapDriverAdminShape)
    }

    if (types.includes("bookings")) {
      const bookings = await prisma.booking.findMany({
        where: {
          OR: [
            { id: { contains: q, mode: "insensitive" } },
            { passengerId: { contains: q, mode: "insensitive" } },
            { rideId: { contains: q, mode: "insensitive" } },
          ],
        },
        include: {
          ride: true,
          passenger: {
            select: { id: true, name: true, email: true },
          },
        },
        take: limit,
      })
      results.bookings = bookings
    }

    if (types.includes("users")) {
      const users = await prisma.user.findMany({
        where: {
          OR: [
            { id: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { phone: { contains: q, mode: "insensitive" } },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          roleDefault: true,
          createdAt: true,
          updatedAt: true,
        },
        take: limit,
      })
      results.users = users
    }

    const total = Object.values(results).reduce(
      (count, list) => count + list.length,
      0
    )

    return res.json({ results, total })
  } catch (err) {
    console.error("GET /admin/search error", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
