-- CreateEnum
CREATE TYPE "ComplaintCategory" AS ENUM ('plumbing', 'electrical', 'lift', 'parking', 'security', 'cleaning', 'other');

-- CreateEnum
CREATE TYPE "ComplaintPriority" AS ENUM ('low', 'medium', 'high', 'emergency');

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('active', 'pending', 'in_progress', 'declined', 'closed');

-- CreateEnum
CREATE TYPE "ComplaintMessageType" AS ENUM ('message', 'status_change');

-- CreateTable
CREATE TABLE "Complaint" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "flatId" TEXT NOT NULL,
    "flatNumber" TEXT NOT NULL,
    "blockName" TEXT NOT NULL,
    "raisedByUserId" TEXT,
    "raisedByName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "ComplaintCategory" NOT NULL,
    "priority" "ComplaintPriority" NOT NULL DEFAULT 'medium',
    "status" "ComplaintStatus" NOT NULL DEFAULT 'active',
    "contactNumber" TEXT NOT NULL,
    "preferredVisitTime" TEXT,
    "assignedTo" TEXT,
    "adminRemarks" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplaintMessage" (
    "id" TEXT NOT NULL,
    "complaintId" TEXT NOT NULL,
    "senderUserId" TEXT,
    "senderName" TEXT NOT NULL,
    "senderRole" "Role" NOT NULL,
    "type" "ComplaintMessageType" NOT NULL DEFAULT 'message',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplaintMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Complaint_apartmentId_status_idx" ON "Complaint"("apartmentId", "status");

-- CreateIndex
CREATE INDEX "Complaint_flatId_idx" ON "Complaint"("flatId");

-- CreateIndex
CREATE INDEX "Complaint_apartmentId_category_idx" ON "Complaint"("apartmentId", "category");

-- CreateIndex
CREATE INDEX "Complaint_apartmentId_priority_idx" ON "Complaint"("apartmentId", "priority");

-- CreateIndex
CREATE INDEX "ComplaintMessage_complaintId_createdAt_idx" ON "ComplaintMessage"("complaintId", "createdAt");

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_flatId_fkey" FOREIGN KEY ("flatId") REFERENCES "Flat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintMessage" ADD CONSTRAINT "ComplaintMessage_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "Complaint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

