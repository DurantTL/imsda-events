import "server-only";

import { randomUUID } from "node:crypto";
import { ImportRecordStatus, ImportRunStatus, Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { createImportSnapshotIdentity, CsvImportError, parseImportCsv, type NormalizedImportData } from "@/modules/imports/csv-parser";

const SOURCE_SYSTEM = "WR26_CSV_STAGING";
type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export class ImportOperationError extends Error {
  constructor(
    public readonly code: "IMPORT_NOT_FOUND" | "IMPORT_HAS_ERRORS" | "IMPORT_NOT_READY" | "IMPORT_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "ImportOperationError";
  }
}

function jsonObject(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Prisma.JsonValue> : {};
}

function jsonStrings(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizedData(value: Prisma.JsonValue | null): NormalizedImportData {
  return value as unknown as NormalizedImportData;
}

async function getEventTotals(client: DatabaseClient, eventId: string) {
  const [registrationTotals, attendees] = await Promise.all([
    client.registration.aggregate({ where: { eventId }, _count: true, _sum: { totalAmount: true } }),
    client.registrationAttendee.count({ where: { eventId } }),
  ]);
  return {
    registrations: registrationTotals._count,
    attendees,
    totalAmountCents: Math.round(Number(registrationTotals._sum.totalAmount ?? 0) * 100),
  };
}

type RunWithRecords = Prisma.ImportRunGetPayload<{
  include: { records: true; startedBy: { select: { displayName: true } } };
}>;

function serializeRun(run: RunWithRecords) {
  const records = run.records.sort((left, right) => left.sourceRow - right.sourceRow).map((record) => ({
    id: record.id,
    sourceRow: record.sourceRow,
    sourceRecordKey: record.sourceRecordKey,
    confirmationCode: record.confirmationCode ?? "",
    status: record.status,
    proposedAction: record.proposedAction,
    matchedPersonId: record.matchedPersonId,
    matchedRegistrationId: record.matchedRegistrationId,
    committedEntityId: record.committedEntityId,
    raw: jsonObject(record.rawSnapshot),
    normalizedData: record.normalizedData ? normalizedData(record.normalizedData) : null,
    differences: Array.isArray(record.differences) ? record.differences : [],
    warnings: jsonStrings(record.warnings),
    errors: jsonStrings(record.errors),
  }));
  return {
    id: run.id,
    eventId: run.eventId,
    sourceSystem: run.sourceSystem,
    sourceRunKey: run.sourceRunKey,
    fileName: run.fileName ?? "Imported CSV",
    sourceChecksum: run.sourceChecksum ?? "",
    status: run.status,
    recordsCreated: run.recordsCreated,
    recordsUpdated: run.recordsUpdated,
    recordsSkipped: run.recordsSkipped,
    warnings: run.warnings,
    errors: run.errors,
    summary: jsonObject(run.summary),
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    startedBy: run.startedBy.displayName,
    records,
  };
}

export type ImportRunRecord = ReturnType<typeof serializeRun>;

async function loadRun(eventId: string, importRunId: string) {
  return getPrisma().importRun.findFirst({
    where: { id: importRunId, eventId },
    include: { records: true, startedBy: { select: { displayName: true } } },
  });
}

export async function getImportRun(eventId: string, importRunId: string) {
  const run = await loadRun(eventId, importRunId);
  return run ? serializeRun(run) : null;
}

export async function listImportRuns(eventId: string) {
  const runs = await getPrisma().importRun.findMany({
    where: { eventId },
    orderBy: { startedAt: "desc" },
    take: 15,
    include: { records: true, startedBy: { select: { displayName: true } } },
  });
  return runs.map(serializeRun);
}

export async function getImportReconciliation(eventId: string) {
  const [target, latestRun] = await Promise.all([
    getEventTotals(getPrisma(), eventId),
    getPrisma().importRun.findFirst({
      where: { eventId, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      select: { id: true, fileName: true, completedAt: true, summary: true },
    }),
  ]);
  return {
    target,
    latestRun: latestRun ? {
      id: latestRun.id,
      fileName: latestRun.fileName ?? "Imported CSV",
      completedAt: latestRun.completedAt?.toISOString() ?? null,
      summary: jsonObject(latestRun.summary),
    } : null,
  };
}

function differencesFor(
  data: NormalizedImportData,
  existing: {
    status: string;
    totalAmount: { toString(): string };
    submittedAt: Date | null;
    accountHolderPerson: { id: string; firstName: string; lastName: string; normalizedEmail: string | null; phone: string | null };
    attendees: Array<{ attendeeType: string }>;
  },
) {
  const checks: Array<[string, string | number | null, string | number | null]> = [
    ["firstName", data.firstName, existing.accountHolderPerson.firstName],
    ["lastName", data.lastName, existing.accountHolderPerson.lastName],
    ["email", data.email || null, existing.accountHolderPerson.normalizedEmail],
    ["phone", data.phone || null, existing.accountHolderPerson.phone],
    ["status", data.status, existing.status],
    ["totalAmountCents", data.totalAmountCents, Math.round(Number(existing.totalAmount) * 100)],
    ["submittedAt", data.submittedAt, existing.submittedAt?.toISOString() ?? null],
    ["attendeeType", data.attendeeType, existing.attendees[0]?.attendeeType ?? null],
  ];
  return checks.filter(([, source, target]) => source !== target).map(([field, source, target]) => ({ field, source, target }));
}

export async function previewCsvImport(eventId: string, actorUserId: string, fileName: string, csvText: string) {
  const { checksum, sourceRunKey } = createImportSnapshotIdentity(eventId, csvText);
  const existingRun = await getPrisma().importRun.findUnique({ where: { sourceSystem_sourceRunKey: { sourceSystem: SOURCE_SYSTEM, sourceRunKey } } });
  if (existingRun) return { run: (await getImportRun(eventId, existingRun.id))!, reused: true };

  const parsed = parseImportCsv(csvText);
  const validRows = parsed.rows.filter((row): row is typeof row & { data: NormalizedImportData } => Boolean(row.data));
  const confirmationCodes = validRows.map((row) => row.data.confirmationCode);
  const emails = validRows.map((row) => row.data.email).filter(Boolean);
  const [existingRegistrations, existingPeople, targetBefore] = await Promise.all([
    getPrisma().registration.findMany({
      where: { eventId, confirmationCode: { in: confirmationCodes } },
      include: { accountHolderPerson: true, attendees: { orderBy: { createdAt: "asc" }, take: 1 } },
    }),
    getPrisma().person.findMany({ where: { normalizedEmail: { in: emails } } }),
    getEventTotals(getPrisma(), eventId),
  ]);
  const registrationByCode = new Map(existingRegistrations.map((registration) => [registration.confirmationCode, registration]));
  const personByEmail = new Map(existingPeople.map((person) => [person.normalizedEmail, person]));

  const analyzedRows = parsed.rows.map((row) => {
    const warnings = [...row.warnings];
    const errors = [...row.errors];
    let proposedAction = "ERROR";
    let matchedPersonId: string | null = null;
    let matchedRegistrationId: string | null = null;
    let differences: Array<{ field: string; source: string | number | null; target: string | number | null }> = [];
    if (row.data) {
      const registration = registrationByCode.get(row.data.confirmationCode);
      const emailMatch = row.data.email ? personByEmail.get(row.data.email) : null;
      matchedPersonId = registration?.accountHolderPersonId ?? emailMatch?.id ?? null;
      matchedRegistrationId = registration?.id ?? null;
      if (registration && emailMatch && emailMatch.id !== registration.accountHolderPersonId) {
        errors.push("The source email belongs to a different person than the matched confirmation code.");
      }
      if (emailMatch && (emailMatch.firstName !== row.data.firstName || emailMatch.lastName !== row.data.lastName)) {
        warnings.push(`Email matched existing person ${emailMatch.firstName} ${emailMatch.lastName}; review the name difference.`);
      }
      if (registration) {
        differences = differencesFor(row.data, registration);
        proposedAction = differences.length === 0 ? "SKIP" : "UPDATE";
      } else {
        proposedAction = "CREATE";
        if (emailMatch) warnings.push("An existing person will be reused for this new event registration.");
      }
    }
    if (errors.length > 0) proposedAction = "ERROR";
    const status = errors.length > 0 ? ImportRecordStatus.ERROR : warnings.length > 0 ? ImportRecordStatus.WARNING : ImportRecordStatus.READY;
    return { ...row, warnings: [...new Set(warnings)], errors: [...new Set(errors)], proposedAction, matchedPersonId, matchedRegistrationId, differences, status };
  });

  const sourceTotals = validRows.reduce((totals, row) => {
    totals.totalAmountCents += row.data.totalAmountCents;
    totals.statuses[row.data.status] = (totals.statuses[row.data.status] ?? 0) + 1;
    return totals;
  }, { rows: validRows.length, totalAmountCents: 0, statuses: {} as Record<string, number> });
  const warningCount = analyzedRows.filter((row) => row.warnings.length > 0).length;
  const errorCount = analyzedRows.filter((row) => row.errors.length > 0).length;
  const skippedCount = analyzedRows.filter((row) => row.proposedAction === "SKIP").length;

  try {
    const run = await getPrisma().importRun.create({
      data: {
        eventId,
        startedByUserId: actorUserId,
        sourceSystem: SOURCE_SYSTEM,
        sourceRunKey,
        fileName,
        sourceChecksum: checksum,
        status: ImportRunStatus.PENDING,
        recordsSkipped: skippedCount,
        warnings: warningCount,
        errors: errorCount,
        summary: { headers: parsed.headers, sourceTotals, targetBefore, productionSource: false, readOnlySource: true },
        records: {
          create: analyzedRows.map((row) => ({
            sourceRow: row.sourceRow,
            sourceRecordKey: row.data?.sourceId || `row-${row.sourceRow}`,
            confirmationCode: row.data?.confirmationCode || null,
            status: row.status,
            proposedAction: row.proposedAction,
            matchedPersonId: row.matchedPersonId,
            matchedRegistrationId: row.matchedRegistrationId,
            rawSnapshot: row.raw,
            normalizedData: row.data ?? Prisma.JsonNull,
            differences: row.differences,
            warnings: row.warnings,
            errors: row.errors,
          })),
        },
      },
    });
    return { run: (await getImportRun(eventId, run.id))!, reused: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const duplicate = await getPrisma().importRun.findUnique({ where: { sourceSystem_sourceRunKey: { sourceSystem: SOURCE_SYSTEM, sourceRunKey } } });
      if (duplicate) return { run: (await getImportRun(eventId, duplicate.id))!, reused: true };
    }
    throw error;
  }
}

export async function commitImportRun(eventId: string, importRunId: string, actorUserId: string) {
  const existing = await loadRun(eventId, importRunId);
  if (!existing) throw new ImportOperationError("IMPORT_NOT_FOUND", "That import preview no longer exists.");
  if (existing.status === ImportRunStatus.COMPLETED) return serializeRun(existing);
  if (existing.status !== ImportRunStatus.PENDING) throw new ImportOperationError("IMPORT_NOT_READY", "This import is not ready to commit.");
  if (existing.records.some((record) => record.status === ImportRecordStatus.ERROR)) {
    throw new ImportOperationError("IMPORT_HAS_ERRORS", "Resolve the preview errors before committing this import.");
  }

  await getPrisma().$transaction(async (tx) => {
    const claimed = await tx.importRun.updateMany({ where: { id: importRunId, eventId, status: ImportRunStatus.PENDING }, data: { status: ImportRunStatus.RUNNING } });
    if (claimed.count !== 1) throw new ImportOperationError("IMPORT_CONFLICT", "Another commit is already processing this import.");
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const record of existing.records.sort((left, right) => left.sourceRow - right.sourceRow)) {
      const data = normalizedData(record.normalizedData);
      let registrationId = record.matchedRegistrationId;
      let finalStatus: ImportRecordStatus = ImportRecordStatus.SKIPPED;
      if (record.proposedAction === "CREATE") {
        let personId = record.matchedPersonId;
        if (!personId) {
          const person = data.email
            ? await tx.person.upsert({
                where: { normalizedEmail: data.email },
                update: {},
                create: { firstName: data.firstName, lastName: data.lastName, normalizedEmail: data.email, phone: data.phone || null },
              })
            : await tx.person.create({ data: { firstName: data.firstName, lastName: data.lastName, phone: data.phone || null } });
          personId = person.id;
        }
        const registration = await tx.registration.create({
          data: {
            eventId,
            accountHolderPersonId: personId,
            confirmationCode: data.confirmationCode,
            status: data.status,
            totalAmount: data.totalAmountCents / 100,
            submittedAt: data.submittedAt ? new Date(data.submittedAt) : null,
            attendees: { create: { eventId, personId, attendeeType: data.attendeeType, profileSnapshot: { firstName: data.firstName, lastName: data.lastName, email: data.email || null, phone: data.phone || null, sourceId: data.sourceId } } },
          },
        });
        registrationId = registration.id;
        finalStatus = ImportRecordStatus.CREATED;
        created += 1;
      } else if (record.proposedAction === "UPDATE" && record.matchedRegistrationId) {
        const registration = await tx.registration.findFirst({ where: { id: record.matchedRegistrationId, eventId }, include: { attendees: { orderBy: { createdAt: "asc" }, take: 1 } } });
        if (!registration) throw new ImportOperationError("IMPORT_CONFLICT", `Registration ${data.confirmationCode} changed after preview.`);
        await tx.person.update({ where: { id: registration.accountHolderPersonId }, data: { firstName: data.firstName, lastName: data.lastName, normalizedEmail: data.email || null, phone: data.phone || null } });
        await tx.registration.update({ where: { id: registration.id }, data: { status: data.status, totalAmount: data.totalAmountCents / 100, submittedAt: data.submittedAt ? new Date(data.submittedAt) : null } });
        if (registration.attendees[0]) {
          await tx.registrationAttendee.update({ where: { id: registration.attendees[0].id }, data: { attendeeType: data.attendeeType, profileSnapshot: { firstName: data.firstName, lastName: data.lastName, email: data.email || null, phone: data.phone || null, sourceId: data.sourceId } } });
        }
        finalStatus = ImportRecordStatus.UPDATED;
        updated += 1;
      } else {
        skipped += 1;
      }
      await tx.importRecord.update({ where: { id: record.id }, data: { status: finalStatus, committedEntityId: registrationId } });
    }

    const targetAfter = await getEventTotals(tx, eventId);
    const previousSummary = jsonObject(existing.summary);
    await tx.importRun.update({
      where: { id: importRunId },
      data: {
        status: ImportRunStatus.COMPLETED,
        recordsCreated: created,
        recordsUpdated: updated,
        recordsSkipped: skipped,
        completedAt: new Date(),
        summary: {
          ...previousSummary,
          targetAfter,
          reconciliation: {
            registrationDifference: targetAfter.registrations - Number(jsonObject(previousSummary.targetBefore ?? null).registrations ?? 0),
            attendeeDifference: targetAfter.attendees - Number(jsonObject(previousSummary.targetBefore ?? null).attendees ?? 0),
          },
        },
      },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "STAGING_IMPORT_COMPLETED",
        entityType: "ImportRun",
        entityId: importRunId,
        correlationId: randomUUID(),
        summary: `Committed local staging import ${existing.fileName ?? importRunId}: ${created} created, ${updated} updated, ${skipped} unchanged.`,
        metadata: { created, updated, skipped, sourceSystem: SOURCE_SYSTEM, productionWrite: false },
      },
    });
  }, { timeout: 30_000 });

  return (await getImportRun(eventId, importRunId))!;
}

export async function listImportExceptions(eventId: string, importRunId: string) {
  const run = await loadRun(eventId, importRunId);
  if (!run) throw new ImportOperationError("IMPORT_NOT_FOUND", "That import run was not found.");
  return run.records
    .filter((record) => jsonStrings(record.errors).length > 0 || jsonStrings(record.warnings).length > 0)
    .sort((left, right) => left.sourceRow - right.sourceRow)
    .map((record) => ({
      sourceRow: record.sourceRow,
      sourceRecordKey: record.sourceRecordKey,
      confirmationCode: record.confirmationCode ?? "",
      action: record.proposedAction,
      errors: jsonStrings(record.errors).join(" | "),
      warnings: jsonStrings(record.warnings).join(" | "),
    }));
}

export { CsvImportError };
