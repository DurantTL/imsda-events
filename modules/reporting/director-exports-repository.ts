import "server-only";

import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { clubClassLevelLabels } from "@/modules/club-rosters/domain";
import { originOf } from "@/modules/earned-awards/domain";
import { loadMasterAwardProgress } from "@/modules/earned-awards/order-source";
import { honorCategoryLabels } from "@/modules/honors/domain";
import { memberHonorStatusLabels } from "@/modules/honors/member-honor-domain";
import type { ClassTrackingMemberRow, HonorsExportRow } from "@/modules/reporting/director-exports";

/**
 * Reads for the director exports (#655). Names, class, honors and earned items
 * only: no birth date, age, contact or health field is ever selected.
 */

export function isHonorCategory(value: string): value is keyof typeof honorCategoryLabels {
  return Object.hasOwn(honorCategoryLabels, value);
}

export type HonorsExportFilter = { memberId?: string; category?: string };

export type ExportActor = { accountId?: string; userId?: string; actAsId?: string };

const byName = (a: { lastName: string; firstName: string }, b: { lastName: string; firstName: string }) =>
  a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);

async function clubName(organizationId: string) {
  const organization = await getPrisma().organization.findUnique({ where: { id: organizationId }, select: { name: true } });
  return organization?.name ?? "";
}

async function rosterMembers(organizationId: string, clubYear: string, memberId?: string) {
  const members = await getPrisma().clubRosterMember.findMany({
    where: { organizationId, clubYear, status: "ACTIVE", personId: { not: null }, ...(memberId ? { id: memberId } : {}) },
    select: { id: true, classLevel: true, person: { select: { id: true, firstName: true, lastName: true } } },
  });
  return members.flatMap((member) => (member.person ? [{
    memberId: member.id,
    personId: member.person.id,
    firstName: member.person.firstName,
    lastName: member.person.lastName,
    className: member.classLevel ? clubClassLevelLabels[member.classLevel] : "",
  }] : []));
}

/** Who is on this club's roster for the year: the member filter's choices. */
export async function listExportMemberOptions(organizationId: string, clubYear: string) {
  return (await rosterMembers(organizationId, clubYear))
    .sort(byName)
    .map((member) => ({ memberId: member.memberId, label: `${member.lastName}, ${member.firstName}` }));
}

/**
 * The club's honors, one row per member and honor (the latest non-voided entry
 * per honor, like the Honors page). Event is filled when the entry came from a
 * weekend honors class write-back.
 */
export async function loadHonorsExport(
  organizationId: string,
  clubYear: string,
  filter: HonorsExportFilter = {},
): Promise<{ clubName: string; rows: HonorsExportRow[] }> {
  const [name, members] = await Promise.all([clubName(organizationId), rosterMembers(organizationId, clubYear, filter.memberId)]);
  if (members.length === 0) return { clubName: name, rows: [] };
  const byPerson = new Map(members.map((member) => [member.personId, member]));
  const entries = await getPrisma().memberHonorEntry.findMany({
    where: {
      personId: { in: members.map((member) => member.personId) },
      void: null,
      ...(filter.category && isHonorCategory(filter.category) ? { honor: { category: filter.category } } : {}),
    },
    orderBy: { seq: "desc" },
    select: {
      personId: true, honorId: true, status: true, completionDate: true, createdAt: true,
      honor: { select: { name: true, category: true } },
      weekendCompletionLinks: { orderBy: { createdAt: "asc" }, take: 1, select: { enrollment: { select: { event: { select: { name: true } } } } } },
    },
  });
  const seen = new Set<string>();
  const rows: HonorsExportRow[] = [];
  for (const entry of entries) {
    // Newest first: the first non-voided entry per member and honor is current.
    const key = `${entry.personId}\u0000${entry.honorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const member = byPerson.get(entry.personId)!;
    const completed = entry.status === "COMPLETED";
    rows.push({
      memberId: member.memberId,
      honorId: entry.honorId,
      lastName: member.lastName,
      firstName: member.firstName,
      className: member.className,
      honorName: entry.honor.name,
      category: entry.honor.category ? honorCategoryLabels[entry.honor.category] : "",
      status: memberHonorStatusLabels[entry.status],
      dateEarned: completed ? entry.completionDate : entry.createdAt.toISOString().slice(0, 10),
      dateKind: completed ? "Completed" : "Recorded",
      eventName: entry.weekendCompletionLinks[0]?.enrollment.event.name ?? "",
    });
  }
  return { clubName: name, rows: rows.sort((a, b) => byName(a, b) || a.honorName.localeCompare(b.honorName)) };
}

const STATUS_WORDS = { NEEDED: "earned", ORDERED: "ordered", RECEIVED: "received", AWARDED: "awarded" } as const;

/**
 * Each active member's current class and the earned items stored for them
 * (class insignia, event patches, hand-added Good Conduct/TLT items) plus
 * their Master Award progress. Reads only.
 */
export async function loadClassTrackingExport(
  organizationId: string,
  clubYear: string,
  now = new Date(),
): Promise<{ clubName: string; rows: ClassTrackingMemberRow[] }> {
  const [name, members] = await Promise.all([clubName(organizationId), rosterMembers(organizationId, clubYear)]);
  if (members.length === 0) return { clubName: name, rows: [] };
  const personIds = members.map((member) => member.personId);
  const [needs, masterAwards] = await Promise.all([
    getPrisma().clubOrderNeed.findMany({
      where: { organizationId, sourceType: "AWARD", personId: { in: personIds }, itemId: { not: null } },
      select: { personId: true, sourceId: true, status: true, item: { select: { name: true } } },
    }),
    loadMasterAwardProgress(organizationId, now, { personIds, closestLimit: Number.POSITIVE_INFINITY }),
  ]);
  const rows = new Map<string, ClassTrackingMemberRow>(members.map((member) => [member.personId, {
    personId: member.personId,
    lastName: member.lastName,
    firstName: member.firstName,
    className: member.className,
    insignia: [],
    eventPatches: [],
    conductAndTlt: [],
    masterAwards: [],
  }]));
  for (const need of needs) {
    const row = rows.get(need.personId);
    if (!row || !need.item) continue;
    const origin = originOf(need.sourceId);
    const label = `${need.item.name} (${STATUS_WORDS[need.status as keyof typeof STATUS_WORDS] ?? need.status.toLowerCase()})`;
    if (origin === "Class insignia") row.insignia.push(label);
    else if (origin === "Event patch") row.eventPatches.push(label);
    else if (origin === "Added by hand") row.conductAndTlt.push(label);
    else row.masterAwards.push(`${need.item.name}: ${STATUS_WORDS[need.status as keyof typeof STATUS_WORDS] ?? need.status.toLowerCase()}`);
  }
  for (const award of masterAwards) {
    for (const person of award.eligible) rows.get(person.personId)?.masterAwards.push(`${award.name}: eligible`);
    for (const person of award.givenElsewhere) rows.get(person.personId)?.masterAwards.push(`${award.name}: given by another club`);
    for (const person of award.closest) rows.get(person.personId)?.masterAwards.push(`${award.name}: ${person.label}`);
  }
  const sorted = [...rows.values()].sort(byName);
  for (const row of sorted) {
    row.insignia.sort();
    row.eventPatches.sort();
    row.conductAndTlt.sort();
    row.masterAwards.sort();
  }
  return { clubName: name, rows: sorted };
}

/** One audit row per download: counts only, never a name. */
export async function auditDirectorExport(
  organizationId: string,
  report: "honors" | "class-tracking",
  clubYear: string,
  rowCount: number,
  viewer: ExportActor,
  readOnly: boolean,
) {
  await writeAuditLog({
    ...(viewer.userId ? { actorUserId: viewer.userId } : {}),
    action: "CLUB_DIRECTOR_EXPORT_DOWNLOADED",
    entityType: "Organization",
    entityId: organizationId,
    summary: `Downloaded a club's ${report === "honors" ? "honors" : "class tracking"} export as CSV.`,
    metadata: {
      organizationId, report, clubYear, rowCount, readOnly,
      ...(viewer.accountId ? { accountId: viewer.accountId } : {}),
      ...(viewer.actAsId ? { actAsId: viewer.actAsId } : {}),
    },
  });
}
