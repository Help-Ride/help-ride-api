-- CreateTable
CREATE TABLE "FixedRoutePrice" (
    "id" TEXT NOT NULL,
    "fromCity" TEXT NOT NULL,
    "toCity" TEXT NOT NULL,
    "pricePerSeat" DECIMAL(10,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FixedRoutePrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FixedRoutePrice_fromCity_idx" ON "FixedRoutePrice"("fromCity");

-- CreateIndex
CREATE INDEX "FixedRoutePrice_toCity_idx" ON "FixedRoutePrice"("toCity");
