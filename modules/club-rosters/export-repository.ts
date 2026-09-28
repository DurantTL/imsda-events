import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import type { actorAttribution } from "@/modules/club-rosters/access";
import { buildRosterExportTable } from "@/modules/club-rosters/export";
import { isRosterExportColumnKey, sensitiveRosterExportColumns, type RosterExportColumn } from "@/modules/club-rosters/export-columns";
import type { RosterExportFormatInput, RosterExportRequest } from "@/modules/club-rosters/export-schemas";
import { openBirthDate } from "@/modules/club-rosters/birth-dates";
import { listRoster } from "@/modules/club-rosters/repository";
import { toCsv } from "@/modules/reporting/csv";

/**
 * Formats and running an export (#490). Formats hold structure only — the
 * column keys, order, and header names a director chose — and are never a
 * frozen copy of the roster. Every actual export (a CSV download) is
 * audited: who, when, which club, and which columns, never row data.
 */

type Actor = ReturnType<typeof actorAttribution>;

export type RosterExportErrorCode = "CONFIRMATION_REQUIRED" | "SENSITIVE_ACCESS_DENIED" | "FORMAT_NAME_TAKEN" | "FORMAT_NOT_FOUND";

export class RosterExportError extends Error {
  constructor(public readonly code: RosterExportErrorCode, message: string) {
    super(message);
    this.name = "RosterExportError";
  }
}

function auditMetadata(actor: Actor, extra: Record<string, Prisma.InputJsonValue>) {
  return {
    ...("accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : { actAsId: actor.actAsId }),
    ...extra,
  };
}

function serializeFormat(row: { id: string; name: string; columns: Prisma.JsonValue; updatedAt: Date }) {
  const columns = (Array.isArray(row.columns) ? row.columns : []).filter(
    (entry): entry is RosterExportColumn =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
      && typeof (entry as { key?: unknown }).key === "string"
      && isRosterExportColumnKey((entry as { key: string }).key)
      && typeof (entry as { header?: unknown }).header === "string",
  );
  return { id: row.id, name: row.name, columns, updatedAt: row.updatedAt.toISOString() };
}

export type RosterExportFormatRecord = ReturnType<typeof serializeFormat>;

/** A club's saved export formats, newest edit first. Structure only, never roster data. */
export async function listRosterExportFormats(organizationId: string): Promise<RosterExportFormatRecord[]> {
  const rows = await getPrisma().clubRosterExportFormat.findMany({
    where: { organizationId },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, columns: true, updatedAt: true },
  });
  return rows.map(serializeFormat);
}

/** Saves a named format's structure (column keys, order, header names) — never a copy of the roster. */
export async function saveRosterExportFormat(
  organizationId: string,
  input: RosterExportFormatInput,
  actor: Actor,
): Promise<RosterExportFormatRecord> {
  const existing = await getPrisma().clubRosterExportFormat.findUnique({
    where: { organizationId_name: { organizationId, name: input.name } },
    select: { id: true },
  });
  if (existing) {
    throw new RosterExportError("FORMAT_NAME_TAKEN", "A saved format with this name already exists. Choose another name.");
  }
  const row = await getPrisma().clubRosterExportFormat.create({
    data: {
      organizationId,
      name: input.name,
      columns: input.columns,
      ...("accountId" in actor ? { createdByAccountId: actor.accountId } : { createdByUserId: actor.userId }),
    },
    select: { id: true, name: true, columns: true, updatedAt: true },
  });
  await writeAuditLog({
    ...("userId" in actor ? { actorUserId: actor.userId } : {}),
    action: "CLUB_ROSTER_EXPORT_FORMAT_SAVED",
    entityType: "ClubRosterExportFormat",
    entityId: row.id,
    summary: "Saved a club roster export format.",
    metadata: auditMetadata(actor, { organizationId, columns: input.columns.map((column) => column.key) }),
  });
  return serializeFormat(row);
}

/** Removes a saved format. Never touches the roster itself. */
export async function deleteRosterExportFormat(organizationId: string, formatId: string, actor: Actor) {
  const format = await getPrisma().clubRosterExportFormat.findFirst({
    where: { id: formatId, organizationId },
    select: { id: true },
  });
  if (!format) throw new RosterExportError("FORMAT_NOT_FOUND", "That saved format could not be found.");
  await getPrisma().clubRosterExportFormat.delete({ where: { id: formatId } });
  await writeAuditLog({
    ...("userId" in actor ? { actorUserId: actor.userId } : {}),
    action: "CLUB_ROSTER_EXPORT_FORMAT_DELETED",
    entityType: "ClubRosterExportFormat",
    entityId: formatId,
    summary: "Deleted a club roster export format.",
    metadata: auditMetadata(actor, { organizationId }),
  });
}

/**
 * Builds a preview or a CSV download for the chosen columns. Birth dates are
 * opened with the roster's own `openBirthDate` (the only place a sealed
 * birth date is ever decrypted) only when the birth-date column is chosen
 * and the actor already has `seeBirthDates`. Only a `mode: "csv"` run is
 * itself audited as an export, naming the columns but never a row; a preview
 * alone isn't a hand-off of anyone's data anywhere.
 */
export async function runRosterExport(
  organizationId: string,
  clubYear: string,
  request: RosterExportRequest,
  canSeeBirthDates: boolean,
  actor: Actor,
) {
  const sensitiveChosen = sensitiveRosterExportColumns(request.columns);
  if (sensitiveChosen.length > 0 && !request.confirmSensitive) {
    throw new RosterExportError(
      "CONFIRMATION_REQUIRED",
      `Confirm sharing ${sensitiveChosen.map((column) => column.header).join(", ")} before building this export.`,
    );
  }
  const needsBirthDate = request.columns.some((column) => column.key === "birthDate");
  if (needsBirthDate && !canSeeBirthDates) {
    throw new RosterExportError("SENSITIVE_ACCESS_DENIED", "Your club role doesn't include birth dates. Ask your club director.");
  }

  const members = await listRoster(organizationId, clubYear);
  const birthDates = needsBirthDate ? await revealBirthDatesForExport(organizationId, clubYear) : null;
  const table = buildRosterExportTable(members, request.columns, birthDates);

  if (request.mode === "csv") {
    await writeAuditLog({
      ...("userId" in actor ? { actorUserId: actor.userId } : {}),
      action: "CLUB_ROSTER_EXPORTED",
      entityType: "Organization",
      entityId: organizationId,
      summary: "Exported a club roster to CSV.",
      metadata: auditMetadata(actor, {
        organizationId,
        clubYear,
        columns: request.columns.map((column) => column.key),
        rowCount: members.length,
      }),
    });
    return { ...table, csv: toCsv([table.headers, ...table.rows]) };
  }
  return table;
}

/** Opens the sealed birth dates this export will use. The export itself is what gets audited (`CLUB_ROSTER_EXPORTED`). */
async function revealBirthDatesForExport(organizationId: string, clubYear: string) {
  const members = await getPrisma().clubRosterMember.findMany({
    where: { organizationId, clubYear, status: { not: "REMOVED" }, sealedBirthDate: { not: null } },
    select: { id: true, sealedBirthDate: true },
  });
  return Object.fromEntries(members.map((member) => [member.id, openBirthDate(member.sealedBirthDate!)]));
}
