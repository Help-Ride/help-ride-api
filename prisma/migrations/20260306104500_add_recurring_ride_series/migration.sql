-- AlterTable
ALTER TABLE "Ride"
ADD COLUMN "rideType" TEXT NOT NULL DEFAULT 'one-time',
ADD COLUMN "recurringSeriesId" TEXT,
ADD COLUMN "recurrenceDays" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "recurrenceEndDate" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Ride_recurringSeriesId_idx" ON "Ride"("recurringSeriesId");
