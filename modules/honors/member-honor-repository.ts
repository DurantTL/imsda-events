import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  type ClubHonorsRow,
  type MemberHonorEntryRecord,
  currentHonorsFromHistory,
  memberHonorEntryProblem,
} from "@/modules/honors/member-honor-domain";
import type { BulkMemberHonorEntryInput, MemberHonorEntryInput } from "@/modules/honors/member-honor-schemas";

/**
 * Member honor storage (#486). Every entry is append-only and keyed to the
 * durable `Person`, never to a `ClubRosterMember` row: club rosters are
 * recreated per club year (`clubYear`, #414's planned rollover) and a
 * transfer (#489) moves someone to a different `organizationId` roster row
 * entirely. Keying by `personId` instead means the record needs no copying
 * and no special-casing on either event — it is simply still there, found by
 * the same `personId`, wherever that person's current roster row points.
 *
 * `organizationId` on each entry only remembers which club recorded it, for
 * the audit trail; a person's full history is returned regardless of which
 * club (past or present) made each entry, matching #489's "honor history
 * follows the member" requirement.
 *
 * The one exception to append-only is removal: when a club removes someone
 * and their `Person` is deleted (`removeRosterMember`, ADR 0005 Addendum A
 * §6), that person's entries are deleted with it, in the same transaction.
 */

export type MemberHonorActor = { accountId: string } | { userId: string; actAsId: string };

export type MemberHonorErrorCode = "MEMBER_NOT_FOUND" | "HONOR_NOT_FOUND" | "ENTRY_INVALID";

export class MemberHonorError extends Error {
  constructor(public readonly code: MemberHonorErrorCode, message: string) {
    super(message);
    this.name = "MemberHonorError";
  }
}

/**
 * A bulk entry covers up to 500 members (the schema's cap), each one an entry
 * plus an audit row. Like the roster import (`ROSTER_IMPORT_TRANSACTION` in
 * background-checks), it gets an explicit window instead of Prisma's 5-second
 * interactive-transaction default.
 */
const BULK_HONOR_TRANSACTION = { timeout: 60_000, maxWait: 10_000 };

function actorAuditFields(actor: MemberHonorActor) {
  return {
    actorFields: "userId" in actor ? { actorUserId: actor.userId } : {},
    metadata: "accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : { actAsId: actor.actAsId },
  };
}

function today(now: Date) {
  return now.toISOString().slice(0, 10);
}

/** Active roster members this club may record honors for, mapped to their durable person id. */
async function activeRosterPersons(tx: Prisma.TransactionClient, organizationId: string, memberIds: readonly string[]) {
  const members = await tx.clubRosterMember.findMany({
    where: { id: { in: [...memberIds] }, organizationId, status: { not: "REMOVED" }, personId: { not: null } },
    select: { id: true, personId: true },
  });
  const byId = new Map(members.map((member) => [member.id, member.personId!]));
  const missing = memberIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new MemberHonorError("MEMBER_NOT_FOUND", "One of the selected people isn't on this club's roster.");
  }
  return byId;
}

/**
 * Records one honor entry per selected member, all in one transaction — the
 * bulk-entry action after a meeting (#486). A single-member edit is the same
 * call with one id. Every write is an append; nothing already on file is
 * ever changed or deleted.
 */
export async function recordMemberHonorEntries(
  organizationId: string,
  memberIds: readonly string[],
  input: MemberHonorEntryInput | BulkMemberHonorEntryInput,
  actor: MemberHonorActor,
  now = new Date(),
) {
  const problem = memberHonorEntryProblem(input, today(now));
  if (problem) throw new MemberHonorError("ENTRY_INVALID", problem);
  await getPrisma().$transaction(async (tx) => {
    const honor = await tx.honor.findUnique({ where: { id: input.honorId }, select: { id: true, name: true } });
    if (!honor) throw new MemberHonorError("HONOR_NOT_FOUND", "That honor could not be found.");
    const byMemberId = await activeRosterPersons(tx, organizationId, memberIds);
    const attribution = "accountId" in actor
      ? { recordedByAccountId: actor.accountId }
      : { recordedByUserId: actor.userId };
    for (const [memberId, personId] of byMemberId) {
      const entry = await tx.memberHonorEntry.create({
        data: {
          personId,
          honorId: input.honorId,
          status: input.status,
          completionDate: input.status === "COMPLETED" ? input.completionDate : "",
          note: input.note,
          organizationId,
          ...attribution,
        },
        select: { id: true },
      });
      const who = actorAuditFields(actor);
      // `tx`: the audit row commits or rolls back with the entry it describes.
      await writeAuditLog({
        ...who.actorFields,
        action: "MEMBER_HONOR_RECORDED",
        entityType: "MemberHonorEntry",
        entityId: entry.id,
        summary: `Recorded ${honor.name} as ${input.status === "COMPLETED" ? "completed" : "in progress"} for a club roster member.`,
        metadata: {
          organizationId,
          memberId,
          honorId: honor.id,
          status: input.status,
          ...who.metadata,
        },
      }, tx);
    }
  }, BULK_HONOR_TRANSACTION);
}

/**
 * Records that someone downloaded a club's honors CSV (#486): which club,
 * which club year, and how many rows — never a name or an honor detail.
 */
export async function auditClubHonorsExport(
  organizationId: string,
  clubYear: string,
  rowCount: number,
  viewer: MemberHonorActor,
  readOnly: boolean,
) {
  const who = actorAuditFields(viewer);
  await writeAuditLog({
    ...who.actorFields,
    action: "CLUB_HONORS_EXPORTED",
    entityType: "Organization",
    entityId: organizationId,
    summary: "Exported a club's honors as CSV.",
    metadata: { organizationId, clubYear, rowCount, readOnly, ...who.metadata },
  });
}

function serializeHistoryEntry(
  entry: Prisma.MemberHonorEntryGetPayload<{
    select: {
      id: true;
      honorId: true;
      status: true;
      completionDate: true;
      note: true;
      createdAt: true;
      honor: { select: { code: true; name: true } };
      recordedByAccount: { select: { displayName: true } };
      recordedByUser: { select: { displayName: true } };
      organization: { select: { name: true } };
    };
  }>,
): MemberHonorEntryRecord {
  return {
    id: entry.id,
    honorId: entry.honorId,
    honorCode: entry.honor.code,
    honorName: entry.honor.name,
    status: entry.status,
    completionDate: entry.completionDate,
    note: entry.note,
    recordedByName: entry.recordedByAccount?.displayName ?? entry.recordedByUser?.displayName ?? "Someone no longer on file",
    recordedAtOrganizationName: entry.organization.name,
    createdAt: entry.createdAt.toISOString(),
  };
}

/** Every entry ever recorded for this person, newest first — the append-only history behind the current status. */
export async function listMemberHonorHistory(organizationId: string, memberId: string) {
  const member = await getPrisma().clubRosterMember.findFirst({
    where: { id: memberId, organizationId, status: { not: "REMOVED" } },
    select: { personId: true, person: { select: { firstName: true, lastName: true } } },
  });
  if (!member || !member.personId) throw new MemberHonorError("MEMBER_NOT_FOUND", "That person isn't on this club's roster.");
  const entries = await getPrisma().memberHonorEntry.findMany({
    where: { personId: member.personId },
    orderBy: { seq: "desc" },
    select: {
      id: true, honorId: true, status: true, completionDate: true, note: true, createdAt: true,
      honor: { select: { code: true, name: true } },
      recordedByAccount: { select: { displayName: true } },
      recordedByUser: { select: { displayName: true } },
      organization: { select: { name: true } },
    },
  });
  const history = entries.map(serializeHistoryEntry);
  return {
    firstName: member.person?.firstName ?? "",
    lastName: member.person?.lastName ?? "",
    history,
    current: currentHonorsFromHistory(history),
  };
}

/**
 * Every active member on this year's roster with their current honors
 * (#486): the roster card and the club Honors page share this one read. Only
 * the latest entry per honor is returned per person — see
 * `currentHonorsFromHistory`.
 */
export async function listClubHonorsPage(organizationId: string, clubYear: string): Promise<ClubHonorsRow[]> {
  const members = await getPrisma().clubRosterMember.findMany({
    where: { organizationId, clubYear, status: "ACTIVE", personId: { not: null } },
    select: {
      id: true,
      classLevel: true,
      person: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  const personIds = members.map((member) => member.person!.id);
  const entries = personIds.length === 0 ? [] : await getPrisma().memberHonorEntry.findMany({
    where: { personId: { in: personIds } },
    orderBy: { seq: "desc" },
    select: {
      personId: true, id: true, honorId: true, status: true, completionDate: true, note: true, createdAt: true,
      honor: { select: { code: true, name: true } },
      recordedByAccount: { select: { displayName: true } },
      recordedByUser: { select: { displayName: true } },
      organization: { select: { name: true } },
    },
  });
  const byPerson = new Map<string, typeof entries>();
  for (const entry of entries) {
    const list = byPerson.get(entry.personId) ?? [];
    list.push(entry);
    byPerson.set(entry.personId, list);
  }
  return members
    .map((member) => {
      const history = (byPerson.get(member.person!.id) ?? []).map(serializeHistoryEntry);
      return {
        memberId: member.id,
        firstName: member.person?.firstName ?? "",
        lastName: member.person?.lastName ?? "",
        classLevel: member.classLevel,
        honors: currentHonorsFromHistory(history),
      };
    })
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
}

/** Every active honor in the catalog, for the Honors page's picker and filter. */
export async function listActiveHonorOptions() {
  const honors = await getPrisma().honor.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, code: true, name: true },
  });
  return honors;
}
