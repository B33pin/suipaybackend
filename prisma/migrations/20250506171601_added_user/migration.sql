/*
  Warnings:

  - Added the required column `ownerType` to the `ephemeral_deposits` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "ephemeral_deposits" DROP CONSTRAINT "ephemeral_deposits_merchantId_fkey";

-- AlterTable
ALTER TABLE "ephemeral_deposits" ADD COLUMN     "ownerType" TEXT NOT NULL,
ADD COLUMN     "userId" TEXT,
ALTER COLUMN "merchantId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "password" TEXT NOT NULL,
    "email" TEXT NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_id_key" ON "users"("id");

-- CreateIndex
CREATE UNIQUE INDEX "users_wallet_key" ON "users"("wallet");

-- AddForeignKey
ALTER TABLE "ephemeral_deposits" ADD CONSTRAINT "ephemeral_deposits_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ephemeral_deposits" ADD CONSTRAINT "ephemeral_deposits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
