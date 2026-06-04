-- CreateEnum
CREATE TYPE "DueKind" AS ENUM ('monthly', 'yearly_amc');

-- AlterTable
ALTER TABLE "Flat" ADD COLUMN     "monthlyMaintenanceInr" INTEGER NOT NULL DEFAULT 2000,
ADD COLUMN     "yearlyAmcInr" INTEGER NOT NULL DEFAULT 9000;

-- AlterTable
ALTER TABLE "MaintenanceDue" ADD COLUMN     "kind" "DueKind" NOT NULL DEFAULT 'monthly';

