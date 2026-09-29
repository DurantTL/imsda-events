-- #607: the Pathfinder Year-End Report, one draft or submitted record per club per Pathfinder year. Additive only.

-- CreateTable
CREATE TABLE "ClubYearEndReport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reportYear" TEXT NOT NULL,
    "status" "ClubReportStatus" NOT NULL DEFAULT 'DRAFT',
    "contactName" TEXT NOT NULL DEFAULT '',
    "contactWorkPhone" TEXT NOT NULL DEFAULT '',
    "contactHomePhone" TEXT NOT NULL DEFAULT '',
    "contactCellPhone" TEXT NOT NULL DEFAULT '',
    "contactEmail" TEXT NOT NULL DEFAULT '',
    "prefill" JSONB NOT NULL DEFAULT '{}',
    "overrides" JSONB NOT NULL DEFAULT '{}',
    "manual" JSONB NOT NULL DEFAULT '{}',
    "submittedAt" TIMESTAMP(3),
    "firstSubmittedAt" TIMESTAMP(3),
    "submittedByAccountId" TEXT,
    "updatedByAccountId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubYearEndReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubYearEndReport_reportYear_status_idx" ON "ClubYearEndReport"("reportYear", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ClubYearEndReport_organizationId_reportYear_key" ON "ClubYearEndReport"("organizationId", "reportYear");

-- AddForeignKey
ALTER TABLE "ClubYearEndReport" ADD CONSTRAINT "ClubYearEndReport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
