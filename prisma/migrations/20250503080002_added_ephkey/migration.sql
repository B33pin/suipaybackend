-- CreateTable
CREATE TABLE "ephemeral_deposits" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "amount" TEXT,

    CONSTRAINT "ephemeral_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ephemeral_deposits_address_key" ON "ephemeral_deposits"("address");

-- CreateIndex
CREATE INDEX "ephemeral_deposits_merchantId_idx" ON "ephemeral_deposits"("merchantId");

-- CreateIndex
CREATE INDEX "ephemeral_deposits_address_idx" ON "ephemeral_deposits"("address");

-- AddForeignKey
ALTER TABLE "ephemeral_deposits" ADD CONSTRAINT "ephemeral_deposits_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
