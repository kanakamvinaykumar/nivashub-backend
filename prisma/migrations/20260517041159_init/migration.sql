-- CreateEnum
CREATE TYPE "Role" AS ENUM ('super_admin', 'apartment_admin', 'flat_admin', 'security');

-- CreateEnum
CREATE TYPE "ApartmentStatus" AS ENUM ('active', 'trial', 'suspended');

-- CreateEnum
CREATE TYPE "PlanCycle" AS ENUM ('monthly', 'yearly', 'five_year');

-- CreateEnum
CREATE TYPE "FlatStatus" AS ENUM ('occupied', 'vacant', 'rented');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('low', 'normal', 'urgent');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('confirmed', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('active', 'sold', 'archived');

-- CreateEnum
CREATE TYPE "VisitorType" AS ENUM ('guest', 'contractor', 'delivery');

-- CreateEnum
CREATE TYPE "VisitorStatus" AS ENUM ('active', 'used', 'expired', 'cancelled');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "apartmentId" TEXT,
    "apartmentName" TEXT,
    "flatId" TEXT,
    "flatNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Apartment" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "totalFlats" INTEGER NOT NULL,
    "occupiedFlats" INTEGER NOT NULL,
    "planTier" TEXT NOT NULL,
    "planCycle" "PlanCycle" NOT NULL,
    "planExpiresAt" TIMESTAMP(3) NOT NULL,
    "monthlyRevenue" INTEGER NOT NULL,
    "status" "ApartmentStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Apartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Flat" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "block" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "residentCount" INTEGER NOT NULL,
    "status" "FlatStatus" NOT NULL,
    "pendingDuesInr" INTEGER NOT NULL,

    CONSTRAINT "Flat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resident" (
    "id" TEXT NOT NULL,
    "flatId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "phone" TEXT NOT NULL,

    CONSTRAINT "Resident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "priority" "Priority" NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "authorName" TEXT NOT NULL,
    "commentsCount" INTEGER NOT NULL DEFAULT 0,
    "seenCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "flatNumber" TEXT NOT NULL,
    "residentName" TEXT NOT NULL,
    "court" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "status" "BookingStatus" NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "tags" TEXT[],
    "sellerName" TEXT NOT NULL,
    "sellerFlat" TEXT NOT NULL,
    "status" "ListingStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitorPass" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "flatId" TEXT NOT NULL,
    "flatNumber" TEXT NOT NULL,
    "guestName" TEXT NOT NULL,
    "type" "VisitorType" NOT NULL,
    "code" TEXT NOT NULL,
    "status" "VisitorStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisitorPass_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Apartment_code_key" ON "Apartment"("code");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_flatId_fkey" FOREIGN KEY ("flatId") REFERENCES "Flat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flat" ADD CONSTRAINT "Flat_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resident" ADD CONSTRAINT "Resident_flatId_fkey" FOREIGN KEY ("flatId") REFERENCES "Flat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorPass" ADD CONSTRAINT "VisitorPass_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorPass" ADD CONSTRAINT "VisitorPass_flatId_fkey" FOREIGN KEY ("flatId") REFERENCES "Flat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
