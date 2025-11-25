// src/lib/prisma.ts
import { PrismaClient } from "../generated/prisma/client.js"
// If you're on Postgres, also:
// import { PrismaPg } from '@prisma/adapter-pg'

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient
}

// If Postgres, you'd do:
// const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
// const client = new PrismaClient({ adapter })

const client = new PrismaClient()

export const prisma = globalForPrisma.prisma ?? client

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}

export default prisma
