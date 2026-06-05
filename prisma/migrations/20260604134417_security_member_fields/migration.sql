-- CreateEnum
CREATE TYPE "Shift" AS ENUM ('day', 'night');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "shift" "Shift";
