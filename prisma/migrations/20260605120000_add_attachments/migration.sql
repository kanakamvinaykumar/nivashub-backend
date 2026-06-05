-- Add attachments arrays to complaints and announcements.
ALTER TABLE "Announcement" ADD COLUMN "attachments" text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE "Complaint" ADD COLUMN "attachments" text[] NOT NULL DEFAULT ARRAY[]::text[];
