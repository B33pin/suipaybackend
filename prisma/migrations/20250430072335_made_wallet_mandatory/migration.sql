/*
  Warnings:

  - Made the column `wallet` on table `merchants` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "merchants" ALTER COLUMN "wallet" SET NOT NULL;
