/**
 * Proves the Honors Weekend sites guarantees (#589) against a real PostgreSQL
 * database: two sites can reuse a session name, sessions with no site keep
 * today's one-name-per-event rule (the two partial unique indexes), a session
 * can't point at another event's site by accident of the schema, copying
 * between events and annual cloning place sessions at the same-named site and
 * leave a session with no site (counted as a warning) when nothing matches.
 * Uses fictitious data it creates and removes itself.
 *
 *   npm run test:honor-sites
 */
import { loadEnvConfig } from "@next/env";
import { Prisma, PrismaClient } from "@prisma/client";
import { cloneEvent, previewEventClone } from "../modules/event-clones/repository";
import { cloneDomainKeys, type CloneDomainKey } from "../modules/event-clones/domain";
import { applyHonorCopy, previewHonorCopy } from "../modules/honors/copy";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "honorsites";
const adminId = `${P}_admin`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function isUniqueViolation(work: Promise<unknown>) {
  try {
    await work;
    return false;
  } catch (error) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }
}

async function cleanup() {
  const ids = (await prisma.event.findMany({ where: { slug: { startsWith: `${P}-` } }, select: { id: true } })).map((event) => event.id);
  await prisma.auditLog.deleteMany({ where: { actorUserId: adminId } });
  await prisma.honorOffering.deleteMany({ where: { eventId: { in: ids } } });
  await prisma.honorSession.deleteMany({ where: { eventId: { in: ids } } });
  await prisma.event.deleteMany({ where: { slug: { startsWith: `${P}-` } } });
  await prisma.honor.deleteMany({ where: { code: { startsWith: `${P}-` } } });
  await prisma.user.deleteMany({ where: { id: adminId } });
}

const none = { value: null, none: true } as const;
const noneIncluded = Object.fromEntries(cloneDomainKeys.map((key) => [key, false])) as Record<CloneDomainKey, boolean>;

async function createEvent(slug: string) {
  return prisma.event.create({
    data: { name: `Honorsites ${slug}`, slug: `${P}-${slug}`, startsAt: new Date("2027-05-01T15:00:00Z"), endsAt: new Date("2027-05-02T20:00:00Z") },
  });
}

const location = (eventId: string, name: string, sortOrder: number) => prisma.eventLocation.create({
  data: { eventId, name, normalizedName: name.toLocaleLowerCase("en-US"), sortOrder },
});
const session = (eventId: string, name: string, locationId: string | null, sortOrder = 0) => prisma.honorSession.create({
  data: { eventId, locationId, name, normalizedName: name.toLocaleLowerCase("en-US"), sortOrder },
});

async function run() {
  await prisma.user.create({ data: { id: adminId, email: `${P}-admin@example.test`, displayName: "Honor Sites Admin", globalRole: "SYSTEM_ADMIN" } });
  const honor = await prisma.honor.create({ data: { code: `${P}-honor`, name: "Honorsites Knots", normalizedName: `${P} knots` } });

  // 1. Per-site names, and today's rule for sessions with no site.
  const source = await createEvent("source");
  const des = await location(source.id, "Des Moines", 1);
  const kc = await location(source.id, "Kansas City", 2);
  const desMorning = await session(source.id, "Sabbath Morning", des.id);
  const kcMorning = await session(source.id, "Sabbath Morning", kc.id);
  const sunday = await session(source.id, "Sunday", null, 5);
  assert(desMorning.id !== kcMorning.id, "two sites can both have a Sabbath Morning");
  assert(await isUniqueViolation(session(source.id, "Sabbath Morning", des.id)), "one site can't repeat a session name");
  assert(await isUniqueViolation(session(source.id, "Sunday", null)), "sessions with no site keep one name per event");
  const desSunday = await session(source.id, "Sunday", des.id).catch(() => null);
  assert(desSunday, "a site's session may reuse a no-site session's name");
  await prisma.honorSession.delete({ where: { id: desSunday.id } });
  const other = await createEvent("other");
  assert(!(await isUniqueViolation(session(other.id, "Sunday", null))), "another event may reuse any name");
  await prisma.honorOffering.createMany({ data: [
    { eventId: source.id, honorId: honor.id, sessionId: desMorning.id, span: "SINGLE_SESSION", capacity: 10 },
    { eventId: source.id, honorId: honor.id, sessionId: sunday.id, span: "SINGLE_SESSION", capacity: 10 },
  ] });
  console.log("ok  per-site session names and the no-site rule hold in PostgreSQL");

  // 2. Copy between events maps sessions to the same-named site.
  const target = await createEvent("target");
  const targetDes = await location(target.id, "DES MOINES", 0);
  const plan = await previewHonorCopy(target.id, source.id);
  assert(plan.warnings.length === 1 && plan.warnings[0]!.includes("Kansas City"), `a site with no match warns, got ${JSON.stringify(plan.warnings)}`);
  await applyHonorCopy(target.id, source.id, plan.fingerprint, adminId);
  const copied = await prisma.honorSession.findMany({ where: { eventId: target.id }, orderBy: [{ sortOrder: "asc" }] });
  const bySite = (locationId: string | null) => copied.filter((row) => row.locationId === locationId).map((row) => row.name).sort();
  assert(bySite(targetDes.id).join() === "Sabbath Morning" && bySite(null).join() === "Sabbath Morning,Sunday", `copy maps by site name and leaves the unmatched one with no site, got ${JSON.stringify(copied.map((row) => [row.name, row.locationId]))}`);
  console.log("ok  copying maps sessions to the same-named site and leaves an unmatched site's session with none");

  // 3. Annual cloning does the same, and counts the warning.
  await prisma.eventLocation.update({ where: { id: kc.id }, data: { isActive: false } });
  const clonePlan = await previewEventClone(adminId, { sourceEventId: source.id });
  const cloned = await cloneEvent(adminId, {
    sourceEventId: source.id,
    expectedFingerprint: clonePlan.fingerprint,
    requestKey: `${P}-key`,
    name: "Honorsites Annual 2028",
    slug: `${P}-clone`,
    startsOn: "2028-05-04",
    endsOn: "2028-05-06",
    capacity: none,
    registrationOpensOn: none,
    registrationClosesOn: none,
    include: { ...noneIncluded, honors: true, locations: true },
    formLatePricingDates: [],
    formChoiceLimits: [],
    promoCodeWindows: [],
    honorOfferingCapacities: clonePlan.review.honorOfferings.map((offering) => ({ offeringId: offering.offeringId, capacity: 12, perClubLimit: 3 })),
  });
  const cloneLocations = await prisma.eventLocation.findMany({ where: { eventId: cloned.event.id } });
  const cloneSessions = await prisma.honorSession.findMany({ where: { eventId: cloned.event.id } });
  const cloneDes = cloneLocations.find((row) => row.name === "Des Moines");
  assert(cloneLocations.length === 1 && cloneDes, "only the active location is cloned");
  assert(cloneSessions.length === 3, `every session is cloned once, got ${cloneSessions.length}`);
  assert(cloneSessions.filter((row) => row.locationId === cloneDes.id).map((row) => row.name).join() === "Sabbath Morning", "the Des Moines session lands at the clone's Des Moines");
  assert(cloneSessions.filter((row) => row.locationId === null).map((row) => row.name).sort().join() === "Sabbath Morning,Sunday", "the session at the deactivated site, and the shared one, have no site");
  assert(cloned.summary?.skipped.honorSessionsWithoutSite === 1, `the clone counts the session left with no site, got ${JSON.stringify(cloned.summary?.skipped)}`);
  const cloneOfferings = await prisma.honorOffering.findMany({ where: { eventId: cloned.event.id }, include: { session: true } });
  assert(cloneOfferings.length === 2 && cloneOfferings.every((row) => row.session && row.session.eventId === cloned.event.id), "the clone's classes point at the clone's own sessions");
  console.log("ok  annual cloning maps sessions by site name and counts a session left with no site");
}

async function main() {
  await cleanup();
  try {
    await run();
  } finally {
    await cleanup();
  }
  console.log("Honor sites verification passed.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
