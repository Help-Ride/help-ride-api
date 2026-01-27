/*
  Warnings:

  - You are about to drop the column `amount` on the `Payment` table. All the data in the column will be lost.
  - You are about to drop the column `stripePaymentIntentId` on the `Payment` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[paymentIntentId]` on the table `Payment` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[stripeAccountId]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `amountCents` to the `Payment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `paymentIntentId` to the `Payment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `platformFeeCents` to the `Payment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Payment` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BookingStatus" ADD VALUE 'ACCEPTED';
ALTER TYPE "BookingStatus" ADD VALUE 'PAYMENT_PENDING';
ALTER TYPE "BookingStatus" ADD VALUE 'CONFIRMED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentStatus" ADD VALUE 'pending';
ALTER TYPE "PaymentStatus" ADD VALUE 'succeeded';
ALTER TYPE "PaymentStatus" ADD VALUE 'failed';

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "amount",
DROP COLUMN "stripePaymentIntentId",
ADD COLUMN     "amountCents" INTEGER NOT NULL,
ADD COLUMN     "paymentIntentId" TEXT NOT NULL,
ADD COLUMN     "platformFeeCents" INTEGER NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "stripeAccountId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_paymentIntentId_key" ON "Payment"("paymentIntentId");

-- CreateIndex
CREATE INDEX "Payment_bookingId_idx" ON "Payment"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeAccountId_key" ON "User"("stripeAccountId");
