-- CreateEnum
CREATE TYPE "DueStatus" AS ENUM ('pending', 'pending_verification', 'paid', 'waived');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending_verification', 'approved', 'rejected');

-- AlterTable
ALTER TABLE "Apartment" ADD COLUMN     "bankAccountNumber" TEXT,
ADD COLUMN     "bankIfsc" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "monthlyMaintenanceInr" INTEGER NOT NULL DEFAULT 2000,
ADD COLUMN     "upiId" TEXT,
ADD COLUMN     "upiPayeeName" TEXT,
ADD COLUMN     "upiQrUrl" TEXT;

-- CreateTable
CREATE TABLE "MaintenanceDue" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "flatId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "amountInr" INTEGER NOT NULL,
    "status" "DueStatus" NOT NULL DEFAULT 'pending',
    "paidAt" TIMESTAMP(3),
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceDue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenancePayment" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "flatId" TEXT NOT NULL,
    "flatNumber" TEXT NOT NULL,
    "blockName" TEXT NOT NULL,
    "paidByUserId" TEXT,
    "paidByName" TEXT NOT NULL,
    "amountInr" INTEGER NOT NULL,
    "upiLink" TEXT NOT NULL,
    "transactionNote" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending_verification',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "verifiedByUserId" TEXT,
    "verifiedByName" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedByUserId" TEXT,
    "rejectedByName" TEXT,
    "adminRemarks" TEXT,
    "receiptNumber" TEXT,
    "receiptIssuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenancePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMonth" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "dueId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "amountInr" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentMonth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentScreenshot" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentScreenshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentReceipt" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "amountInr" INTEGER NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "body" TEXT NOT NULL,

    CONSTRAINT "PaymentReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaintenanceDue_apartmentId_status_idx" ON "MaintenanceDue"("apartmentId", "status");

-- CreateIndex
CREATE INDEX "MaintenanceDue_flatId_status_idx" ON "MaintenanceDue"("flatId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceDue_flatId_year_month_key" ON "MaintenanceDue"("flatId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenancePayment_reference_key" ON "MaintenancePayment"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenancePayment_receiptNumber_key" ON "MaintenancePayment"("receiptNumber");

-- CreateIndex
CREATE INDEX "MaintenancePayment_apartmentId_status_idx" ON "MaintenancePayment"("apartmentId", "status");

-- CreateIndex
CREATE INDEX "MaintenancePayment_flatId_submittedAt_idx" ON "MaintenancePayment"("flatId", "submittedAt");

-- CreateIndex
CREATE INDEX "PaymentMonth_paymentId_idx" ON "PaymentMonth"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMonth_paymentId_dueId_key" ON "PaymentMonth"("paymentId", "dueId");

-- CreateIndex
CREATE INDEX "PaymentScreenshot_paymentId_idx" ON "PaymentScreenshot"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReceipt_paymentId_key" ON "PaymentReceipt"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReceipt_receiptNumber_key" ON "PaymentReceipt"("receiptNumber");

-- AddForeignKey
ALTER TABLE "MaintenanceDue" ADD CONSTRAINT "MaintenanceDue_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceDue" ADD CONSTRAINT "MaintenanceDue_flatId_fkey" FOREIGN KEY ("flatId") REFERENCES "Flat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceDue" ADD CONSTRAINT "MaintenanceDue_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "MaintenancePayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePayment" ADD CONSTRAINT "MaintenancePayment_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePayment" ADD CONSTRAINT "MaintenancePayment_flatId_fkey" FOREIGN KEY ("flatId") REFERENCES "Flat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMonth" ADD CONSTRAINT "PaymentMonth_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "MaintenancePayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMonth" ADD CONSTRAINT "PaymentMonth_dueId_fkey" FOREIGN KEY ("dueId") REFERENCES "MaintenanceDue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentScreenshot" ADD CONSTRAINT "PaymentScreenshot_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "MaintenancePayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "MaintenancePayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

