// src/lib/prisma.ts
import "dotenv/config" // ✅ load .env before anything else

import { PrismaClient } from "../generated/prisma/client.js"
import { PrismaPg } from "@prisma/adapter-pg"

const url = process.env.DATABASE_URL

if (!url) {
  throw new Error("DATABASE_URL is not set – check your .env")
}

console.log("Prisma using DATABASE_URL:", url) // ✅ TEMP: verify Neon URL shows up

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient
}

const adapter = new PrismaPg({
  connectionString: url,
})

const client = new PrismaClient({ adapter })

export const prisma = globalForPrisma.prisma ?? client

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}

export default prisma
