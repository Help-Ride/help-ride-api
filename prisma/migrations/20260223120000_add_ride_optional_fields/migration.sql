-- CreateEnum
CREATE TYPE "RideAmenity" AS ENUM (
  'ac',
  'music',
  'wifi',
  'pet_friendly',
  'luggage_space',
  'child_seat'
);

-- AlterTable
ALTER TABLE "Ride"
ADD COLUMN "stops" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "amenities" "RideAmenity"[] NOT NULL DEFAULT ARRAY[]::"RideAmenity"[],
ADD COLUMN "additionalNotes" TEXT;
