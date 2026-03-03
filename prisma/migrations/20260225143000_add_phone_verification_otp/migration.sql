-- AlterTable
ALTER TABLE "User"
ADD COLUMN     "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "phoneVerifyOtp" TEXT,
ADD COLUMN     "phoneVerifyOtpExpiresAt" TIMESTAMP(3),
ADD COLUMN     "phoneVerifyOtpAttempts" INTEGER NOT NULL DEFAULT 0;
