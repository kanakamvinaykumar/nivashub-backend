CREATE TABLE "AnnouncementComment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "announcementId" TEXT NOT NULL,
  "userId" TEXT,
  "userName" TEXT NOT NULL,
  "userRole" "Role" NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "AnnouncementComment"
  ADD CONSTRAINT "AnnouncementComment_announcementId_fkey"
    FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE;

ALTER TABLE "AnnouncementComment"
  ADD CONSTRAINT "AnnouncementComment_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL;

CREATE INDEX "AnnouncementComment_announcementId_index" ON "AnnouncementComment"("announcementId");
CREATE INDEX "AnnouncementComment_userId_index" ON "AnnouncementComment"("userId");
