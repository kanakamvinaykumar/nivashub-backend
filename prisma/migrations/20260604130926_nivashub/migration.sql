-- CreateEnum
CREATE TYPE "OccupantType" AS ENUM ('resident', 'tenant');

-- CreateEnum
CREATE TYPE "CommitteePosition" AS ENUM ('president', 'secretary', 'treasurer', 'maintenance', 'cultural', 'security');

-- AlterTable
ALTER TABLE "Apartment" ADD COLUMN     "registeredEmail" TEXT;

-- AlterTable
ALTER TABLE "Flat" ADD COLUMN     "blockId" TEXT,
ADD COLUMN     "occupantType" "OccupantType" NOT NULL DEFAULT 'resident',
ADD COLUMN     "ownerEmail" TEXT,
ADD COLUMN     "ownerMobile" TEXT,
ADD COLUMN     "tenantName" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Block" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlatOwner" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "flatId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlatOwner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Amenity" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "Amenity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocietyRule" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "SocietyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommitteeMember" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "position" "CommitteePosition" NOT NULL,
    "name" TEXT NOT NULL,
    "flatNumber" TEXT,
    "phone" TEXT,
    "email" TEXT,

    CONSTRAINT "CommitteeMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Block_apartmentId_name_key" ON "Block"("apartmentId", "name");

-- CreateIndex
CREATE INDEX "FlatOwner_flatId_idx" ON "FlatOwner"("flatId");

-- CreateIndex
CREATE UNIQUE INDEX "FlatOwner_userId_flatId_key" ON "FlatOwner"("userId", "flatId");

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flat" ADD CONSTRAINT "Flat_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "Block"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlatOwner" ADD CONSTRAINT "FlatOwner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlatOwner" ADD CONSTRAINT "FlatOwner_flatId_fkey" FOREIGN KEY ("flatId") REFERENCES "Flat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Amenity" ADD CONSTRAINT "Amenity_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocietyRule" ADD CONSTRAINT "SocietyRule_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommitteeMember" ADD CONSTRAINT "CommitteeMember_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
