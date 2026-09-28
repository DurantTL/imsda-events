-- Q1 (#490): director-owned roster export formats. Stores only the chosen
-- columns, their order, and header names — never a copy of any roster row.

-- CreateTable
CREATE TABLE "ClubRosterExportFormat" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "createdByAccountId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubRosterExportFormat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClubRosterExportFormat_organizationId_name_key" ON "ClubRosterExportFormat"("organizationId", "name");

-- AddForeignKey
ALTER TABLE "ClubRosterExportFormat" ADD CONSTRAINT "ClubRosterExportFormat_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubRosterExportFormat" ADD CONSTRAINT "ClubRosterExportFormat_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubRosterExportFormat" ADD CONSTRAINT "ClubRosterExportFormat_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
