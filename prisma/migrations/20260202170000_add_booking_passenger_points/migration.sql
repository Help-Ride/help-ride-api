-- AlterTable
ALTER TABLE "Booking"
ADD COLUMN "passengerPickupLat" DOUBLE PRECISION,
ADD COLUMN "passengerPickupLng" DOUBLE PRECISION,
ADD COLUMN "passengerDropoffLat" DOUBLE PRECISION,
ADD COLUMN "passengerDropoffLng" DOUBLE PRECISION;
