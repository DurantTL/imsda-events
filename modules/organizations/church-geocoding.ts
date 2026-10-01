import "server-only";

import type { Prisma } from "@prisma/client";
import { GeocodingUnavailableError, type GeocodeRequest, type GeocodingProvider } from "@/integrations/geocoding/types";
import { geocodingEnabled, getGeocodingProvider } from "@/integrations/geocoding";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { locationZip } from "@/modules/organizations/eadventist-import";
import { OrganizationOperationError } from "@/modules/organizations/repository";

/**
 * "Find map locations" (#724): a staff-triggered step, never part of the
 * import, that looks up map points for churches that have a street address and
 * no point yet. This reverses the earlier "never geocode" rule (#437) for
 * public church addresses only; see docs/decisions/0014-church-geocoding.md.
 *
 * - Only active churches with a street address and a town are sent: groups
 *   (which often meet in homes) and organizations whose only address is a town
 *   never are. Only the street, city, state and ZIP leave the server.
 * - A location staff set by hand (source MANUAL) is never sent or overwritten.
 * - A run writes results for review; nothing reaches ChurchLocation until staff
 *   accept a match. If the service can't be reached, nothing is changed.
 * - System administrators only (checked by the routes); audits hold counts only.
 */

const eligibleWhere: Prisma.OrganizationWhereInput = {
  type: "CHURCH",
  isActive: true,
  streetAddress: { not: null },
  city: { not: null },
  state: { not: null },
  AND: [
    { OR: [{ churchLocation: null }, { churchLocation: { source: { not: "MANUAL" }, latitude: null } }] },
    // A result staff skipped stays skipped.
    { OR: [{ churchGeocodeResult: null }, { churchGeocodeResult: { decision: { not: "SKIPPED" } } }] },
  ],
};

/** Churches the next run would look up. */
export async function countGeocodableChurches() {
  return getPrisma().organization.count({ where: eligibleWhere });
}

export type GeocodeRunSummary = { processed: number; matched: number; noMatch: number };

export async function runChurchGeocoding(actorUserId: string, provider: GeocodingProvider | null = null): Promise<GeocodeRunSummary> {
  if (!geocodingEnabled()) {
    throw new OrganizationOperationError("GEOCODING_DISABLED", "Finding map locations is turned off on this server (GEOCODING_ENABLED).");
  }
  const prisma = getPrisma();
  const churches = await prisma.organization.findMany({
    where: eligibleWhere,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, streetAddress: true, city: true, state: true, postalCode: true },
  });
  const requests: GeocodeRequest[] = churches
    .filter((church) => (church.streetAddress ?? "").trim() !== "" && (church.city ?? "").trim() !== "")
    .map((church) => ({
      id: church.id,
      street: church.streetAddress!,
      city: church.city!,
      state: church.state!,
      zip: locationZip(church.postalCode),
    }));
  if (requests.length === 0) return { processed: 0, matched: 0, noMatch: 0 };

  const geocoder = provider ?? getGeocodingProvider();
  let outcomes;
  try {
    outcomes = await geocoder.geocode(requests);
  } catch (error) {
    if (error instanceof GeocodingUnavailableError) throw new OrganizationOperationError("GEOCODING_UNAVAILABLE", error.message);
    throw error;
  }

  const summary: GeocodeRunSummary = { processed: outcomes.length, matched: 0, noMatch: 0 };
  await prisma.$transaction(async (tx) => {
    for (const outcome of outcomes) {
      const data = outcome.status === "MATCHED"
        ? { status: "MATCHED" as const, latitude: outcome.latitude, longitude: outcome.longitude, matchedAddress: outcome.matchedAddress.slice(0, 300) }
        : { status: "NO_MATCH" as const, latitude: null, longitude: null, matchedAddress: "" };
      if (outcome.status === "MATCHED") summary.matched += 1;
      else summary.noMatch += 1;
      await tx.churchGeocodeResult.upsert({
        where: { organizationId: outcome.id },
        create: { organizationId: outcome.id, ...data, provider: geocoder.name },
        update: { ...data, provider: geocoder.name, decision: "PENDING" },
      });
    }
    await writeAuditLog({
      actorUserId,
      action: "CHURCH_GEOCODING_RUN",
      entityType: "OrganizationImport",
      summary: `Looked up map locations: ${summary.matched} matched, ${summary.noMatch} with no match.`,
      metadata: { processed: summary.processed, matched: summary.matched, noMatch: summary.noMatch, provider: geocoder.name },
    }, tx);
  }, { timeout: 60_000 });
  return summary;
}

export type GeocodeReviewItem = {
  organizationId: string;
  name: string;
  address: string;
  status: "MATCHED" | "NO_MATCH";
  latitude: number | null;
  longitude: number | null;
  matchedAddress: string;
};

/** Results waiting for a decision, matches first. Accepted and skipped ones drop off the list. */
export async function listGeocodeReview() {
  const rows = await getPrisma().churchGeocodeResult.findMany({
    where: { decision: "PENDING", organization: { type: "CHURCH", isActive: true } },
    orderBy: [{ status: "asc" }, { organization: { name: "asc" } }],
    select: {
      organizationId: true, status: true, latitude: true, longitude: true, matchedAddress: true,
      organization: { select: { name: true, streetAddress: true, city: true, state: true, postalCode: true } },
    },
  });
  return rows.map((row): GeocodeReviewItem => ({
    organizationId: row.organizationId,
    name: row.organization.name,
    address: [row.organization.streetAddress, row.organization.city, [row.organization.state, row.organization.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    status: row.status,
    latitude: row.latitude,
    longitude: row.longitude,
    matchedAddress: row.matchedAddress,
  }));
}

/** Puts an accepted match on the church's location, marked GEOCODED. A hand-set location is never touched. */
export async function acceptGeocodeResult(organizationId: string, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    const result = await tx.churchGeocodeResult.findUnique({
      where: { organizationId },
      select: {
        status: true, decision: true, latitude: true, longitude: true,
        organization: { select: { type: true, name: true, city: true, state: true, postalCode: true, churchLocation: { select: { source: true, city: true, state: true, zip: true } } } },
      },
    });
    if (!result || result.organization.type !== "CHURCH" || result.status !== "MATCHED" || result.decision !== "PENDING" || result.latitude === null || result.longitude === null) {
      throw new OrganizationOperationError("GEOCODE_RESULT_NOT_FOUND", "That match is no longer waiting for review.");
    }
    const location = result.organization.churchLocation;
    if (location?.source === "MANUAL") {
      throw new OrganizationOperationError("LOCATION_SET_BY_HAND", "This church's location was set by hand, so the match was not applied.");
    }
    const place = location
      ? { city: location.city, state: location.state, zip: location.zip }
      : { city: result.organization.city ?? "", state: result.organization.state ?? "", zip: locationZip(result.organization.postalCode) };
    await tx.churchLocation.upsert({
      where: { organizationId },
      create: { organizationId, ...place, latitude: result.latitude, longitude: result.longitude, source: "GEOCODED" },
      update: { latitude: result.latitude, longitude: result.longitude, source: "GEOCODED" },
    });
    await tx.churchGeocodeResult.update({ where: { organizationId }, data: { decision: "ACCEPTED" } });
    await writeAuditLog({
      actorUserId,
      action: "CHURCH_GEOCODE_ACCEPTED",
      entityType: "Organization",
      entityId: organizationId,
      summary: `Accepted a map location for ${result.organization.name}.`,
      metadata: { organizationId },
    }, tx);
  });
}

/** Leaves the church without a point; the result drops off the review list. */
export async function skipGeocodeResult(organizationId: string) {
  const { count } = await getPrisma().churchGeocodeResult.updateMany({
    where: { organizationId, decision: "PENDING" },
    data: { decision: "SKIPPED" },
  });
  if (count === 0) throw new OrganizationOperationError("GEOCODE_RESULT_NOT_FOUND", "That result is no longer waiting for review.");
}
