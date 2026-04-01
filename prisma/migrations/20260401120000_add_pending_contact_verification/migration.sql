ALTER TABLE "User"
ADD COLUMN "pendingEmail" TEXT,
ADD COLUMN "pendingPhone" TEXT;

CREATE UNIQUE INDEX "User_pendingEmail_key" ON "User"("pendingEmail");
CREATE UNIQUE INDEX "User_pendingPhone_key" ON "User"("pendingPhone");
