ALTER TABLE "Payment"
ADD COLUMN "driverTransferId" TEXT,
ADD COLUMN "driverTransferAmountCents" INTEGER,
ADD COLUMN "driverTransferredAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Payment_driverTransferId_key" ON "Payment"("driverTransferId");
