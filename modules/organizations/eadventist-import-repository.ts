import "server-only";

import { Prisma, type OrganizationType } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { normalizeOrganizationName } from "@/modules/organizations/domain";
import {
  EadventistImportError,
  parseEadventistCsv,
  planEadventistImport,
  NEW_RECORD,
  type ExistingOrganization,
  type LinkChoices,
  type ImportPlan,
  type PlanItem,
} from "@/modules/organizations/eadventist-import";
import { clampPage } from "@/lib/pagination";
import { organizationSearchWhere } from "@/modules/organizations/search";
import { OrganizationOperationError } from "@/modules/organizations/repository";

/**
 * Storage for the eAdventist organizations import (#649). The uploaded file is
 * parsed in memory and never stored or logged. Preview and commit both plan
 * from the CSV against the database as it is at that moment, so the commit
 * applies exactly what the same file previews now, not what it previewed
 * earlier. Audit entries carry counts, never names or contact details.
 */

type Client = Prisma.TransactionClient;

const isoDay = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

/**
 * Stored organizations, plus the eAdventist ids held where an import must not
 * touch them: by a person, or by an organization at another provider scope.
 * Those would collide with the unique identity key, so the row is skipped
 * with a conflict note instead of aborting the whole save.
 */
async function loadExisting(client: Client): Promise<{ existing: ExistingOrganization[]; blocked: Map<string, string> }> {
  const foreign = await client.externalIdentity.findMany({
    where: { provider: "EADVENTIST", OR: [{ personId: { not: null } }, { providerScope: { not: "" } }] },
    select: { externalId: true, personId: true },
  });
  const blocked = new Map(foreign.map((identity) => [
    identity.externalId,
    identity.personId
      ? "This eAdventist id is already recorded for a person, so this row was skipped. Resolve it and upload again."
      : "This eAdventist id is already recorded under another provider scope, so this row was skipped. Resolve it and upload again.",
  ]));
  const rows = await client.organization.findMany({
    where: { OR: [{ eadventistId: { not: null } }, { type: "CHURCH" }, { externalIdentities: { some: { provider: "EADVENTIST", providerScope: "" } } }] },
    select: {
      id: true, type: true, name: true, normalizedName: true, eadventistId: true, orgCode: true, sourceOrgType: true,
      streetAddress: true, city: true, state: true, postalCode: true, website: true, officePhone: true, district: true,
      language: true, disbandedOn: true, isActive: true,
      affiliatedOrganization: { select: { eadventistId: true } },
      externalIdentities: { where: { provider: "EADVENTIST", providerScope: "" }, select: { externalId: true }, take: 1 },
      churchLocation: { select: { organizationId: true, source: true, city: true, state: true, zip: true, latitude: true, longitude: true } },
      _count: { select: { childOrganizations: true, sponsoredPromoCodes: true } },
    },
  });
  const existing = rows.map(({ affiliatedOrganization, disbandedOn, externalIdentities, churchLocation, _count, ...row }) => ({
    ...row,
    disbandedOn: isoDay(disbandedOn),
    affiliatedEadventistId: affiliatedOrganization?.eadventistId ?? null,
    identityEadventistId: externalIdentities[0]?.externalId ?? null,
    hasDependents: _count.childOrganizations > 0 || _count.sponsoredPromoCodes > 0 || churchLocation !== null,
    location: churchLocation
      ? { source: churchLocation.source, city: churchLocation.city, state: churchLocation.state, zip: churchLocation.zip, hasCoordinates: churchLocation.latitude !== null && churchLocation.longitude !== null }
      : null,
  }));
  return { existing, blocked };
}

/** What the upload screen shows: no field values beyond the name and kind. */
export type ImportPreviewItem = Pick<PlanItem, "line" | "eadventistId" | "name" | "kind" | "action" | "matchedBy" | "notes" | "disbandedOn" | "possibleMatches" | "needsChoice"> & {
  /** For a possible match: the stored organization that will be linked, or `NEW` to create a new record. */
  selectedMatch: string | null;
  /** What the commit does to the church's map location (#724): city, state and ZIP only. */
  locationAction: "CREATE" | "UPDATE" | null;
};
export type ImportPreview = { counts: ImportPlan["counts"]; locationCounts: ImportPlan["locationCounts"]; needsChoice: number; items: ImportPreviewItem[]; rejected: ImportPlan["rejected"] };

function previewOf(plan: ImportPlan): ImportPreview {
  return {
    counts: plan.counts,
    locationCounts: plan.locationCounts,
    needsChoice: plan.needsChoice,
    rejected: plan.rejected,
    items: plan.items.map(({ line, eadventistId, name, kind, action, matchedBy, notes, disbandedOn, possibleMatches, needsChoice, existingId, location }) => ({
      line, eadventistId, name, kind, action, matchedBy, notes, disbandedOn, possibleMatches, needsChoice,
      locationAction: location?.action ?? null,
      selectedMatch: possibleMatches.length === 0 || needsChoice || action === "SKIPPED" ? null : matchedBy === "POSSIBLE" ? existingId : NEW_RECORD,
    })),
  };
}

/** Reads the file and reports what committing it would do. Writes nothing. */
export async function previewEadventistImport(csv: string, choices: LinkChoices = {}): Promise<ImportPreview> {
  const parsed = parseEadventistCsv(csv);
  const { existing, blocked } = await getPrisma().$transaction((tx) => loadExisting(tx));
  return previewOf(planEadventistImport(parsed, existing, choices, blocked));
}

export type ImportCommitResult = ImportPreview & { committed: true };

const dataFor = (record: NonNullable<PlanItem["record"]>) => ({
  name: record.name,
  normalizedName: normalizeOrganizationName(record.name),
  orgCode: record.orgCode,
  sourceOrgType: record.sourceOrgType,
  streetAddress: record.streetAddress,
  city: record.city,
  state: record.state,
  postalCode: record.postalCode,
  website: record.website,
  officePhone: record.officePhone,
  district: record.district,
  language: record.language,
  disbandedOn: record.disbandedOn ? new Date(`${record.disbandedOn}T00:00:00.000Z`) : null,
});

/**
 * Applies the file in one transaction. New records take the export's IsActive;
 * an existing record's active/inactive switch is never touched, so a staff
 * decision survives every re-upload.
 */
export async function commitEadventistImport(csv: string, actorUserId: string, choices: LinkChoices = {}): Promise<ImportCommitResult> {
  const parsed = parseEadventistCsv(csv);
  try {
    return await getPrisma().$transaction(async (tx) => {
      const { existing, blocked } = await loadExisting(tx);
      const plan = planEadventistImport(parsed, existing, choices, blocked);
      if (plan.needsChoice > 0) {
        throw new EadventistImportError("NEEDS_CHOICES", `${plan.needsChoice} ${plan.needsChoice === 1 ? "row needs" : "rows need"} a choice: link to the existing church or create a new record. Nothing was saved.`);
      }
      const idByEadventistId = new Map<string, string>();
      const now = new Date();

      for (const item of plan.items) {
        const record = item.record;
        if (!record || item.action === "SKIPPED") continue;
        let organizationId = item.existingId;
        if (item.action === "NEW") {
          const created = await tx.organization.create({
            data: { ...dataFor(record), type: item.kind, eadventistId: record.eadventistId, isActive: record.isActive },
            select: { id: true },
          });
          organizationId = created.id;
        } else if (organizationId) {
          idByEadventistId.set(record.eadventistId, organizationId);
          if (item.action === "UNCHANGED") continue;
          await tx.organization.update({ where: { id: organizationId }, data: { ...dataFor(record), type: item.kind, eadventistId: record.eadventistId } });
        }
        if (!organizationId) continue;
        idByEadventistId.set(record.eadventistId, organizationId);
        // The column and the ExternalIdentity both carry the id; keep them in step.
        await tx.externalIdentity.upsert({
          where: { organizationId_provider_providerScope: { organizationId, provider: "EADVENTIST", providerScope: "" } },
          create: { organizationId, provider: "EADVENTIST", providerScope: "", externalId: record.eadventistId, displayLabel: "eAdventist OrganizationID", lastVerifiedAt: now },
          update: { externalId: record.eadventistId, lastVerifiedAt: now },
        });
      }

      // Parents second, once every row has an id.
      for (const item of plan.items) {
        const record = item.record;
        if (!record || item.action === "UNCHANGED") continue;
        const id = idByEadventistId.get(record.eadventistId);
        if (!id) continue;
        const parentId = item.affiliatedEadventistId ? idByEadventistId.get(item.affiliatedEadventistId) ?? null : null;
        await tx.organization.update({ where: { id }, data: { affiliatedOrganizationId: parentId } });
      }

      // Map locations (#724): city, state and ZIP only. The import never
      // geocodes; a person triggers "Find map locations" separately. A hand-set
      // location never reaches here (the plan leaves it out).
      const applied = { created: 0, updated: 0 };
      for (const item of plan.items) {
        const record = item.record;
        const location = item.location;
        if (!record || !location) continue;
        const organizationId = idByEadventistId.get(record.eadventistId);
        if (!organizationId) continue;
        const place = { city: location.city, state: location.state, zip: location.zip };
        // Conditional writes: a location saved by hand since the plan was made is
        // never overwritten. A skipped write means "set by hand"; nothing else to do.
        if (location.action === "CREATE") {
          applied.created += (await tx.churchLocation.createMany({ data: [{ organizationId, ...place, source: "IMPORT" }], skipDuplicates: true })).count;
        } else {
          applied.updated += (await tx.churchLocation.updateMany({
            where: { organizationId, source: { not: "MANUAL" } },
            data: { ...place, ...(location.clearPoint ? { latitude: null, longitude: null, source: "IMPORT" as const } : {}) },
          })).count;
        }
      }

      // A saved "Find map locations" result is only good for the address it was
      // found for (this also clears an old skip): drop it when the address changed.
      for (const item of plan.items) {
        if (item.addressChanged && item.existingId && item.action !== "SKIPPED") {
          await tx.churchGeocodeResult.deleteMany({ where: { organizationId: item.existingId } });
          // Decided at write time, not from the earlier snapshot: a match accepted
          // after the plan was read is for the old address too.
          await tx.churchLocation.updateMany({
            where: { organizationId: item.existingId, source: "GEOCODED" },
            data: { latitude: null, longitude: null, source: "IMPORT" },
          });
        }
      }

      await writeAuditLog({
        actorUserId,
        action: "ORGANIZATIONS_EADVENTIST_IMPORTED",
        entityType: "OrganizationImport",
        summary: `Imported the eAdventist organizations export: ${plan.counts.new} new, ${plan.counts.updated} updated, ${plan.counts.unchanged} unchanged, ${plan.counts.skipped} skipped, ${plan.counts.flagged} flagged as disbanded; ${applied.created} church locations created, ${applied.updated} updated.`,
        metadata: { ...plan.counts, locationsCreated: applied.created, locationsUpdated: applied.updated, rejected: plan.rejected.length, keptAsChurch: plan.items.filter((item) => item.notes.some((note) => note.startsWith("Kept as a church"))).length },
      }, tx);
      return { ...previewOf(plan), locationCounts: applied, committed: true as const };
    }, { timeout: 60_000, maxWait: 10_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new OrganizationOperationError("ORGANIZATION_CONFLICT", "Another upload changed these organizations at the same time. Nothing was saved. Upload the file again.");
    }
    throw error;
  }
}

export type DirectoryStatusFilter = "ALL" | "ACTIVE" | "INACTIVE" | "REVIEW";
export type DirectoryFilters = { kind: OrganizationType | null; status: DirectoryStatusFilter; query: string; page?: number };

/** Rows per page in the organization directory (#723). */
export const DIRECTORY_PAGE_SIZE = 50;

/**
 * The staff list of imported and other non-club organizations, filtered by
 * kind and status, searched by name, place, code, district and parent (#723),
 * and paged.
 */
export async function listDirectoryOrganizations(filters: DirectoryFilters) {
  const where: Prisma.OrganizationWhereInput = {
    type: filters.kind && filters.kind !== "CLUB" ? filters.kind : { not: "CLUB" },
    ...(filters.status === "ACTIVE" ? { isActive: true } : {}),
    ...(filters.status === "INACTIVE" ? { isActive: false } : {}),
    // "Needs review": still active but a disbanded date is on file.
    ...(filters.status === "REVIEW" ? { isActive: true, disbandedOn: { not: null } } : {}),
    ...(organizationSearchWhere(filters.query) ?? {}),
  };
  const total = await getPrisma().organization.count({ where });
  const page = clampPage(filters.page ?? 1, total, DIRECTORY_PAGE_SIZE);
  const rows = await getPrisma().organization.findMany({
    where,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    skip: (page - 1) * DIRECTORY_PAGE_SIZE,
    take: DIRECTORY_PAGE_SIZE,
    select: {
      id: true, type: true, name: true, isActive: true, sourceOrgType: true, city: true, state: true, district: true,
      website: true, officePhone: true, disbandedOn: true, eadventistId: true,
      affiliatedOrganization: { select: { name: true } },
    },
  });
  return {
    total,
    page,
    pageSize: DIRECTORY_PAGE_SIZE,
    organizations: rows.map(({ disbandedOn, affiliatedOrganization, eadventistId, ...row }) => ({
      ...row,
      disbandedOn: isoDay(disbandedOn),
      parentName: affiliatedOrganization?.name ?? null,
      imported: eadventistId !== null,
    })),
  };
}

export type DirectoryOrganization = Awaited<ReturnType<typeof listDirectoryOrganizations>>["organizations"][number];

/** One-click active/inactive for a directory record (#649). Clubs are managed on their own screen. */
export async function setDirectoryOrganizationActive(organizationId: string, isActive: boolean, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    const existing = await tx.organization.findUnique({ where: { id: organizationId }, select: { id: true, type: true, isActive: true, name: true } });
    if (!existing || existing.type === "CLUB") {
      throw new OrganizationOperationError("ORGANIZATION_NOT_FOUND", "That organization could not be found.");
    }
    if (existing.isActive === isActive) return;
    if (!isActive && existing.type === "CHURCH") {
      const activeClub = await tx.organization.findFirst({ where: { parentOrganizationId: organizationId, type: "CLUB", isActive: true }, select: { id: true } });
      if (activeClub) {
        throw new OrganizationOperationError("ORGANIZATION_HAS_ACTIVE_CLUBS", "Move or deactivate this church's active clubs before deactivating the church.");
      }
    }
    await tx.organization.update({ where: { id: organizationId }, data: { isActive } });
    await writeAuditLog({
      actorUserId,
      action: isActive ? "ORGANIZATION_MARKED_ACTIVE" : "ORGANIZATION_MARKED_INACTIVE",
      entityType: "Organization",
      entityId: organizationId,
      summary: `Marked ${existing.name} ${isActive ? "active" : "inactive"}.`,
      metadata: { type: existing.type, isActive },
    }, tx);
  });
}
