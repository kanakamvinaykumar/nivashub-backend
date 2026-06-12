-- DropForeignKey
ALTER TABLE "AnnouncementComment" DROP CONSTRAINT "AnnouncementComment_announcementId_fkey";

-- DropForeignKey
ALTER TABLE "AnnouncementComment" DROP CONSTRAINT "AnnouncementComment_userId_fkey";

-- AlterTable
ALTER TABLE "Apartment" ADD COLUMN     "logoUrl" TEXT;

-- AlterTable
ALTER TABLE "Flat" ADD COLUMN     "accountActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "tenantEmail" TEXT,
ADD COLUMN     "tenantMobile" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "userId" TEXT,
    "userRole" "Role" NOT NULL,
    "userName" TEXT,
    "userEmail" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityLog_apartmentId_createdAt_idx" ON "ActivityLog"("apartmentId", "createdAt");

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementComment" ADD CONSTRAINT "AnnouncementComment_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementComment" ADD CONSTRAINT "AnnouncementComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "AnnouncementComment_announcementId_index" RENAME TO "AnnouncementComment_announcementId_idx";

-- RenameIndex
ALTER INDEX "AnnouncementComment_userId_index" RENAME TO "AnnouncementComment_userId_idx";
