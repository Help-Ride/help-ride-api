-- Backfill existing lowercase rows to the new canonical uppercase statuses.
UPDATE "RideRequest"
SET "status" = CASE
  WHEN "status"::text = 'pending' THEN 'PENDING'::"RideRequestStatus"
  WHEN "status"::text = 'matched' THEN 'ACCEPTED'::"RideRequestStatus"
  WHEN "status"::text = 'cancelled' THEN 'CANCELLED'::"RideRequestStatus"
  WHEN "status"::text = 'expired' THEN 'EXPIRED'::"RideRequestStatus"
  ELSE "status"
END;

UPDATE "RideRequestOffer"
SET "status" = CASE
  WHEN "status"::text = 'pending' THEN 'SENT'::"RideRequestOfferStatus"
  WHEN "status"::text = 'accepted' THEN 'ACCEPTED'::"RideRequestOfferStatus"
  WHEN "status"::text = 'rejected' THEN 'REJECTED'::"RideRequestOfferStatus"
  WHEN "status"::text = 'cancelled' THEN 'EXPIRED'::"RideRequestOfferStatus"
  ELSE "status"
END;

ALTER TABLE "RideRequest"
ADD COLUMN IF NOT EXISTS "driverId" TEXT,
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- Keep only the newest offer per (rideRequestId, driverId) before creating a stricter unique index.
DELETE FROM "RideRequestOffer" older
USING "RideRequestOffer" newer
WHERE older."rideRequestId" = newer."rideRequestId"
  AND older."driverId" = newer."driverId"
  AND (
    older."createdAt" < newer."createdAt"
    OR (older."createdAt" = newer."createdAt" AND older."id" < newer."id")
  );

-- Make ride optional for realtime callbacks that only pass driverId.
ALTER TABLE "RideRequestOffer"
DROP CONSTRAINT IF EXISTS "RideRequestOffer_rideId_fkey";

ALTER TABLE "RideRequestOffer"
ALTER COLUMN "rideId" DROP NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'SENT';

DROP INDEX IF EXISTS "RideRequestOffer_rideRequestId_driverId_rideId_key";

CREATE INDEX IF NOT EXISTS "RideRequest_driverId_idx" ON "RideRequest"("driverId");
CREATE UNIQUE INDEX IF NOT EXISTS "RideRequestOffer_rideRequestId_driverId_key"
  ON "RideRequestOffer"("rideRequestId", "driverId");

ALTER TABLE "RideRequest"
ADD CONSTRAINT "RideRequest_driverId_fkey"
FOREIGN KEY ("driverId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RideRequestOffer"
ADD CONSTRAINT "RideRequestOffer_rideId_fkey"
FOREIGN KEY ("rideId") REFERENCES "Ride"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
