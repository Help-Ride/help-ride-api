import { Router } from "express"
import prisma from "../lib/prisma.js"
import jwt from "jsonwebtoken"
import { z } from "zod"

const router = Router()

const oauthSchema = z.object({
  provider: z.enum(["google", "apple"]),
  id_token: z.string().min(10),
})

// TODO: replace this with real Google / Apple verification
async function fakeVerifyIdToken(
  provider: "google" | "apple",
  idToken: string
): Promise<{
  providerUserId: string
  email: string
  name: string
  avatarUrl?: string
}> {
  console.warn(
    "WARNING: fakeVerifyIdToken in use. Replace with real verification."
  )
  return {
    providerUserId: `${provider}-${idToken.slice(0, 8)}`,
    email: `fake-${idToken.slice(0, 5)}@example.com`,
    name: "Test User",
    avatarUrl: undefined,
  }
}

router.post("/oauth", async (req, res) => {
  try {
    const parsed = oauthSchema.parse(req.body)
    const { provider, id_token } = parsed

    const claims = await fakeVerifyIdToken(provider, id_token)

    // Find or create user
    let oAuthAccount = await prisma.oAuthAccount.findFirst({
      where: {
        provider,
        providerUserId: claims.providerUserId,
      },
      include: { user: true },
    })

    let user = oAuthAccount?.user

    if (!user) {
      // Try to find user by email
      user =
        (await prisma.user.findUnique({
          where: { email: claims.email },
        })) ?? undefined

      if (!user) {
        user = await prisma.user.create({
          data: {
            email: claims.email,
            name: claims.name,
            emailVerified: true,
            providerAvatarUrl: claims.avatarUrl,
          },
        })
      }

      oAuthAccount = await prisma.oAuthAccount.create({
        data: {
          userId: user.id,
          provider,
          providerUserId: claims.providerUserId,
          providerEmail: claims.email,
        },
        include: { user: true },
      })
    }

    const accessToken = jwt.sign(
      {
        sub: user.id,
        role_default: user.roleDefault,
      },
      process.env.JWT_ACCESS_SECRET as string,
      { expiresIn: "15m" }
    )

    const refreshToken = jwt.sign(
      {
        sub: user.id,
      },
      process.env.JWT_REFRESH_SECRET as string,
      { expiresIn: "7d" }
    )

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        roleDefault: user.roleDefault,
      },
      accessToken,
      refreshToken,
    })
  } catch (err: any) {
    console.error(err)
    if (err.name === "ZodError") {
      return res
        .status(400)
        .json({ error: "Invalid payload", details: err.errors })
    }
    res.status(500).json({ error: "Internal server error" })
  }
})

export default router
