-- C5 (#377): club monthly reports with points, and the yearly registration standing.

-- CreateTable
CREATE TABLE "ClubMonthlyReport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clubYear" TEXT NOT NULL,
    "reportMonth" TEXT NOT NULL,
    "meetingPlace" TEXT NOT NULL DEFAULT '',
    "meetingSchedule" TEXT NOT NULL DEFAULT '',
    "averageAttendance" INTEGER,
    "pathfinderCount" INTEGER,
    "tltCount" INTEGER,
    "staffCount" INTEGER,
    "investitureDate" TEXT,
    "classLevels" "ClubClassLevel"[],
    "points" JSONB NOT NULL,
    "honors" JSONB NOT NULL,
    "onTimePoints" INTEGER NOT NULL,
    "totalPoints" INTEGER NOT NULL,
    "signatureName" TEXT NOT NULL,
    "signedOn" TEXT NOT NULL,
    "firstSubmittedAt" TIMESTAMP(3) NOT NULL,
    "submittedByAccountId" TEXT,
    "updatedByAccountId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubMonthlyReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubYearStanding" (
    "organizationId" TEXT NOT NULL,
    "clubYear" TEXT NOT NULL,
    "registrationOnTime" BOOLEAN NOT NULL DEFAULT false,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubYearStanding_pkey" PRIMARY KEY ("organizationId","clubYear")
);

-- CreateIndex
CREATE INDEX "ClubMonthlyReport_clubYear_reportMonth_idx" ON "ClubMonthlyReport"("clubYear", "reportMonth");

-- CreateIndex
CREATE UNIQUE INDEX "ClubMonthlyReport_organizationId_reportMonth_key" ON "ClubMonthlyReport"("organizationId", "reportMonth");

-- AddForeignKey
ALTER TABLE "ClubMonthlyReport" ADD CONSTRAINT "ClubMonthlyReport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubYearStanding" ADD CONSTRAINT "ClubYearStanding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
