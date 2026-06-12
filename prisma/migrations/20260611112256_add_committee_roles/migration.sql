/*
  Warnings:

  - A unique constraint covering the columns `[userId]` on the table `CommitteeMember` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `userId` to the `CommitteeMember` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "CommitteeMember" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "committeeApartmentId" TEXT,
ADD COLUMN     "committeePosition" "CommitteePosition";

-- CreateIndex
CREATE UNIQUE INDEX "CommitteeMember_userId_key" ON "CommitteeMember"("userId");

-- AddForeignKey
ALTER TABLE "CommitteeMember" ADD CONSTRAINT "CommitteeMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
