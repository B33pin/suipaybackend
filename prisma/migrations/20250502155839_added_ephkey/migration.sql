/*
  Warnings:

  - Added the required column `ephemeralKey` to the `merchants` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "ephemeralKey" TEXT NOT NULL;
