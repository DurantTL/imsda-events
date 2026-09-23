import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  clubYearMonths,
  isLockedForClub,
  onTimePoints,
  pickedTotal,
  reportDueDate,
  reportProblems,
  type PickedPoints,
  type ReportHonor,
} from "@/modules/club-reports/domain";
import type { ClubReportInput } from "@/modules/club-reports/schemas";
import { calendarDateIn } from "@/modules/calendar/domain";
import { clubYearFor, type ClubClassLevel } from "@/modules/club-rosters/domain";

/**
 * Club monthly report storage (#377). Totals are always worked out here from
 * the picked values and the first submission time; nothing the browser sends
 * is trusted as a total.
 */

export type ClubReportErrorCode = "CLUB_REPORT_LOCKED" | "CLUB_REPORT_MONTH_INVALID" | "CLUB_REPORT_INVALID_POINTS" | "CLUB_NOT_FOUND";

export class ClubReportError extends Error {
  constructor(public readonly code: ClubReportErrorCode, message: string) {
    super(message);
    this.name = "ClubReportError";
  }
}

export type ClubReportActor = { accountId: string } | { userId: string };

const reportSelect = {
  id: true,
  organizationId: true,
  clubYear: true,
  reportMonth: true,
  meetingPlace: true,
  meetingSchedule: true,
  averageAttendance: true,
  pathfinderCount: true,
  tltCount: true,
  staffCount: true,
  investitureDate: true,
  classLevels: true,
  points: true,
  honors: true,
  onTimePoints: true,
  totalPoints: true,
  signatureName: true,
  signedOn: true,
  firstSubmittedAt: true,
  updatedAt: true,
} satisfies Prisma.ClubMonthlyReportSelect;

type StoredReport = Prisma.ClubMonthlyReportGetPayload<{ select: typeof reportSelect }>;

function serializeReport(report: StoredReport) {
  return {
    ...report,
    classLevels: report.classLevels as ClubClassLevel[],
    points: (report.points ?? {}) as PickedPoints,
    honors: (Array.isArray(report.honors) ? report.honors : []) as ReportHonor[],
    firstSubmittedAt: report.firstSubmittedAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
  };
}

export type ClubReportRecord = ReturnType<typeof serializeReport>;

/** What a new report starts from: the club profile's meeting details and this year's roster counts. */
export async function reportPrefill(organizationId: string, now = new Date()) {
  const prisma = getPrisma();
  const clubYear = clubYearFor(now);
  const [profile, members] = await Promise.all([
    prisma.clubProfile.findUnique({ where: { organizationId }, select: { meetingPlace: true, meetingSchedule: true } }),
    prisma.clubRosterMember.findMany({ where: { organizationId, clubYear, status: "ACTIVE" }, select: { attendeeType: true, classLevel: true } }),
  ]);
  return {
    meetingPlace: profile?.meetingPlace ?? "",
    meetingSchedule: profile?.meetingSchedule ?? "",
    pathfinderCount: members.filter((member) => member.attendeeType === "YOUTH" || member.attendeeType === "UNDERAGE").length,
    tltCount: members.filter((member) => member.classLevel === "TLT").length,
    staffCount: members.filter((member) => member.attendeeType === "STAFF" || member.attendeeType === "ADULT").length,
  };
}

export async function getClubReport(organizationId: string, reportMonth: string) {
  const report = await getPrisma().clubMonthlyReport.findUnique({
    where: { organizationId_reportMonth: { organizationId, reportMonth } },
    select: reportSelect,
  });
  return report ? serializeReport(report) : null;
}

/** A club's year: every month, its report if any, and the year-to-date standing. */
export async function getClubReportYear(organizationId: string, clubYear: string) {
  const prisma = getPrisma();
  const [reports, standing] = await Promise.all([
    prisma.clubMonthlyReport.findMany({ where: { organizationId, clubYear }, select: reportSelect, orderBy: { reportMonth: "asc" } }),
    prisma.clubYearStanding.findUnique({ where: { organizationId_clubYear: { organizationId, clubYear } }, select: { registrationOnTime: true } }),
  ]);
  return { reports: reports.map(serializeReport), registrationOnTime: standing?.registrationOnTime ?? false };
}

/**
 * Saves a report. A club may submit a month up to the current one, and may
 * change it until the due date; after that only staff can. On-time points
 * come from the first submission and never change on later edits.
 */
export async function saveClubReport(
  organizationId: string,
  reportMonth: string,
  input: ClubReportInput,
  actor: ClubReportActor,
  now = new Date(),
) {
  const clubYear = clubYearFor(new Date(`${reportMonth}-15T12:00:00Z`));
  if (!clubYearMonths(clubYear).includes(reportMonth) || reportMonth > calendarDateIn(now).slice(0, 7)) {
    throw new ClubReportError("CLUB_REPORT_MONTH_INVALID", "Reports can be filed for this month or earlier months only.");
  }
  const problems = reportProblems({ points: input.points, honors: input.honors, classLevels: input.classLevels });
  if (problems.length > 0) throw new ClubReportError("CLUB_REPORT_INVALID_POINTS", problems.map((problem) => problem.message).join(" "));

  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const club = await tx.organization.findUnique({ where: { id: organizationId }, select: { type: true, name: true } });
    if (!club || club.type !== "CLUB") throw new ClubReportError("CLUB_NOT_FOUND", "That club could not be found.");
    const existing = await tx.clubMonthlyReport.findUnique({
      where: { organizationId_reportMonth: { organizationId, reportMonth } },
      select: { id: true, firstSubmittedAt: true },
    });
    const isClub = "accountId" in actor;
    if (existing && isClub && isLockedForClub(reportMonth, now)) {
      throw new ClubReportError(
        "CLUB_REPORT_LOCKED",
        `This report closed after ${reportDueDate(reportMonth)}. Ask the conference office if something needs to change.`,
      );
    }
    const firstSubmittedAt = existing?.firstSubmittedAt ?? now;
    const onTime = onTimePoints(reportMonth, firstSubmittedAt);
    const points: PickedPoints = Object.fromEntries(Object.entries(input.points).filter(([, value]) => value !== undefined));
    const honors = input.honors.filter((honor) => honor.name.trim() || honor.participants !== null);
    const data = {
      clubYear,
      meetingPlace: input.meetingPlace,
      meetingSchedule: input.meetingSchedule,
      averageAttendance: input.averageAttendance,
      pathfinderCount: input.pathfinderCount,
      tltCount: input.tltCount,
      staffCount: input.staffCount,
      investitureDate: input.investitureDate,
      classLevels: input.classLevels,
      points,
      honors,
      onTimePoints: onTime,
      totalPoints: onTime + pickedTotal(points),
      signatureName: input.signatureName,
      signedOn: input.signedOn,
      ...(isClub ? { updatedByAccountId: actor.accountId, updatedByUserId: null } : { updatedByUserId: actor.userId }),
    };
    const saved = existing
      ? await tx.clubMonthlyReport.update({ where: { id: existing.id }, data, select: reportSelect })
      : await tx.clubMonthlyReport.create({
        data: {
          ...data,
          organizationId,
          reportMonth,
          firstSubmittedAt,
          ...(isClub ? { submittedByAccountId: actor.accountId } : {}),
        },
        select: reportSelect,
      });
    await writeAuditLog({
      ...(isClub ? {} : { actorUserId: actor.userId }),
      action: existing ? "CLUB_REPORT_UPDATED" : "CLUB_REPORT_SUBMITTED",
      entityType: "ClubMonthlyReport",
      entityId: saved.id,
      summary: `${existing ? "Updated" : "Submitted"} the ${reportMonth} monthly report for ${club.name}.`,
      metadata: {
        organizationId,
        reportMonth,
        totalPoints: saved.totalPoints,
        onTimePoints: onTime,
        ...(isClub ? { actorAttendeeAccountId: actor.accountId } : {}),
      },
    }, tx);
    return serializeReport(saved);
  });
}

/** The conference view (#377): every active club, its reports for the year, and its standing. */
export async function listClubReportsForYear(clubYear: string) {
  const prisma = getPrisma();
  const [clubs, reports, standings] = await Promise.all([
    prisma.organization.findMany({
      where: { type: "CLUB", isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, parentOrganization: { select: { name: true } } },
    }),
    prisma.clubMonthlyReport.findMany({
      where: { clubYear },
      select: { organizationId: true, reportMonth: true, totalPoints: true, onTimePoints: true, firstSubmittedAt: true },
    }),
    prisma.clubYearStanding.findMany({ where: { clubYear }, select: { organizationId: true, registrationOnTime: true } }),
  ]);
  const onTimeByClub = new Map(standings.map((standing) => [standing.organizationId, standing.registrationOnTime]));
  return clubs.map((club) => ({
    id: club.id,
    name: club.name,
    church: club.parentOrganization?.name ?? "",
    registrationOnTime: onTimeByClub.get(club.id) ?? false,
    reports: Object.fromEntries(reports
      .filter((report) => report.organizationId === club.id)
      .map((report) => [report.reportMonth, { totalPoints: report.totalPoints, onTime: report.onTimePoints > 0 }])) as Record<string, { totalPoints: number; onTime: boolean }>,
  }));
}

export type ClubYearSummary = Awaited<ReturnType<typeof listClubReportsForYear>>[number];

export async function setRegistrationOnTime(organizationId: string, clubYear: string, registrationOnTime: boolean, actorUserId: string) {
  const prisma = getPrisma();
  const club = await prisma.organization.findUnique({ where: { id: organizationId }, select: { type: true } });
  if (!club || club.type !== "CLUB") throw new ClubReportError("CLUB_NOT_FOUND", "That club could not be found.");
  await prisma.clubYearStanding.upsert({
    where: { organizationId_clubYear: { organizationId, clubYear } },
    create: { organizationId, clubYear, registrationOnTime, updatedByUserId: actorUserId },
    update: { registrationOnTime, updatedByUserId: actorUserId },
  });
  await writeAuditLog({
    actorUserId,
    action: "CLUB_REGISTRATION_STANDING_SET",
    entityType: "Organization",
    entityId: organizationId,
    summary: `Marked the ${clubYear} yearly registration as ${registrationOnTime ? "on time" : "not on time"}.`,
    metadata: { organizationId, clubYear, registrationOnTime },
  });
}
