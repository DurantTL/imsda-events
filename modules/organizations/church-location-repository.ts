import "server-only";

import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { OrganizationOperationError } from "@/modules/organizations/repository";
import type { ChurchLocationInput } from "@/modules/organizations/church-location-schemas";

/**
 * A church's town and, when known, map coordinates (#437). This form is the
 * hand-set path: whatever staff save here is marked MANUAL (#724), so neither
 * the eAdventist import nor "Find map locations" will overwrite it. It never
 * calls an external service. Edited by conference staff from the church's
 * admin page, gated the same as any other organization edit.
 */

const locationFields = ["city", "state", "zip", "latitude", "longitude"] as const;

export async function getChurchLocation(organizationId: string) {
  const church = await getPrisma().organization.findUnique({
    where: { id: organizationId },
    select: { id: true, type: true, name: true, churchLocation: true },
  });
  if (!church || church.type !== "CHURCH") return null;
  const location = church.churchLocation;
  return {
    id: church.id,
    name: church.name,
    city: location?.city ?? "",
    state: location?.state ?? "",
    zip: location?.zip ?? "",
    latitude: location?.latitude ?? null,
    longitude: location?.longitude ?? null,
    source: location?.source ?? null,
    updatedAt: location?.updatedAt.toISOString() ?? null,
  };
}

export type ChurchLocationRecord = NonNullable<Awaited<ReturnType<typeof getChurchLocation>>>;

export async function updateChurchLocation(organizationId: string, input: ChurchLocationInput, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    const church = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, type: true, name: true, churchLocation: true },
    });
    if (!church || church.type !== "CHURCH") {
      throw new OrganizationOperationError("ORGANIZATION_NOT_FOUND", "That church could not be found.");
    }

    const changed: string[] = [];
    for (const field of locationFields) {
      const before = church.churchLocation?.[field] ?? (field === "latitude" || field === "longitude" ? null : "");
      if (input[field] !== before) changed.push(field);
    }
    // Saving by hand claims an imported or geocoded location, even unchanged.
    const claims = church.churchLocation !== null && church.churchLocation.source !== "MANUAL";
    if (changed.length === 0 && !claims) return;

    await tx.churchLocation.upsert({
      where: { organizationId },
      create: { organizationId, ...input, source: "MANUAL" },
      update: { ...input, source: "MANUAL" },
    });
    // Coordinates and ZIP place a pin on a map; keep them out of the log line.
    await writeAuditLog({
      actorUserId,
      action: "CHURCH_LOCATION_UPDATED",
      entityType: "Organization",
      entityId: organizationId,
      summary: `Updated the location for ${church.name}.`,
      metadata: { organizationId, fields: changed, ...(claims ? { claimedFrom: church.churchLocation!.source } : {}) },
    }, tx);
  });
  return getChurchLocation(organizationId);
}
