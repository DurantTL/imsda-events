import "server-only";

import { Prisma, type OrganizationType } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { normalizeOrganizationName } from "@/modules/organizations/domain";
import {
  parseEadventistCsv,
  planEadventistImport,
  type ExistingOrganization,
  type ImportPlan,
  type PlanItem,
} from "@/modules/organizations/eadventist-import";
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

async function loadExisting(client: Client): Promise<ExistingOrganization[]> {
  const rows = await client.organization.findMany({
    where: { OR: [{ eadventistId: { not: null } }, { type: "CHURCH" }] },
    select: {
      id: true, type: true, name: true, normalizedName: true, eadventistId: true, orgCode: true, sourceOrgType: true,
      streetAddress: true, city: true, state: true, postalCode: true, website: true, officePhone: true, district: true,
      language: true, disbandedOn: true,
      affiliatedOrganization: { select: { eadventistId: true } },
    },
  });
  return rows.map(({ affiliatedOrganization, disbandedOn, ...row }) => ({
    ...row,
    disbandedOn: isoDay(disbandedOn),
    affiliatedEadventistId: affiliatedOrganization?.eadventistId ?? null,
  }));
}

/** What the upload screen shows: no field values beyond the name and kind. */
export type ImportPreviewItem = Pick<PlanItem, "line" | "name" | "kind" | "action" | "matchedBy" | "notes" | "disbandedOn">;
export type ImportPreview = { counts: ImportPlan["counts"]; items: ImportPreviewItem[]; rejected: ImportPlan["rejected"] };

function previewOf(plan: ImportPlan): ImportPreview {
  return {
    counts: plan.counts,
    rejected: plan.rejected,
    items: plan.items.map(({ line, name, kind, action, matchedBy, notes, disbandedOn }) => ({ line, name, kind, action, matchedBy, notes, disbandedOn })),
  };
}

/** Reads the file and reports what committing it would do. Writes nothing. */
export async function previewEadventistImport(csv: string): Promise<ImportPreview> {
  const parsed = parseEadventistCsv(csv);
  const existing = await getPrisma().$transaction((tx) => loadExisting(tx));
  return previewOf(planEadventistImport(parsed, existing));
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
export async function commitEadventistImport(csv: string, actorUserId: string): Promise<ImportCommitResult> {
  const parsed = parseEadventistCsv(csv);
  try {
    return await getPrisma().$transaction(async (tx) => {
      const plan = planEadventistImport(parsed, await loadExisting(tx));
      const idByEadventistId = new Map<string, string>();
      let churchesKept = 0;

      for (const item of plan.items) {
        const record = item.record;
        if (!record) continue;
        if (item.action === "NEW") {
          const created = await tx.organization.create({
            data: { ...dataFor(record), type: record.type, eadventistId: record.eadventistId, isActive: record.isActive },
            select: { id: true },
          });
          idByEadventistId.set(record.eadventistId, created.id);
        } else if (item.existingId) {
          idByEadventistId.set(record.eadventistId, item.existingId);
          if (item.action === "UNCHANGED") continue;
          const current = await tx.organization.findUniqueOrThrow({ where: { id: item.existingId }, select: { type: true } });
          let type: OrganizationType = record.type;
          if (current.type !== record.type && current.type === "CHURCH") {
            // A church that sponsors clubs stays a church: those clubs depend on it.
            const clubs = await tx.organization.count({ where: { parentOrganizationId: item.existingId } });
            if (clubs > 0) {
              type = current.type;
              churchesKept += 1;
            }
          }
          await tx.organization.update({ where: { id: item.existingId }, data: { ...dataFor(record), type, eadventistId: record.eadventistId } });
        }
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

      await writeAuditLog({
        actorUserId,
        action: "ORGANIZATIONS_EADVENTIST_IMPORTED",
        entityType: "OrganizationImport",
        summary: `Imported the eAdventist organizations export: ${plan.counts.new} new, ${plan.counts.updated} updated, ${plan.counts.unchanged} unchanged, ${plan.counts.skipped} skipped, ${plan.counts.flagged} flagged as disbanded.`,
        metadata: { ...plan.counts, rejected: plan.rejected.length, churchesKeptAsChurch: churchesKept },
      }, tx);
      return { ...previewOf(plan), committed: true as const };
    }, { timeout: 60_000, maxWait: 10_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new OrganizationOperationError("ORGANIZATION_CONFLICT", "Another upload changed these organizations at the same time. Nothing was saved. Upload the file again.");
    }
    throw error;
  }
}

export type DirectoryStatusFilter = "ALL" | "ACTIVE" | "INACTIVE" | "REVIEW";
export type DirectoryFilters = { kind: OrganizationType | null; status: DirectoryStatusFilter; query: string };

export const DIRECTORY_LIST_LIMIT = 500;

/** The staff list of imported and other non-club organizations, filtered by kind and status. */
export async function listDirectoryOrganizations(filters: DirectoryFilters) {
  const where: Prisma.OrganizationWhereInput = {
    type: filters.kind && filters.kind !== "CLUB" ? filters.kind : { not: "CLUB" },
    ...(filters.status === "ACTIVE" ? { isActive: true } : {}),
    ...(filters.status === "INACTIVE" ? { isActive: false } : {}),
    // "Needs review": still active but a disbanded date is on file.
    ...(filters.status === "REVIEW" ? { isActive: true, disbandedOn: { not: null } } : {}),
    ...(filters.query.trim() ? { normalizedName: { contains: normalizeOrganizationName(filters.query) } } : {}),
  };
  const [rows, total] = await Promise.all([
    getPrisma().organization.findMany({
      where,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: DIRECTORY_LIST_LIMIT,
      select: {
        id: true, type: true, name: true, isActive: true, sourceOrgType: true, city: true, state: true, district: true,
        website: true, officePhone: true, disbandedOn: true, eadventistId: true,
        affiliatedOrganization: { select: { name: true } },
      },
    }),
    getPrisma().organization.count({ where }),
  ]);
  return {
    total,
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
