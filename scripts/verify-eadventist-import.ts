/**
 * Proves the eAdventist organizations import (#649) against a real PostgreSQL
 * database with the synthetic fixture CSV (fictitious names only):
 *
 * - a first upload previews and commits 12 organizations of every kind, each
 *   with its EADVENTIST ExternalIdentity matching Organization.eadventistId,
 *   and one audit entry that holds counts only;
 * - uploading the same file again previews 12 unchanged and changes no row;
 * - a possible match with no choice is refused (NEEDS_CHOICES) and nothing is
 *   written; a stale choice asks again; a real choice links the church;
 * - a club holding an id is skipped and left untouched;
 * - (#724) the import creates an IMPORT church location for the active church
 *   only (no group, school or company), never overwrites a MANUAL one, and
 *   "Find map locations" (with the offline fake provider) stores a result for
 *   a church with a street address, skips a hand-set church, and accepting a
 *   match marks the location GEOCODED; a changed address drops the point.
 *
 * Creates and removes its own rows. Needs a migrated database.
 *
 *   npm run test:eadventist-import
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import type { GeocodeRequest } from "../integrations/geocoding/types";

loadEnvConfig(process.cwd());

// "Find map locations" (#724) is off unless this is set; the fake provider is used, never the network.
process.env.GEOCODING_ENABLED = "true";

const prisma = new PrismaClient();
const fixture = readFileSync(join(process.cwd(), "tests", "fixtures", "eadventist-organizations-synthetic.csv"), "utf8");
const ids = Array.from({ length: 12 }, (_, index) => String(9001 + index));
const stamp = `ea649${Date.now().toString(36)}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function wipe(userId: string) {
  const found = await prisma.organization.findMany({
    where: { OR: [{ eadventistId: { in: ids } }, { name: { startsWith: stamp } }, { externalIdentities: { some: { provider: "EADVENTIST", externalId: { in: ids } } } }] },
    select: { id: true },
  });
  const orgIds = found.map((org) => org.id);
  await prisma.organization.deleteMany({ where: { id: { in: orgIds }, type: "CLUB" } });
  await prisma.organization.updateMany({ where: { id: { in: orgIds } }, data: { affiliatedOrganizationId: null } });
  await prisma.externalIdentity.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: userId } });
}

async function main() {
  const { commitEadventistImport, previewEadventistImport } = await import("../modules/organizations/eadventist-import-repository");
  const user = await prisma.user.create({ data: { email: `${stamp}@example.test`, displayName: `${stamp} admin`, globalRole: "SYSTEM_ADMIN" } });
  let looseId: string | null = null;
  try {
    await wipe(user.id);

    // 1. First upload.
    const preview = await previewEadventistImport(fixture);
    assert(preview.counts.new === 12 && preview.counts.flagged === 1 && preview.needsChoice === 0, `first preview: ${JSON.stringify(preview.counts)}`);
    assert((await prisma.organization.count({ where: { eadventistId: { in: ids } } })) === 0, "preview wrote nothing");
    const first = await commitEadventistImport(fixture, user.id);
    assert(first.counts.new === 12, "first commit adds 12");
    const orgs = await prisma.organization.findMany({ where: { eadventistId: { in: ids } }, include: { externalIdentities: true, affiliatedOrganization: true } });
    assert(orgs.length === 12, "12 organizations stored");
    assert(new Set(orgs.map((org) => org.type)).size === 10, "ten distinct kinds (three school levels share one)");
    assert(orgs.every((org) => org.externalIdentities.length === 1 && org.externalIdentities[0]!.provider === "EADVENTIST" && org.externalIdentities[0]!.externalId === org.eadventistId), "every organization has a matching EADVENTIST identity");
    const group = orgs.find((org) => org.type === "GROUP")!;
    assert(group.streetAddress === null && group.officePhone === null && group.city === "Sample Ridge" && group.disbandedOn?.toISOString().startsWith("2024-03-01"), "group keeps town only; disbanded date stored");
    const company = orgs.find((org) => org.type === "COMPANY")!;
    assert(company.affiliatedOrganization?.eadventistId === "9002", "company's parent is the church");
    const audit = await prisma.auditLog.findMany({ where: { actorUserId: user.id, action: "ORGANIZATIONS_EADVENTIST_IMPORTED" } });
    assert(audit.length === 1 && !JSON.stringify(audit).includes("Sample Hills"), "one audit entry, counts only");

    // 2. Re-upload is a no-op.
    const again = await previewEadventistImport(fixture);
    assert(again.counts.unchanged === 12 && again.counts.new === 0 && again.counts.updated === 0, `re-upload preview: ${JSON.stringify(again.counts)}`);
    const before = await prisma.organization.findMany({ where: { eadventistId: { in: ids } }, select: { id: true, updatedAt: true }, orderBy: { id: "asc" } });
    await commitEadventistImport(fixture, user.id);
    const after = await prisma.organization.findMany({ where: { eadventistId: { in: ids } }, select: { id: true, updatedAt: true }, orderBy: { id: "asc" } });
    assert(JSON.stringify(before) === JSON.stringify(after), "re-upload changed no row");
    assert((await prisma.externalIdentity.count({ where: { provider: "EADVENTIST", externalId: { in: ids } } })) === 12, "still 12 identities");

    // 3. Possible match, stale choice, club holding an id.
    await wipe(user.id);
    const loose = await prisma.organization.create({ data: { type: "CHURCH", name: "Sample Hills Seventh-day Adventist Church", normalizedName: "sample hills seventh-day adventist church" } });
    looseId = loose.id;
    const club = await prisma.organization.create({ data: { type: "CLUB", name: `${stamp} Club`, normalizedName: `${stamp} club`, parentOrganizationId: loose.id, eadventistId: "9003" } });
    const countBefore = await prisma.organization.count();
    const auditBefore = await prisma.auditLog.count({ where: { actorUserId: user.id } });

    const waiting = await previewEadventistImport(fixture);
    assert(waiting.needsChoice === 1, "one possible match needs a choice");
    let refused = "";
    try { await commitEadventistImport(fixture, user.id); } catch (error) { refused = (error as { code?: string }).code ?? String(error); }
    assert(refused === "NEEDS_CHOICES", `commit without a choice refused (got ${refused})`);
    assert((await prisma.organization.count()) === countBefore && (await prisma.auditLog.count({ where: { actorUserId: user.id } })) === auditBefore, "refusal wrote nothing");

    let staleRefused = "";
    try { await commitEadventistImport(fixture, user.id, { "9002": "no-such-church" }); } catch (error) { staleRefused = (error as { code?: string }).code ?? String(error); }
    assert(staleRefused === "NEEDS_CHOICES", "a stale choice asks again");

    const linked = await commitEadventistImport(fixture, user.id, { "9002": loose.id });
    const skipped = linked.items.filter((item) => item.action === "SKIPPED");
    assert(skipped.length === 1 && skipped[0]!.eadventistId === "9003" && skipped[0]!.notes.includes("This eAdventist id belongs to a club; not imported"), "the club's id row is skipped");
    const clubAfter = await prisma.organization.findUniqueOrThrow({ where: { id: club.id } });
    assert(clubAfter.type === "CLUB" && clubAfter.name === `${stamp} Club` && clubAfter.eadventistId === "9003", "the club is untouched");
    const church = await prisma.organization.findUniqueOrThrow({ where: { id: loose.id }, include: { externalIdentities: true } });
    assert(church.eadventistId === "9002" && church.name === "Sample Hills SDA Church" && church.externalIdentities[0]?.externalId === "9002", "the church is linked, renamed, and has its identity");
    assert((await prisma.organization.count()) === countBefore + 10, "the other ten rows were created (12 minus the linked church and the club's row)");

    // 4. Church map locations (#724).
    await wipe(user.id);
    const manual = await prisma.organization.create({ data: { type: "CHURCH", name: `${stamp} Manual Church`, normalizedName: `${stamp} manual church`, streetAddress: "7 Manual Way", city: "Sample Hills", state: "ZZ", postalCode: "00001" } });
    await prisma.churchLocation.create({ data: { organizationId: manual.id, city: "Typed Town", state: "ZZ", source: "MANUAL" } });
    const mapped = await commitEadventistImport(fixture, user.id);
    assert(mapped.locationCounts.created === 1 && mapped.locationCounts.updated === 0, `one location created: ${JSON.stringify(mapped.locationCounts)}`);
    const importedOrgs = await prisma.organization.findMany({ where: { eadventistId: { in: ids } }, include: { churchLocation: true } });
    const withLocation = importedOrgs.filter((org) => org.churchLocation);
    assert(withLocation.length === 1 && withLocation[0]!.type === "CHURCH", "only the active church got a location");
    const importedChurch = withLocation[0]!;
    assert(importedChurch.churchLocation!.source === "IMPORT" && importedChurch.churchLocation!.latitude === null && importedChurch.churchLocation!.city === "Sample Hills", "imported location has the town and no point");
    assert((await prisma.churchGeocodeResult.count({ where: { organizationId: { in: importedOrgs.map((org) => org.id) } } })) === 0, "the import geocoded nothing");
    assert((await previewEadventistImport(fixture)).locationCounts.created === 0, "re-upload plans no location work");

    const { runChurchGeocoding, acceptGeocodeResult, listGeocodeReview } = await import("../modules/organizations/church-geocoding");
    const { createFakeGeocodingProvider } = await import("../integrations/geocoding/fake");
    const calls: GeocodeRequest[][] = [];
    const summary = await runChurchGeocoding(user.id, createFakeGeocodingProvider({ calls }));
    const sentIds = calls.flat().map((request) => request.id);
    assert(sentIds.includes(importedChurch.id), "the imported church was looked up");
    assert(!sentIds.includes(manual.id), "the hand-set church was never sent");
    assert(importedOrgs.filter((org) => org.type === "GROUP").every((org) => !sentIds.includes(org.id)), "no group was sent");
    assert(summary.matched >= 1, "the fake provider matched the church");
    const review = await listGeocodeReview();
    assert(review.some((item) => item.organizationId === importedChurch.id && item.status === "MATCHED"), "the match is waiting for review");
    assert((await prisma.churchLocation.findUniqueOrThrow({ where: { organizationId: importedChurch.id } })).latitude === null, "nothing reaches the location before acceptance");
    await acceptGeocodeResult(importedChurch.id, user.id);
    const accepted = await prisma.churchLocation.findUniqueOrThrow({ where: { organizationId: importedChurch.id } });
    assert(accepted.source === "GEOCODED" && accepted.latitude !== null && accepted.city === "Sample Hills", "accepted match is GEOCODED with the town kept");
    const geocodeAudit = await prisma.auditLog.findMany({ where: { actorUserId: user.id, action: { in: ["CHURCH_GEOCODING_RUN", "CHURCH_GEOCODE_ACCEPTED"] } } });
    assert(geocodeAudit.length === 2 && !JSON.stringify(geocodeAudit).includes("Sample Road"), "run and accept audited without addresses");
    assert((await previewEadventistImport(fixture)).locationCounts.updated === 0, "an unchanged re-upload leaves the geocoded point alone");
    const moved = await commitEadventistImport(fixture.replace("10 Sample Road", "99 Sample Road"), user.id);
    assert(moved.locationCounts.updated === 1, "a changed street drops the stale point");
    const dropped = await prisma.churchLocation.findUniqueOrThrow({ where: { organizationId: importedChurch.id } });
    assert(dropped.source === "IMPORT" && dropped.latitude === null, "the location returned to IMPORT without a point");
    const stillManual = await prisma.churchLocation.findUniqueOrThrow({ where: { organizationId: manual.id } });
    assert(stillManual.source === "MANUAL" && stillManual.city === "Typed Town", "the hand-set location was never touched");

    console.log("eAdventist import checks passed.");
  } finally {
    await wipe(user.id).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { type: "CLUB", name: { startsWith: stamp } } }).catch(() => undefined);
    if (looseId) await prisma.organization.deleteMany({ where: { id: looseId } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { name: { startsWith: stamp } } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
