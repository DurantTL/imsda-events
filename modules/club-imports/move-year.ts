import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { refreshBackgroundCheckMatchesSafely } from "@/modules/background-checks/refresh-after-write";
import { clubYearChoices, importPersonKey, importScope, scopeClubYear } from "@/modules/club-imports/domain";
import { ImportYearMoveError, type ImportYearConflict, type ImportYearMovePreview } from "@/modules/club-imports/move-year-domain";

export { ImportYearMoveError };

/**
 * "Move this import to another club year" (#541). A club imported into the
 * wrong year is fixed by moving that import's roster rows (`source: IMPORT`,
 * that year) and its form 89 ExternalIdentity to another year, in one
 * transaction. Re-importing would create a second Person for everyone, so
 * this never creates or deletes a Person and never merges anyone: any
 * conflict refuses the whole move and is listed for staff to resolve.
 * System administrators only; callers check that. Audit: counts and ids.
 */

/** "form-89:" — every form 89 import scope starts with it. */
const IMPORT_PREFIX = importScope("");

type Client = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

/** The club's form 89 imports, one per club year, with how many roster rows each still has. */
export async function listClubImports(organizationId: string) {
  const prisma = getPrisma();
  const identities = await prisma.externalIdentity.findMany({
    where: { organizationId, provider: "FLUENT_FORMS", providerScope: { startsWith: IMPORT_PREFIX } },
    select: { id: true, providerScope: true, externalId: true },
  });
  const imports = identities.flatMap((identity) => {
    const clubYear = scopeClubYear(identity.providerScope);
    return clubYear ? [{ identityId: identity.id, entryId: identity.externalId, clubYear }] : [];
  });
  const counts = await Promise.all(imports.map((item) => prisma.clubRosterMember.count({
    where: { organizationId, clubYear: item.clubYear, source: "IMPORT", status: { not: "REMOVED" } },
  })));
  return imports
    .map((item, index) => ({ ...item, peopleOnRoster: counts[index] }))
    .sort((a, b) => a.clubYear.localeCompare(b.clubYear));
}

async function buildPreview(client: Client, organizationId: string, fromYear: string, toYear: string, now: Date): Promise<{ preview: ImportYearMovePreview; personIds: string[] }> {
  if (!clubYearChoices(now).includes(toYear) || toYear === fromYear) {
    throw new ImportYearMoveError("INVALID_TARGET_YEAR", "Choose the previous, current, or next club year, other than the one it is in now.");
  }
  const identity = await client.externalIdentity.findUnique({
    where: { organizationId_provider_providerScope: { organizationId, provider: "FLUENT_FORMS", providerScope: importScope(fromYear) } },
    select: { id: true, externalId: true },
  });
  if (!identity) throw new ImportYearMoveError("IMPORT_NOT_FOUND", `This club has no ${fromYear} import to move.`);

  const [target, rows] = await Promise.all([
    client.externalIdentity.findUnique({
      where: { organizationId_provider_providerScope: { organizationId, provider: "FLUENT_FORMS", providerScope: importScope(toYear) } },
      select: { id: true },
    }),
    client.clubRosterMember.findMany({
      where: { organizationId, clubYear: fromYear, source: "IMPORT" },
      select: {
        id: true,
        personId: true,
        attendeeType: true,
        status: true,
        person: { select: { firstName: true, lastName: true } },
        transferAsSender: { select: { id: true }, take: 1 },
        transferAsReceiver: { select: { id: true } },
      },
    }),
  ]);
  const nameOf = (row: (typeof rows)[number]) => (row.person ? `${row.person.firstName} ${row.person.lastName}`.trim() : "Removed person");
  const personIds = rows.flatMap((row) => (row.personId ? [row.personId] : []));
  // Imports always create new Person rows, so the same person is recognised
  // by name and roster section as well as by id: a director may have added
  // the same children by hand to the target year (#541).
  const onTarget = await client.clubRosterMember.findMany({
    where: { organizationId, clubYear: toYear, status: { not: "REMOVED" } },
    select: { personId: true, attendeeType: true, person: { select: { firstName: true, lastName: true } } },
  });
  const onTargetIds = new Set(onTarget.flatMap((row) => (row.personId ? [row.personId] : [])));
  const onTargetKeys = new Set(onTarget.flatMap((row) => (row.person ? [importPersonKey({ attendeeType: row.attendeeType, ...row.person })] : [])));

  const conflicts: ImportYearConflict[] = [];
  if (target) conflicts.push({ kind: "TARGET_HAS_IMPORT", toYear });
  for (const row of rows) {
    if (row.personId && onTargetIds.has(row.personId)) {
      conflicts.push({ kind: "ALREADY_ON_TARGET_ROSTER", rosterMemberId: row.id, name: nameOf(row) });
    } else if (row.status !== "REMOVED" && row.person && onTargetKeys.has(importPersonKey({ attendeeType: row.attendeeType, ...row.person }))) {
      conflicts.push({ kind: "ALREADY_ON_TARGET_ROSTER", rosterMemberId: row.id, name: nameOf(row), sameName: true });
    }
    // A transfer is recorded against one club year; moving its row would split them.
    if (row.transferAsSender.length > 0 || row.transferAsReceiver) conflicts.push({ kind: "IN_TRANSFER", rosterMemberId: row.id, name: nameOf(row) });
  }
  return {
    personIds,
    preview: {
      organizationId,
      fromYear,
      toYear,
      identityId: identity.id,
      entryId: identity.externalId,
      rowsToMove: rows.length,
      peopleOnRoster: rows.filter((row) => row.status !== "REMOVED").length,
      conflicts,
    },
  };
}

/** What a move would do, and anything that blocks it. Changes nothing. */
export async function previewImportYearMove(organizationId: string, fromYear: string, toYear: string, now = new Date()) {
  return (await buildPreview(getPrisma(), organizationId, fromYear, toYear, now)).preview;
}

/**
 * Moves the import. Takes a row lock on the import record first and checks
 * again inside the transaction, so the preview a person saw can't be stale
 * and two moves of the same import can't both succeed: the second waits, sees
 * the record has left the year it asked about, and is refused. The unique
 * keys on the roster and the record also stop a concurrent write.
 */
export async function moveImportYear(organizationId: string, fromYear: string, toYear: string, actorUserId: string, now = new Date()) {
  const prisma = getPrisma();
  try {
    const { result, personIds } = await prisma.$transaction(async (tx) => {
      const known = await tx.externalIdentity.findUnique({
        where: { organizationId_provider_providerScope: { organizationId, provider: "FLUENT_FORMS", providerScope: importScope(fromYear) } },
        select: { id: true },
      });
      if (!known) throw new ImportYearMoveError("IMPORT_NOT_FOUND", `This club has no ${fromYear} import to move.`);
      // Lock the import record, then read its scope again: a move that
      // committed while this one waited has already changed it.
      const locked = await tx.$queryRaw<Array<{ providerScope: string }>>`
        SELECT "providerScope" FROM "ExternalIdentity" WHERE "id" = ${known.id} FOR UPDATE`;
      if (locked[0]?.providerScope !== importScope(fromYear)) {
        throw new ImportYearMoveError("IMPORT_MOVE_CONFLICT", "This import was already moved. Nothing was changed; reload to see where it is now.");
      }
      const { preview, personIds } = await buildPreview(tx, organizationId, fromYear, toYear, now);
      if (preview.conflicts.length > 0) {
        throw new ImportYearMoveError("IMPORT_MOVE_CONFLICT", "Nothing was moved. Resolve the conflicts listed, then try again.", preview);
      }
      const moved = await tx.clubRosterMember.updateMany({
        where: { organizationId, clubYear: fromYear, source: "IMPORT" },
        data: { clubYear: toYear },
      });
      if (moved.count !== preview.rowsToMove) {
        throw new ImportYearMoveError("IMPORT_MOVE_CONFLICT", "Someone changed this club's roster at the same moment. Nothing was moved; preview again.");
      }
      const record = await tx.externalIdentity.updateMany({
        where: { id: preview.identityId, providerScope: importScope(fromYear) },
        data: { providerScope: importScope(toYear), displayLabel: `Yearly club registration, ${toYear}` },
      });
      if (record.count !== 1) throw new ImportYearMoveError("IMPORT_MOVE_CONFLICT", "This import was already moved. Nothing was changed; reload to see where it is now.");
      await writeAuditLog({
        actorUserId,
        action: "CLUB_IMPORT_YEAR_MOVED",
        entityType: "Organization",
        entityId: organizationId,
        summary: "Moved a club import to another club year.",
        metadata: {
          organizationId,
          externalIdentityId: preview.identityId,
          fromYear,
          toYear,
          rowsMoved: moved.count,
          peopleOnRoster: preview.peopleOnRoster,
        },
      }, tx);
      return { result: { ...preview, rowsMoved: moved.count }, personIds };
    });
    // #527: moved roster adults on the Sterling Volunteers list are matched after commit; best effort.
    await refreshBackgroundCheckMatchesSafely(personIds);
    return result;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ImportYearMoveError("IMPORT_MOVE_CONFLICT", "Someone changed this club's roster at the same moment. Nothing was moved; preview again.");
    }
    throw error;
  }
}
