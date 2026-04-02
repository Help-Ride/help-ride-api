-- CreateTable
CREATE TABLE "RideRequestPayment" (
    "id" TEXT NOT NULL,
    "rideRequestId" TEXT NOT NULL,
    "paymentIntentId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "platformFeeCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'cad',
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RideRequestPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RideRequestPayment_rideRequestId_key" ON "RideRequestPayment"("rideRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "RideRequestPayment_paymentIntentId_key" ON "RideRequestPayment"("paymentIntentId");

-- CreateIndex
CREATE INDEX "RideRequestPayment_rideRequestId_idx" ON "RideRequestPayment"("rideRequestId");

-- AddForeignKey
ALTER TABLE "RideRequestPayment" ADD CONSTRAINT "RideRequestPayment_rideRequestId_fkey" FOREIGN KEY ("rideRequestId") REFERENCES "RideRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
