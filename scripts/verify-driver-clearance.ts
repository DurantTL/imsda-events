/**
 * Proves automatic driver clearance (#544) against a real PostgreSQL
 * database: with a synthetic background-check list uploaded and no staff
 * action, a willing driver with a current `y` and blank issues is cleared;
 * the staff queue lists only the exceptions (issues text exactly as
 * written); a club sees labels only, never the text; a person added after
 * the upload is matched at read time; a staff override is shown and audited;
 * and a newer upload re-derives everyone with no staff action. Uses
 * fictitious rows it creates and removes itself, on a fresh or scratch
 * database.
 *
 *   npm run test:driver-clearance
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { clubYearFor } from "../modules/club-rosters/domain";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "drvclr";
const staffUserId = `${P}_staff`;
const clubId = `${P}_club`;
const clubName = "Driver Clearance Check Pathfinders";
const now = new Date();
const clubYear = clubYearFor(now);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

/** MM/DD/YY, `days` from today (UTC calendar date is close enough for a 10 or 90 day offset). */
function issueDate(days: number) {
  const date = new Date(now.getTime() + days * 86_400_000);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(date.getUTCMonth() + 1)}/${two(date.getUTCDate())}/${two(date.getUTCFullYear() % 100)}`;
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorUserId: staffUserId } });
  await prisma.backgroundCheckMatch.deleteMany({ where: { person: { id: { startsWith: `${P}_` } } } });
  await prisma.backgroundCheckUpload.deleteMany({ where: { uploadedByUserId: staffUserId } });
  await prisma.driverVerification.deleteMany({ where: { personId: { startsWith: `${P}_` } } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: clubId } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.organization.deleteMany({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { id: staffUserId } });
}

async function addDriver(key: string, options: { willing?: boolean } = {}) {
  const id = `${P}_${key}`;
  await prisma.person.create({ data: { id, firstName: "Dana", lastName: `Drvclr${key}` } });
  await prisma.clubRosterMember.create({
    data: {
      id: `${id}_roster`, organizationId: clubId, clubYear, personId: id, attendeeType: "ADULT", role: "Counselor",
      status: "ACTIVE", source: "DIRECTOR", willingToDrive: options.willing ?? true,
    },
  });
  return id;
}

const listCsv = (rows: Array<[key: string, compliance: string, issues: string]>) => [
  "user_id,user_last,user_first,roles,sites,user_active,compliance,issues",
  ...rows.map(([key, compliance, issues], index) => `${9000 + index},Drvclr${key},Dana,Counselor,${clubName},y,${compliance},"${issues}"`),
].join("\n");

async function main() {
  const domain = await import("../modules/background-checks/domain");
  const checks = await import("../modules/background-checks/repository");
  const drivers = await import("../modules/driver-verification/repository");

  await cleanup();
  await prisma.user.create({ data: { id: staffUserId, email: `${P}-staff@example.test`, displayName: "Driver Clearance Check Staff", globalRole: "SYSTEM_ADMIN" } });
  await prisma.organization.create({ data: { id: clubId, type: "CLUB", name: clubName, normalizedName: clubName.toLowerCase() } });

  const soon = issueDate(10);
  const later = issueDate(90);
  const people = {
    cleared: await addDriver("cleared"),
    nonDriver: await addDriver("nondriver"),
    notCleared: await addDriver("notcleared"),
    bang: await addDriver("bang"),
    expiringSoon: await addDriver("soon"),
    expiringLater: await addDriver("later"),
    unknownText: await addDriver("unknown"),
    unlisted: await addDriver("unlisted"),
    notWilling: await addDriver("notwilling", { willing: false }),
  };
  const upload = async (rows: Array<[string, string, string]>) => {
    const parsed = domain.parseRosterBackgroundCsv(listCsv(rows)).map(domain.rosterRowToListRow);
    await checks.applyBackgroundCheckUpload(parsed, "ROSTER", staffUserId, now);
  };

  const written = `Training (${soon}),BGC`;
  await upload([
    ["cleared", "y", ""],
    ["nondriver", "y", "Non-Driver"],
    ["notcleared", "n", written],
    ["bang", "!", `Training (${later})`],
    ["soon", "y", `bgc (${soon})`],
    ["later", "y", `BGC (${later})`],
    ["unknown", "y", "Fingerprints pending"],
    ["notwilling", "n", "BGC"],
    // On the list before the person exists on any roster (step 3).
    ["late", "y", ""],
  ]);

  // 1. Read time, before any refresh: a cleared driver needs no staff action; the queue is the exceptions only.
  const exceptions = await drivers.listDriverExceptions(now);
  const byKey = new Map(exceptions.map((entry) => [entry.personId, entry]));
  assert(!byKey.has(people.cleared), "a willing driver with a current y and blank issues must not be in the staff queue");
  assert(!byKey.has(people.expiringLater), "a driver expiring after the 30-day window must not be in the staff queue");
  assert(!byKey.has(people.notWilling), "someone not willing to drive must not be in the queue");
  const status = (key: keyof typeof people) => byKey.get(people[key])?.clearance.status;
  assert(status("nonDriver") === "NOT_CLEARED", `Non-Driver beside y must be not cleared, got ${status("nonDriver")}`);
  assert(status("notCleared") === "NOT_CLEARED", `n must be not cleared, got ${status("notCleared")}`);
  assert(status("bang") === "NEEDS_REVIEW", `! must need review, got ${status("bang")}`);
  assert(status("expiringSoon") === "EXPIRING" && byKey.get(people.expiringSoon)!.clearance.warnStaff, "a y expiring within 30 days must be expiring with a staff warning");
  assert(status("unknownText") === "NEEDS_REVIEW", `a y with unrecognised text must need review, got ${status("unknownText")}`);
  assert(status("unlisted") === "NEEDS_REVIEW", `no match must need review, got ${status("unlisted")}`);
  assert(exceptions.length === 6, `expected exactly the 6 exceptions, got ${exceptions.length}`);
  assert(byKey.get(people.notCleared)!.issuesText === written, "staff must see the issues text exactly as written");

  // 2. A club sees labels only, never the text.
  const clubEntries = await drivers.clubDriverEntries(clubId, clubYear, now);
  assert(clubEntries.length === 8, `a club lists every willing driver, got ${clubEntries.length}`);
  const label = (key: keyof typeof people) => clubEntries.find((entry) => entry.rosterMemberId === `${people[key]}_roster`)?.label;
  assert(label("cleared") === "Cleared to drive", `cleared label: ${label("cleared")}`);
  assert(label("nonDriver") === "Not cleared", `not-cleared label: ${label("nonDriver")}`);
  assert(label("bang") === "Pending", `pending label: ${label("bang")}`);
  assert(/^Expiring \(\d\d\/\d\d\/\d{4}\)$/.test(label("expiringLater") ?? ""), `expiring label: ${label("expiringLater")}`);
  const clubJson = JSON.stringify(clubEntries);
  for (const leaked of ["Non-Driver", "Fingerprints", "BGC", "Training", "issues"]) assert(!clubJson.includes(leaked), `a club must never see "${leaked}"`);

  // 3. Someone added after the upload is matched at read time, with no refresh.
  const late = await addDriver("late");
  const lateLabel = (await drivers.clubDriverEntries(clubId, clubYear, now)).find((entry) => entry.rosterMemberId === `${late}_roster`)?.label;
  assert(lateLabel === "Cleared to drive", "a person added after the list must be cleared from the list");

  // 4. A staff override is shown, audited, and decides the club's label; the derived result stays visible to staff.
  await drivers.recordDriverClearance(people.notCleared, { clearedToTransport: true, note: "Confirmed by phone." }, { userId: staffUserId });
  const afterOverride = (await drivers.listDriverExceptions(now)).find((entry) => entry.personId === people.notCleared);
  assert(afterOverride?.override?.clearedToTransport === true && afterOverride.override.note === "Confirmed by phone.", "the override must be shown on the staff row");
  assert(afterOverride.clearance.status === "NOT_CLEARED", "the derived result must stay visible beside an override");
  const audit = await prisma.auditLog.findFirst({ where: { actorUserId: staffUserId, action: "DRIVER_VERIFICATION_REVIEWED", entityId: people.notCleared } });
  assert(audit, "an override must be audited");
  assert(!JSON.stringify(audit.metadata).includes("BGC"), "the audit entry must not carry the issues text");
  const overriddenLabel = (await drivers.clubDriverEntries(clubId, clubYear, now)).find((entry) => entry.rosterMemberId === `${people.notCleared}_roster`)?.label;
  assert(overriddenLabel === "Cleared to drive", "an override decides the club's label");

  // 5. A newer list re-derives with no staff action: the Non-Driver note is removed and that driver leaves the queue.
  await upload([
    ["cleared", "y", ""],
    ["nondriver", "y", ""],
    ["notcleared", "n", written],
    ["bang", "!", `Training (${later})`],
    ["soon", "y", `bgc (${soon})`],
    ["later", "y", `BGC (${later})`],
    ["unknown", "y", "Fingerprints pending"],
    ["notwilling", "n", "BGC"],
    ["late", "y", ""],
  ]);
  const refreshed = await drivers.listDriverExceptions(now);
  assert(!refreshed.some((entry) => entry.personId === people.nonDriver), "a newer upload must clear a driver with no staff action");
  assert(refreshed.length === 5, `expected 5 exceptions after the newer upload, got ${refreshed.length}`);

  // 6. The override made before that upload is stale now: the list decides again, for staff and for the club.
  const staleRow = refreshed.find((entry) => entry.personId === people.notCleared);
  assert(staleRow && staleRow.override === null && staleRow.clearance.status === "NOT_CLEARED", "an override older than the newest list must be ignored");
  const staleLabel = (await drivers.clubDriverEntries(clubId, clubYear, now)).find((entry) => entry.rosterMemberId === `${people.notCleared}_roster`)?.label;
  assert(staleLabel === "Not cleared", `a stale override must not clear the driver for the club, got ${staleLabel}`);

  console.log("Driver clearance verified against PostgreSQL.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error("Cleanup failed:", error));
    await prisma.$disconnect();
  });
