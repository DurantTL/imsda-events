import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { clubYearChoices, importScope, scopeClubYear } from "@/modules/club-imports/domain";
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

async function buildPreview(client: Client, organizationId: string, fromYear: string, toYear: string, now: Date): Promise<ImportYearMovePreview> {
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
        status: true,
        person: { select: { firstName: true, lastName: true } },
        transferAsSender: { select: { id: true }, take: 1 },
        transferAsReceiver: { select: { id: true } },
      },
    }),
  ]);
  const nameOf = (row: (typeof rows)[number]) => (row.person ? `${row.person.firstName} ${row.person.lastName}`.trim() : "Removed person");
  const personIds = rows.flatMap((row) => (row.personId ? [row.personId] : []));
  const onTarget = personIds.length
    ? await client.clubRosterMember.findMany({
      where: { organizationId, clubYear: toYear, personId: { in: personIds } },
      select: { personId: true },
    })
    : [];
  const onTargetIds = new Set(onTarget.map((row) => row.personId));

  const conflicts: ImportYearConflict[] = [];
  if (target) conflicts.push({ kind: "TARGET_HAS_IMPORT", toYear });
  for (const row of rows) {
    if (row.personId && onTargetIds.has(row.personId)) conflicts.push({ kind: "ALREADY_ON_TARGET_ROSTER", rosterMemberId: row.id, name: nameOf(row) });
    // A transfer is recorded against one club year; moving its row would split them.
    if (row.transferAsSender.length > 0 || row.transferAsReceiver) conflicts.push({ kind: "IN_TRANSFER", rosterMemberId: row.id, name: nameOf(row) });
  }
  return {
    organizationId,
    fromYear,
    toYear,
    identityId: identity.id,
    entryId: identity.externalId,
    rowsToMove: rows.length,
    peopleOnRoster: rows.filter((row) => row.status !== "REMOVED").length,
    conflicts,
  };
}

/** What a move would do, and anything that blocks it. Changes nothing. */
export async function previewImportYearMove(organizationId: string, fromYear: string, toYear: string, now = new Date()) {
  return buildPreview(getPrisma(), organizationId, fromYear, toYear, now);
}

/**
 * Moves the import. Checks again inside the transaction, so the preview a
 * person saw can't be stale; the unique keys on the roster and the identity
 * also stop a concurrent write from slipping in between.
 */
export async function moveImportYear(organizationId: string, fromYear: string, toYear: string, actorUserId: string, now = new Date()) {
  const prisma = getPrisma();
  try {
    return await prisma.$transaction(async (tx) => {
      const preview = await buildPreview(tx, organizationId, fromYear, toYear, now);
      if (preview.conflicts.length > 0) {
        throw new ImportYearMoveError("IMPORT_MOVE_CONFLICT", "Nothing was moved. Resolve the conflicts listed, then try again.", preview);
      }
      const moved = await tx.clubRosterMember.updateMany({
        where: { organizationId, clubYear: fromYear, source: "IMPORT" },
        data: { clubYear: toYear },
      });
      await tx.externalIdentity.update({
        where: { id: preview.identityId },
        data: { providerScope: importScope(toYear), displayLabel: `Yearly club registration, ${toYear}` },
      });
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
      return { ...preview, rowsMoved: moved.count };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ImportYearMoveError("IMPORT_MOVE_CONFLICT", "Someone changed this club's roster at the same moment. Nothing was moved; preview again.");
    }
    throw error;
  }
}
