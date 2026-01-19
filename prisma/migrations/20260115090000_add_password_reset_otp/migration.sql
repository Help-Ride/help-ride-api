-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordResetOtp" TEXT,
ADD COLUMN     "passwordResetOtpExpiresAt" TIMESTAMP(3),
ADD COLUMN     "passwordResetOtpAttempts" INTEGER NOT NULL DEFAULT 0;
