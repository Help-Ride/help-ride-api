-- CreateEnum
CREATE TYPE "RideRequestMode" AS ENUM ('OFFER', 'JIT');

-- AlterTable
ALTER TABLE "RideRequest"
ADD COLUMN "mode" "RideRequestMode" NOT NULL DEFAULT 'OFFER',
ADD COLUMN "jitPaymentIntentId" TEXT,
ADD COLUMN "jitAmountCents" INTEGER,
ADD COLUMN "jitCurrency" TEXT,
ADD COLUMN "quotedPricePerSeat" DECIMAL(10,2);

-- CreateIndex
CREATE UNIQUE INDEX "RideRequest_jitPaymentIntentId_key" ON "RideRequest"("jitPaymentIntentId");
