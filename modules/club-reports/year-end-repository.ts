import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { ClubReportError, type ClubReportActor } from "@/modules/club-reports/repository";
import {
  ageReferenceDate,
  isLateYearEndReport,
  isReportYearReportable,
  isYearEndLockedForClub,
  prefillFromRoster,
  countUndatedHonorCompletions,
  prefillHonorsForClub,
  prefillInvestitures,
  reportYearRange,
  resolveYearEnd,
  resolvedCounts,
  wasActiveDuringYear,
  splitYearEndValues,
  yearEndTotals,
  type RosterCountMember,
  type YearEndPrefill,
} from "@/modules/club-reports/year-end-domain";
import type { YearEndReportInput } from "@/modules/club-reports/year-end-schemas";
import { ageOn } from "@/modules/club-rosters/domain";
import { openBirthDate } from "@/modules/club-rosters/birth-dates";

/**
 * Year-End Report storage (#607). Counts only: nothing here reads or keeps a
 * name. Pre-fill is worked out on the server from the club's roster, class
 * completions, and current (non-voided) honor status; the browser never
 * supplies a pre-filled number as truth or any total.
 */

/**
 * The pre-filled numbers for one club and Pathfinder year. Reads rosters,
 * class completions, and honor entries, and returns counts only: no read here
 * selects a name.
 */
export async function yearEndPrefill(organizationId: string, reportYear: string, now = new Date()) {
  const prisma = getPrisma();
  const range = reportYearRange(reportYear);
  const asOf = ageReferenceDate(reportYear, now);
  const [rosterRows, completions] = await Promise.all([
    prisma.clubRosterMember.findMany({
      where: { organizationId, clubYear: reportYear },
      select: {
        attendeeType: true, classLevel: true, gender: true, reportedAge: true, sealedBirthDate: true,
        personId: true, status: true, removedAt: true, updatedAt: true,
      },
    }),
    prisma.memberClassCompletion.findMany({
      where: { organizationId, completedOn: { gte: range.start, lte: range.end } },
      select: { classLevel: true, completedOn: true },
    }),
  ]);
  // Anyone active at some point in the year, for the counts and for honors alike.
  const roster = rosterRows.filter((row) => wasActiveDuringYear(row, reportYear));

  const members: RosterCountMember[] = roster.map((row) => {
    let age: number | null = null;
    if (row.sealedBirthDate) {
      try {
        age = ageOn(openBirthDate(row.sealedBirthDate), asOf);
      } catch {
        age = null;
      }
    }
    return {
      attendeeType: row.attendeeType,
      classLevel: row.classLevel,
      gender: row.gender,
      age: age ?? row.reportedAge,
    };
  });
  const rosterCounts = prefillFromRoster(members);

  // Honors: counts only. The read selects no name, note, or void reason, and
  // the entry's own club decides whether it is this club's to count.
  const personIds = [...new Set(roster.flatMap((row) => (row.personId ? [row.personId] : [])))];
  const entries = personIds.length === 0 ? [] : await prisma.memberHonorEntry.findMany({
    where: { personId: { in: personIds } },
    orderBy: { seq: "desc" },
    select: {
      personId: true, honorId: true, status: true, completionDate: true, organizationId: true,
      void: { select: { id: true } },
      honor: { select: { category: true } },
    },
  });
  const facts = entries.map((entry) => ({
    personId: entry.personId,
    honorId: entry.honorId,
    status: entry.status,
    completionDate: entry.completionDate,
    organizationId: entry.organizationId,
    voided: entry.void !== null,
    isMaster: entry.honor.category === "MASTER_AWARDS",
  }));
  const honors = prefillHonorsForClub(facts, organizationId, reportYear);
  const undatedHonorCompletions = countUndatedHonorCompletions(facts, organizationId);

  const values: YearEndPrefill = {
    ...rosterCounts.counts,
    ...prefillInvestitures(completions, reportYear),
    ...honors,
  };
  return { values, unplaced: rosterCounts.unplaced, tltsOnRoster: rosterCounts.tltsOnRoster, undatedHonorCompletions };
}

export type YearEndPrefillResult = Awaited<ReturnType<typeof yearEndPrefill>>;

const reportSelect = {
  id: true,
  organizationId: true,
  reportYear: true,
  status: true,
  contactName: true,
  contactWorkPhone: true,
  contactHomePhone: true,
  contactCellPhone: true,
  contactEmail: true,
  prefill: true,
  overrides: true,
  manual: true,
  submittedAt: true,
  firstSubmittedAt: true,
  updatedAt: true,
} satisfies Prisma.ClubYearEndReportSelect;

type StoredReport = Prisma.ClubYearEndReportGetPayload<{ select: typeof reportSelect }>;

const asRecord = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

function serializeReport(report: StoredReport) {
  const prefill = asRecord(report.prefill);
  const overrides = asRecord(report.overrides);
  const manual = asRecord(report.manual);
  const resolved = resolveYearEnd({ prefill, overrides, manual });
  return {
    id: report.id,
    organizationId: report.organizationId,
    reportYear: report.reportYear,
    status: report.status,
    contactName: report.contactName,
    contactWorkPhone: report.contactWorkPhone,
    contactHomePhone: report.contactHomePhone,
    contactCellPhone: report.contactCellPhone,
    contactEmail: report.contactEmail,
    resolved,
    totals: yearEndTotals(resolvedCounts(resolved)),
    late: report.firstSubmittedAt ? isLateYearEndReport(report.reportYear, report.firstSubmittedAt) : false,
    submittedAt: report.submittedAt ? report.submittedAt.toISOString() : null,
    firstSubmittedAt: report.firstSubmittedAt ? report.firstSubmittedAt.toISOString() : null,
    updatedAt: report.updatedAt.toISOString(),
  };
}

export type YearEndReportRecord = ReturnType<typeof serializeReport>;

export async function getYearEndReport(organizationId: string, reportYear: string) {
  const report = await getPrisma().clubYearEndReport.findUnique({
    where: { organizationId_reportYear: { organizationId, reportYear } },
    select: reportSelect,
  });
  return report ? serializeReport(report) : null;
}

/** Every Pathfinder year's report for one club, for its list page. */
export async function listYearEndReportsForClub(organizationId: string, reportYears: readonly string[]) {
  const reports = await getPrisma().clubYearEndReport.findMany({
    where: { organizationId, reportYear: { in: [...reportYears] } },
    select: reportSelect,
  });
  return new Map(reports.map((report) => [report.reportYear, serializeReport(report)]));
}

/**
 * What the form opens with. A draft (or no report yet) shows the current
 * pre-filled numbers next to whatever the director already overrode; a
 * SUBMITTED report shows the snapshot it was filed with, so a locked report
 * never shifts when the roster changes.
 */
export async function getYearEndView(organizationId: string, reportYear: string, now = new Date()) {
  const stored = await getPrisma().clubYearEndReport.findUnique({
    where: { organizationId_reportYear: { organizationId, reportYear } },
    select: reportSelect,
  });
  if (stored?.status === "SUBMITTED") {
    const report = serializeReport(stored);
    return { report, resolved: report.resolved, prefillMeta: null };
  }
  const prefill = await yearEndPrefill(organizationId, reportYear, now);
  const resolved = resolveYearEnd({ prefill: prefill.values, overrides: asRecord(stored?.overrides), manual: asRecord(stored?.manual) });
  const base = stored ? serializeReport(stored) : null;
  return {
    report: base ? { ...base, resolved, totals: yearEndTotals(resolvedCounts(resolved)) } : null,
    resolved,
    prefillMeta: { unplaced: prefill.unplaced, tltsOnRoster: prefill.tltsOnRoster, undatedHonorCompletions: prefill.undatedHonorCompletions },
  };
}

/**
 * Saves a draft or submits. A submitted report is closed to the club (and to
 * a staff "act as" director, who gets exactly the club's rules); only staff
 * reopen it. Only the current and the previous Pathfinder year can be saved.
 * A first submission after April 1 is still accepted and is shown as late,
 * the way a late monthly report is; a draft never locks at the due date. The pre-filled snapshot is
 * refreshed on every save, so it is frozen at the moment of submission.
 */
export async function saveYearEndReport(
  organizationId: string,
  reportYear: string,
  input: YearEndReportInput,
  actor: ClubReportActor,
  now = new Date(),
) {
  if (!isReportYearReportable(reportYear, now)) {
    throw new ClubReportError("CLUB_REPORT_YEAR_INVALID", "You can file the current Pathfinder year or the one before it.");
  }
  const prefill = await yearEndPrefill(organizationId, reportYear, now);
  const { overrides, manual } = splitYearEndValues(input.values, prefill.values);

  try {
    return await getPrisma().$transaction(async (tx) => {
      const club = await tx.organization.findUnique({ where: { id: organizationId }, select: { type: true, name: true } });
      if (!club || club.type !== "CLUB") throw new ClubReportError("CLUB_NOT_FOUND", "That club could not be found.");
      const existing = await tx.clubYearEndReport.findUnique({
        where: { organizationId_reportYear: { organizationId, reportYear } },
        select: { id: true, status: true, firstSubmittedAt: true, submittedAt: true },
      });
      if (existing && isYearEndLockedForClub(existing.status)) {
        throw new ClubReportError("CLUB_REPORT_LOCKED", "This report was submitted. Ask the conference office to reopen it if something needs to change.");
      }
      const submitting = input.status === "SUBMITTED";
      const firstSubmittedAt = submitting ? (existing?.firstSubmittedAt ?? now) : (existing?.firstSubmittedAt ?? null);
      const data = {
        contactName: input.contactName,
        contactWorkPhone: input.contactWorkPhone,
        contactHomePhone: input.contactHomePhone,
        contactCellPhone: input.contactCellPhone,
        contactEmail: input.contactEmail,
        prefill: prefill.values,
        overrides,
        manual,
        status: input.status,
        submittedAt: submitting ? now : null,
        firstSubmittedAt,
        ...("accountId" in actor && submitting && !existing?.firstSubmittedAt ? { submittedByAccountId: actor.accountId } : {}),
        ...("accountId" in actor
          ? { updatedByAccountId: actor.accountId, updatedByUserId: null }
          : { updatedByUserId: actor.userId, updatedByAccountId: null }),
      };
      const saved = existing
        ? await tx.clubYearEndReport.update({ where: { id: existing.id }, data, select: reportSelect })
        : await tx.clubYearEndReport.create({ data: { ...data, organizationId, reportYear }, select: reportSelect });
      const record = serializeReport(saved);
      await writeAuditLog({
        ...("userId" in actor ? { actorUserId: actor.userId } : {}),
        action: submitting ? "CLUB_YEAR_END_REPORT_SUBMITTED" : "CLUB_YEAR_END_REPORT_DRAFT_SAVED",
        entityType: "ClubYearEndReport",
        entityId: saved.id,
        summary: `${submitting ? "Submitted" : "Saved a draft of"} the ${reportYear} year-end report for ${club.name}.`,
        metadata: {
          organizationId,
          reportYear,
          reportId: saved.id,
          status: input.status,
          overriddenFields: Object.keys(overrides).length,
          totalMembership: record.totals.totalMembership,
          late: record.late,
          ...("accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : actor.actAsId ? { actAsId: actor.actAsId } : {}),
        },
      }, tx);
      return record;
    });
  } catch (error) {
    // Two first saves racing past the "no report yet" check: the unique
    // (club, year) index refuses the second, which is a conflict, not a crash.
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "P2002") {
      throw new ClubReportError("CLUB_REPORT_CONFLICT", "This report was just saved by someone else. Reload it and try again.");
    }
    throw error;
  }
}

/** Staff put a SUBMITTED report back to DRAFT so the club can correct it. */
export async function reopenYearEndReport(organizationId: string, reportYear: string, actorUserId: string) {
  return getPrisma().$transaction(async (tx) => {
    const club = await tx.organization.findUnique({ where: { id: organizationId }, select: { type: true, name: true } });
    if (!club || club.type !== "CLUB") throw new ClubReportError("CLUB_NOT_FOUND", "That club could not be found.");
    const existing = await tx.clubYearEndReport.findUnique({
      where: { organizationId_reportYear: { organizationId, reportYear } },
      select: { id: true, status: true },
    });
    if (!existing) throw new ClubReportError("CLUB_REPORT_NOT_FOUND", "That report could not be found.");
    if (existing.status !== "SUBMITTED") throw new ClubReportError("CLUB_REPORT_NOT_SUBMITTED", "This report is already a draft.");
    const saved = await tx.clubYearEndReport.update({
      where: { id: existing.id },
      data: { status: "DRAFT", submittedAt: null, updatedByUserId: actorUserId, updatedByAccountId: null },
      select: reportSelect,
    });
    await writeAuditLog({
      actorUserId,
      action: "CLUB_YEAR_END_REPORT_REOPENED",
      entityType: "ClubYearEndReport",
      entityId: saved.id,
      summary: `Reopened the ${reportYear} year-end report for ${club.name} as a draft.`,
      metadata: { organizationId, reportYear, reportId: saved.id },
    }, tx);
    return serializeReport(saved);
  });
}

/**
 * The conference view: every active club, its report status for the year,
 * and (only for SUBMITTED reports, as with monthly reports) its numbers.
 */
export async function listYearEndReportsForYear(reportYear: string) {
  const prisma = getPrisma();
  const [clubs, reports] = await Promise.all([
    prisma.organization.findMany({
      where: { type: "CLUB", isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, parentOrganization: { select: { name: true } } },
    }),
    prisma.clubYearEndReport.findMany({ where: { reportYear }, select: reportSelect }),
  ]);
  const byClub = new Map(reports.map((report) => [report.organizationId, serializeReport(report)]));
  return clubs.map((club) => {
    const report = byClub.get(club.id) ?? null;
    return {
      id: club.id,
      name: club.name,
      church: club.parentOrganization?.name ?? "",
      status: (report?.status ?? "NONE") as "NONE" | "DRAFT" | "SUBMITTED",
      submittedAt: report?.status === "SUBMITTED" ? report.submittedAt : null,
      late: report?.status === "SUBMITTED" ? report.late : false,
      report: report?.status === "SUBMITTED" ? report : null,
    };
  });
}

export type YearEndClubSummary = Awaited<ReturnType<typeof listYearEndReportsForYear>>[number];
