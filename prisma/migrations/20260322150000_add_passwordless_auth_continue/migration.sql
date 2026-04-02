CREATE TYPE "AccountStatus" AS ENUM ('active', 'locked', 'suspended', 'deleted');
CREATE TYPE "AuthChallengeChannel" AS ENUM ('phone', 'email');

ALTER TABLE "User"
  ALTER COLUMN "email" DROP NOT NULL,
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "appleProviderId" TEXT,
  ADD COLUMN "googleProviderId" TEXT,
  ADD COLUMN "authMethods" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "lastLoginAt" TIMESTAMP(3),
  ADD COLUMN "accountStatus" "AccountStatus" NOT NULL DEFAULT 'active';

CREATE UNIQUE INDEX "User_appleProviderId_key" ON "User"("appleProviderId");
CREATE UNIQUE INDEX "User_googleProviderId_key" ON "User"("googleProviderId");

UPDATE "User"
SET "emailVerifiedAt" = COALESCE("emailVerifiedAt", "updatedAt")
WHERE "emailVerified" = true AND "emailVerifiedAt" IS NULL;

UPDATE "User"
SET "phoneVerifiedAt" = COALESCE("phoneVerifiedAt", "updatedAt")
WHERE "phoneVerified" = true AND "phoneVerifiedAt" IS NULL;

UPDATE "User"
SET "authMethods" = ARRAY_REMOVE(
  ARRAY[
    CASE WHEN "phone" IS NOT NULL AND "phoneVerified" = true THEN 'phone' END,
    CASE WHEN "email" IS NOT NULL AND "emailVerified" = true THEN 'email_otp' END,
    CASE WHEN "passwordHash" IS NOT NULL THEN 'legacy_password' END
  ],
  NULL
);

UPDATE "User" AS u
SET "appleProviderId" = oa."providerUserId"
FROM "OAuthAccount" AS oa
WHERE oa."userId" = u."id"
  AND oa."provider" = 'apple';

UPDATE "User" AS u
SET "googleProviderId" = oa."providerUserId"
FROM "OAuthAccount" AS oa
WHERE oa."userId" = u."id"
  AND oa."provider" = 'google';

UPDATE "User" AS u
SET "authMethods" = CASE
  WHEN 'apple' = ANY(u."authMethods") THEN u."authMethods"
  ELSE array_append(u."authMethods", 'apple')
END
FROM "OAuthAccount" AS oa
WHERE oa."userId" = u."id"
  AND oa."provider" = 'apple';

UPDATE "User" AS u
SET "authMethods" = CASE
  WHEN 'google' = ANY(u."authMethods") THEN u."authMethods"
  ELSE array_append(u."authMethods", 'google')
END
FROM "OAuthAccount" AS oa
WHERE oa."userId" = u."id"
  AND oa."provider" = 'google';

CREATE TABLE "AuthChallenge" (
  "id" TEXT NOT NULL,
  "channel" "AuthChallengeChannel" NOT NULL,
  "identifier" TEXT NOT NULL,
  "userId" TEXT,
  "otp" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "resendAvailableAt" TIMESTAMP(3) NOT NULL,
  "verifyAttempts" INTEGER NOT NULL DEFAULT 0,
  "sendCount" INTEGER NOT NULL DEFAULT 1,
  "lockedUntil" TIMESTAMP(3),
  "requestedFromIp" TEXT,
  "requestedFromDevice" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuthChallenge_identifier_idx" ON "AuthChallenge"("identifier");
CREATE INDEX "AuthChallenge_channel_identifier_createdAt_idx"
  ON "AuthChallenge"("channel", "identifier", "createdAt");
CREATE INDEX "AuthChallenge_requestedFromIp_createdAt_idx"
  ON "AuthChallenge"("requestedFromIp", "createdAt");
CREATE INDEX "AuthChallenge_requestedFromDevice_createdAt_idx"
  ON "AuthChallenge"("requestedFromDevice", "createdAt");
CREATE INDEX "AuthChallenge_expiresAt_idx" ON "AuthChallenge"("expiresAt");

ALTER TABLE "AuthChallenge"
  ADD CONSTRAINT "AuthChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
