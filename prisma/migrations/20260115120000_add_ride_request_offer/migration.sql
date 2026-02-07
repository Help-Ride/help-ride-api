-- CreateEnum
CREATE TYPE "RideRequestOfferStatus" AS ENUM ('pending', 'accepted', 'rejected', 'cancelled');

-- CreateTable
CREATE TABLE "RideRequestOffer" (
    "id" TEXT NOT NULL,
    "rideRequestId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "rideId" TEXT NOT NULL,
    "seatsOffered" INTEGER NOT NULL,
    "pricePerSeat" DECIMAL(10,2) NOT NULL,
    "status" "RideRequestOfferStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RideRequestOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RideRequestOffer_rideRequestId_idx" ON "RideRequestOffer"("rideRequestId");

-- CreateIndex
CREATE INDEX "RideRequestOffer_driverId_idx" ON "RideRequestOffer"("driverId");

-- CreateIndex
CREATE INDEX "RideRequestOffer_rideId_idx" ON "RideRequestOffer"("rideId");

-- CreateIndex
CREATE UNIQUE INDEX "RideRequestOffer_rideRequestId_driverId_rideId_key" ON "RideRequestOffer"("rideRequestId", "driverId", "rideId");

-- AddForeignKey
ALTER TABLE "RideRequestOffer" ADD CONSTRAINT "RideRequestOffer_rideRequestId_fkey" FOREIGN KEY ("rideRequestId") REFERENCES "RideRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RideRequestOffer" ADD CONSTRAINT "RideRequestOffer_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RideRequestOffer" ADD CONSTRAINT "RideRequestOffer_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
