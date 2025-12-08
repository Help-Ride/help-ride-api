-- CreateEnum
CREATE TYPE "RideType" AS ENUM ('one_time', 'recurring');

-- CreateEnum
CREATE TYPE "TripType" AS ENUM ('one_way', 'round_trip');

-- AlterTable: Convert existing string values to enum format
-- First, update any existing records to use underscores instead of hyphens
UPDATE "RideRequest" SET "rideType" = 'one_time' WHERE "rideType" = 'one-time';
UPDATE "RideRequest" SET "rideType" = 'recurring' WHERE "rideType" = 'recurring';
UPDATE "RideRequest" SET "tripType" = 'one_way' WHERE "tripType" = 'one-way';
UPDATE "RideRequest" SET "tripType" = 'round_trip' WHERE "tripType" = 'round-trip';

-- AlterTable: Change column types from String to Enum
ALTER TABLE "RideRequest" ALTER COLUMN "rideType" TYPE "RideType" USING "rideType"::"RideType";
ALTER TABLE "RideRequest" ALTER COLUMN "tripType" TYPE "TripType" USING "tripType"::"TripType";

-- CreateIndex
CREATE INDEX "RideRequest_status_idx" ON "RideRequest"("status");

-- CreateIndex
CREATE INDEX "RideRequest_fromCity_idx" ON "RideRequest"("fromCity");

-- CreateIndex
CREATE INDEX "RideRequest_toCity_idx" ON "RideRequest"("toCity");

-- CreateIndex
CREATE INDEX "RideRequest_passengerId_idx" ON "RideRequest"("passengerId");
