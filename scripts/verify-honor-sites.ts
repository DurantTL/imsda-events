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

type Include = Partial<Record<CloneDomainKey, boolean>>;

async function cloneOf(sourceId: string, slug: string, include: Include) {
  const plan = await previewEventClone(adminId, { sourceEventId: sourceId });
  return cloneEvent(adminId, {
    sourceEventId: sourceId,
    expectedFingerprint: plan.fingerprint,
    requestKey: `${P}-key-${slug}`,
    name: `Honorsites Annual ${slug}`,
    slug: `${P}-${slug}`,
    startsOn: "2028-05-04",
    endsOn: "2028-05-06",
    capacity: none,
    registrationOpensOn: none,
    registrationClosesOn: none,
    include: { ...noneIncluded, ...include },
    formLatePricingDates: [],
    formChoiceLimits: [],
    promoCodeWindows: [],
    honorOfferingCapacities: plan.review.honorOfferings.map((offering) => ({ offeringId: offering.offeringId, capacity: 12, perClubLimit: 3 })),
  });
}

const offering = (eventId: string, honorId: string, sessionId: string | null, locationId: string | null = null) => prisma.honorOffering.create({
  data: { eventId, honorId, sessionId, locationId, span: sessionId ? "SINGLE_SESSION" : "ALL_SESSIONS", capacity: 10 },
});

async function run() {
  await prisma.user.create({ data: { id: adminId, email: `${P}-admin@example.test`, displayName: "Honor Sites Admin", globalRole: "SYSTEM_ADMIN" } });
  const knots = await prisma.honor.create({ data: { code: `${P}-knots`, name: "Honorsites Knots", normalizedName: `${P} knots` } });
  const birds = await prisma.honor.create({ data: { code: `${P}-birds`, name: "Honorsites Birds", normalizedName: `${P} birds` } });

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
  console.log("ok  per-site session names and the no-site rule hold in PostgreSQL");

  // 2. All-sessions classes: per-site uniqueness, and the column is only for them.
  await offering(source.id, birds.id, null, des.id);
  await offering(source.id, birds.id, null, kc.id);
  assert(await isUniqueViolation(offering(source.id, birds.id, null, des.id)), "one site can't run an honor across all sessions twice");
  await offering(source.id, knots.id, null, null);
  assert(await isUniqueViolation(offering(source.id, knots.id, null, null)), "all-sessions classes with no site keep one per honor per event");
  await prisma.honorOffering.delete({ where: { id: (await prisma.honorOffering.findFirstOrThrow({ where: { eventId: source.id, honorId: knots.id } })).id } });
  const checked = await prisma.honorOffering.create({ data: { eventId: source.id, honorId: knots.id, sessionId: desMorning.id, locationId: des.id, span: "SINGLE_SESSION", capacity: 1 } })
    .then(() => false, () => true);
  assert(checked, "a single-session class can't carry its own site");
  await offering(source.id, knots.id, desMorning.id);
  await offering(source.id, knots.id, kcMorning.id);
  await offering(source.id, knots.id, sunday.id);
  console.log("ok  all-sessions classes are unique per site, and only they carry a site");

  // 3. Copy between events maps sessions and all-sessions classes to the same-named site.
  const target = await createEvent("target");
  const targetDes = await location(target.id, "DES MOINES", 0);
  const plan = await previewHonorCopy(target.id, source.id);
  assert(plan.warnings.length === 2 && plan.warnings.every((warning) => warning.includes("Kansas City")), `a site with no match warns for its session and its all-sessions class, got ${JSON.stringify(plan.warnings)}`);
  await applyHonorCopy(target.id, source.id, plan.fingerprint, adminId);
  const copied = await prisma.honorSession.findMany({ where: { eventId: target.id }, orderBy: [{ sortOrder: "asc" }] });
  const bySite = (locationId: string | null) => copied.filter((row) => row.locationId === locationId).map((row) => row.name).sort();
  assert(bySite(targetDes.id).join() === "Sabbath Morning" && bySite(null).join() === "Sabbath Morning (Kansas City),Sunday", `copy maps by site name and names the unmatched one after its site, got ${JSON.stringify(copied.map((row) => [row.name, row.locationId]))}`);
  const copiedBirds = await prisma.honorOffering.findMany({ where: { eventId: target.id, honorId: birds.id }, orderBy: { locationId: "asc" } });
  assert(copiedBirds.length === 2 && copiedBirds.some((row) => row.locationId === targetDes.id) && copiedBirds.some((row) => row.locationId === null), "the all-sessions class follows its site by name, or gets none");
  console.log("ok  copying maps sessions and all-sessions classes to the same-named site and names an unmatched one after its site");

  // 4. Annual cloning does the same, and counts what lost its site.
  await prisma.eventLocation.update({ where: { id: kc.id }, data: { isActive: false } });
  const cloned = await cloneOf(source.id, "clone", { honors: true, locations: true });
  const cloneLocations = await prisma.eventLocation.findMany({ where: { eventId: cloned.event.id } });
  const cloneSessions = await prisma.honorSession.findMany({ where: { eventId: cloned.event.id } });
  const cloneDes = cloneLocations.find((row) => row.name === "Des Moines");
  assert(cloneLocations.length === 1 && cloneDes, "only the active location is cloned");
  assert(cloneSessions.length === 3, `every session is cloned once, got ${cloneSessions.length}`);
  assert(cloneSessions.filter((row) => row.locationId === cloneDes.id).map((row) => row.name).join() === "Sabbath Morning", "the Des Moines session lands at the clone's Des Moines");
  assert(cloneSessions.filter((row) => row.locationId === null).map((row) => row.name).sort().join() === "Sabbath Morning (Kansas City),Sunday", "the session at the deactivated site keeps its own row, named after its site");
  const cloneBirds = await prisma.honorOffering.findMany({ where: { eventId: cloned.event.id, honorId: birds.id } });
  assert(cloneBirds.length === 2 && cloneBirds.filter((row) => row.locationId === cloneDes.id).length === 1 && cloneBirds.filter((row) => row.locationId === null).length === 1, "all-sessions classes follow their site by name");
  assert(cloned.summary?.skipped.honorSessionsWithoutSite === 2, `the clone counts the session and class left with no site, got ${JSON.stringify(cloned.summary?.skipped)}`);
  const cloneOfferings = await prisma.honorOffering.findMany({ where: { eventId: cloned.event.id, sessionId: { not: null } }, include: { session: true } });
  assert(cloneOfferings.length === 3 && cloneOfferings.every((row) => row.session && row.session.eventId === cloned.event.id), "the clone's classes point at the clone's own sessions");
  console.log("ok  annual cloning maps sessions and all-sessions classes by site name and counts what lost its site");

  // 5. Cloning without locations must not merge the sites' sessions or crash on the same honor at two sites.
  const noLocations = await cloneOf(source.id, "nolocations", { honors: true });
  const flatSessions = await prisma.honorSession.findMany({ where: { eventId: noLocations.event.id } });
  assert(flatSessions.length === 3 && flatSessions.every((row) => row.locationId === null), "no sessions have a site without locations");
  assert(flatSessions.map((row) => row.name).sort().join() === "Sabbath Morning (Des Moines),Sabbath Morning (Kansas City),Sunday", `each site's session keeps its own row, named after its site, got ${flatSessions.map((row) => row.name).join()}`);
  const flatKnots = await prisma.honorOffering.count({ where: { eventId: noLocations.event.id, honorId: knots.id } });
  assert(flatKnots === 3, `the same honor at two sites is copied for each session, got ${flatKnots}`);
  const flatBirds = await prisma.honorOffering.count({ where: { eventId: noLocations.event.id, honorId: birds.id } });
  assert(flatBirds === 1 && noLocations.summary?.skipped.honorOfferingsDuplicate === 1, `the second all-sessions class that lost its site is skipped and counted, got ${flatBirds} and ${JSON.stringify(noLocations.summary?.skipped)}`);
  console.log("ok  cloning without locations keeps each site's sessions apart and skips a true duplicate instead of failing");

  // 6. A renamed session that meets a same-named one is numbered, not merged or failed.
  const collide = await createEvent("collide");
  const collideKc = await location(collide.id, "Kansas City", 0);
  await session(collide.id, "Sabbath Morning (Kansas City)", null, 0);
  await session(collide.id, "Sabbath Morning", collideKc.id, 1);
  await prisma.eventLocation.update({ where: { id: collideKc.id }, data: { isActive: false } });
  const collided = await cloneOf(collide.id, "collide-clone", { honors: true, locations: true });
  const collidedNames = (await prisma.honorSession.findMany({ where: { eventId: collided.event.id } })).map((row) => row.name).sort();
  assert(collidedNames.join() === "Sabbath Morning (Kansas City),Sabbath Morning (Kansas City) 2", `an inactive-site collision is numbered, got ${collidedNames.join()}`);
  console.log("ok  an inactive-site name collision is numbered instead of failing the clone");
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
