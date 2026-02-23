CREATE TABLE "UserLocation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracyMeters" DOUBLE PRECISION,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserLocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserLocation_userId_key" ON "UserLocation"("userId");
CREATE INDEX "UserLocation_lat_lng_idx" ON "UserLocation"("lat", "lng");
CREATE INDEX "UserLocation_updatedAt_idx" ON "UserLocation"("updatedAt");

ALTER TABLE "UserLocation"
ADD CONSTRAINT "UserLocation_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
