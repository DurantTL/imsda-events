/**
 * Proves the #527 background-check list migration and matching against a
 * real PostgreSQL database — the things an in-memory fake can't show: the
 * migration's SQL, the remembered `user_id` key format, name normalization,
 * the advisory lock, and read-time matching.
 *
 *   npm run test:background-check-list
 *
 * Uses a scratch database it creates next to `DATABASE_URL`'s and drops
 * afterward, with fictitious rows only:
 *
 *  1. Deploys the migrations up to 20260928200000 (before #527).
 *  2. Inserts synthetic Person, BackgroundCheck and ExternalIdentity rows —
 *     accented and hyphenated names, a couple sharing one email, and two
 *     people with the same name.
 *  3. Records each roster adult's compliance state under the old table.
 *  4. Applies the #527 migration; every state is identical.
 *  5. Refreshes each person; every state is still identical.
 *  6. Uploads a roster file with the same user_ids; they count as "changed"
 *     and still match (by the remembered id). Racing confirms of one preview
 *     leave exactly one upload.
 *  7. Registers a new adult on the list through the registration write path;
 *     they are checked at read time, and a write path's own refresh fills
 *     the cache (AUTO). While an upload holds the list, a save isn't delayed.
 *  8. An entry two people in two clubs could be is matched to neither — at
 *     read time, and after staff dismiss its review.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { clubComplianceState, matchableName, parseRosterBackgroundCsv, parseSterlingCsv, rosterRowToListRow, sterlingRowToListRow } from "../modules/background-checks/domain";
import { clubYearFor } from "../modules/club-rosters/domain";
import { calendarDateInEventTimeZone } from "../modules/events/lifecycle";

loadEnvConfig(process.cwd());

const BEFORE_527 = "20260928200000";
const MIGRATION_527 = "20260928240000_background_check_list";
const P = "bgverify";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

/** Stable JSON: object keys sorted, so only values are compared. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => (
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner
  ));
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  const a = canonical(actual);
  const e = canonical(expected);
  if (a !== e) throw new Error(`FAILED: ${message}\n  expected ${e}\n  received ${a}`);
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL must point at a PostgreSQL server this script can create a scratch database on.");
const scratchName = `imsda_bgverify_${process.pid}`;
const scratchUrl = (() => {
  const url = new URL(baseUrl);
  url.pathname = `/${scratchName}`;
  return url.toString();
})();
const workDir = path.join(process.cwd(), "node_modules", ".cache", `bgverify-${process.pid}`);
const migrationsDir = path.join(process.cwd(), "prisma", "migrations");

const admin = new PrismaClient({ datasourceUrl: baseUrl });
const db = new PrismaClient({ datasourceUrl: scratchUrl });
/** The app's own client (`getPrisma()`), once the app modules are loaded against the scratch database. */
let appClient: { $disconnect(): Promise<void> } | null = null;

/** A private copy of the migration history, so the scratch database can stop before #527. */
function prepareWorkDir() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(path.join(workDir, "migrations"), { recursive: true });
  cpSync(path.join(migrationsDir, "migration_lock.toml"), path.join(workDir, "migrations", "migration_lock.toml"));
  cpSync(path.join(process.cwd(), "prisma", "schema.prisma"), path.join(workDir, "schema.prisma"));
  for (const name of readdirSync(migrationsDir)) {
    if (/^\d{14}_/.test(name) && name.slice(0, 14) <= BEFORE_527) {
      cpSync(path.join(migrationsDir, name), path.join(workDir, "migrations", name), { recursive: true });
    }
  }
  writeFileSync(path.join(workDir, "prisma.config.ts"), [
    'import { defineConfig } from "prisma/config";',
    `export default defineConfig({ schema: ${JSON.stringify(path.join(workDir, "schema.prisma"))}, migrations: { path: ${JSON.stringify(path.join(workDir, "migrations"))} } });`,
    "",
  ].join("\n"));
}

function deployWorkDirMigrations() {
  execFileSync("npx", ["prisma", "migrate", "deploy", "--config", path.join(workDir, "prisma.config.ts")], {
    env: { ...process.env, DATABASE_URL: scratchUrl },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

type Person = {
  key: string;
  firstName: string;
  lastName: string;
  email?: string;
  /** The old table's row, if any. */
  check?: { checkedOn?: string; expiresOn?: string; complianceStatus?: "CLEAR" | "FLAGGED" | "NOT_COMPLIANT"; issuesNote?: string };
  /** A roster user_id remembered before #527 (raw, as the old import stored it). */
  userId?: string;
};

const people: Person[] = [
  { key: "jose", firstName: "José", lastName: "Núñez", check: { complianceStatus: "CLEAR" }, userId: "70001" },
  { key: "maryann", firstName: "Mary-Ann", lastName: "Smith  -  Jones", check: { checkedOn: "2025-06-01", expiresOn: "2029-06-01" } },
  { key: "ana", firstName: "Ana", lastName: "Rivera", email: `family.${P}@example.test`, check: { checkedOn: "2025-01-01", expiresOn: "2028-01-01" } },
  // Shares Ana's household email; only one Person can hold it.
  { key: "luis", firstName: "Luis", lastName: "Rivera", check: { checkedOn: "2025-01-01", expiresOn: "2020-01-01" } },
  { key: "sam", firstName: "Sam", lastName: "O'Neil", check: { complianceStatus: "NOT_COMPLIANT", issuesNote: "Training missing" }, userId: "70005" },
  { key: "kim1", firstName: "Kim", lastName: "Cho", check: { complianceStatus: "FLAGGED", issuesNote: "Expires 2026-11-01" }, userId: "70007" },
  // Same name as kim1, no check on file: must stay No record, and must not disturb kim1.
  { key: "kim2", firstName: "Kim", lastName: "Cho" },
  { key: "pat", firstName: "Pat", lastName: "Doe" },
];

const ids = {
  user: `${P}_admin`,
  church: `${P}_church`,
  club: `${P}_club`,
  event: `${P}_event`,
  person: (key: string) => `${P}_person_${key}`,
  member: (key: string) => `${P}_member_${key}`,
};

async function seedBefore527(clubYear: string) {
  await db.user.create({ data: { id: ids.user, email: `${P}.admin@example.test`, displayName: "Verify Admin", globalRole: "SYSTEM_ADMIN" } });
  await db.organization.create({ data: { id: ids.church, type: "CHURCH", name: "Verify Church", normalizedName: "verify church" } });
  await db.organization.create({ data: { id: ids.club, type: "CLUB", name: "Verify Pathfinders", normalizedName: "verify pathfinders", parentOrganizationId: ids.church } });
  for (const person of people) {
    await db.person.create({ data: { id: ids.person(person.key), firstName: person.firstName, lastName: person.lastName, normalizedEmail: person.email ?? null } });
    await db.clubRosterMember.create({
      data: { id: ids.member(person.key), organizationId: ids.club, clubYear, personId: ids.person(person.key), attendeeType: "ADULT", source: "DIRECTOR" },
    });
    if (person.check) {
      await db.$executeRaw`
        INSERT INTO "BackgroundCheck" ("id", "personId", "provider", "checkedOn", "expiresOn", "complianceStatus", "issuesNote", "createdAt", "updatedAt")
        VALUES (${`${P}_bc_${person.key}`}, ${ids.person(person.key)}, ${person.check.complianceStatus ? "ROSTER_IMPORT" : "STERLING"},
          ${person.check.checkedOn ?? null}, ${person.check.expiresOn ?? null},
          ${person.check.complianceStatus ?? null}::"BackgroundCheckComplianceStatus", ${person.check.issuesNote ?? null}, NOW(), NOW())
      `;
    }
    if (person.userId) {
      await db.externalIdentity.create({ data: { provider: "ROSTER_IMPORT", providerScope: "", externalId: person.userId, personId: ids.person(person.key), lastVerifiedAt: new Date() } });
    }
  }
}

function statesBefore527(today: string) {
  return Object.fromEntries(people.map((person) => [ids.member(person.key), {
    state: clubComplianceState(person.check ? { expiresOn: person.check.expiresOn ?? null, complianceStatus: person.check.complianceStatus ?? null } : null, today),
    note: person.check?.issuesNote ?? null,
  }]));
}

async function main() {
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
  prepareWorkDir();

  // 1. Migrations up to the one before #527.
  deployWorkDirMigrations();
  const beforeTables = await db.$queryRaw<Array<{ exists: boolean }>>`SELECT to_regclass('public."BackgroundCheck"') IS NOT NULL AS exists`;
  assert(beforeTables[0]?.exists, "the pre-#527 BackgroundCheck table exists");
  console.log(`ok  deployed migrations through ${BEFORE_527}`);

  // 2-3. Synthetic rows, and everyone's state under the old table.
  const now = new Date();
  const clubYear = clubYearFor(now);
  const today = calendarDateInEventTimeZone(now, "America/Chicago");
  await seedBefore527(clubYear);
  const expected = statesBefore527(today);
  console.log(`ok  seeded ${people.length} people, ${people.filter((person) => person.check).length} checks, ${people.filter((person) => person.userId).length} remembered user_ids`);

  // 4. The #527 migration.
  cpSync(path.join(migrationsDir, MIGRATION_527), path.join(workDir, "migrations", MIGRATION_527), { recursive: true });
  deployWorkDirMigrations();
  process.env.DATABASE_URL = scratchUrl;
  process.env.SECRET_ENCRYPTION_KEY ??= "bgverify-synthetic-secret-encryption-key-0000";
  const repository = await import("../modules/background-checks/repository");
  const { createRegistration, updateRegistrationAttendeeEmail } = await import("../modules/registrations/repository");
  const { getPrisma } = await import("../lib/prisma");
  appClient = getPrisma();

  const statuses = async () => (await repository.clubRosterComplianceStatuses(ids.club, clubYear, { includeNotes: true })).statuses;
  assertEqual(await statuses(), expected, "every roster adult's state is unchanged by the migration");
  const identities = await db.externalIdentity.findMany({ where: { provider: "ROSTER_IMPORT", personId: { startsWith: `${P}_` } }, orderBy: { externalId: "asc" }, select: { externalId: true } });
  assertEqual(identities.map((identity) => identity.externalId), ["userId:70001", "userId:70005", "userId:70007"], "remembered user_ids are rewritten to the list's key format");
  const migrated = await db.backgroundCheckEntry.findMany({ orderBy: { id: "asc" }, select: { identityKey: true, sourceUserId: true, normalizedName: true, match: { select: { matchedBy: true } } } });
  assert(migrated.length === people.filter((person) => person.check).length, "one migrated entry per old row");
  assert(migrated.every((entry) => entry.normalizedName === null), "the migration never normalizes a name in SQL");
  assert(migrated.every((entry) => entry.match?.matchedBy === "MIGRATED"), "every migrated entry keeps a MIGRATED match");
  assertEqual(migrated.filter((entry) => entry.sourceUserId).map((entry) => entry.identityKey).sort(), ["userId:70001", "userId:70005", "userId:70007"], "migrated entries are keyed the same way an upload keys them");
  const renamed = await db.$queryRaw<Array<{ old: boolean; kept: boolean }>>`SELECT to_regclass('public."BackgroundCheck"') IS NOT NULL AS old, to_regclass('public."BackgroundCheck_pre527"') IS NOT NULL AS kept`;
  assert(!renamed[0]?.old && renamed[0]?.kept, "the old table is renamed to BackgroundCheck_pre527, not dropped");
  console.log("ok  migration keeps every state, rewrites user_ids, and leaves names for TypeScript");

  // 5. A refresh for each person changes nothing — never deletes a match it can't recreate.
  for (const person of people) await repository.refreshBackgroundCheckMatchForPerson(ids.person(person.key));
  assertEqual(await statuses(), expected, "every state is unchanged after refreshing each person");
  assert((await db.backgroundCheckMatch.count({ where: { matchedBy: "MIGRATED" } })) === migrated.length, "no MIGRATED match was deleted by a refresh");
  const names = await db.backgroundCheckEntry.findMany({ select: { firstName: true, lastName: true, normalizedName: true } });
  for (const entry of names) {
    assertEqual(entry.normalizedName, matchableName(`${entry.firstName} ${entry.lastName}`), `normalizedName is filled in by matchableName for ${entry.firstName}`);
  }
  assert(names.some((entry) => entry.normalizedName === "jose nunez"), "an accented name normalizes the TypeScript way");
  assert(names.some((entry) => entry.normalizedName === "maryann smith jones"), "a hyphenated, double-spaced name normalizes the TypeScript way");
  console.log("ok  refreshes keep every state and fill normalizedName in TypeScript");

  // The name-group lookup uses the expression index, not a scan of every person.
  const migrationSql = readFileSync(path.join(migrationsDir, MIGRATION_527, "migration.sql"), "utf8");
  assert(migrationSql.includes(`ON "Person" ((${repository.PERSON_COMPACT_NAME_SQL}))`), "the lookup's name expression is exactly the index's");
  await db.$executeRawUnsafe(`INSERT INTO "Person" ("id", "firstName", "lastName", "updatedAt") SELECT '${P}_bulk_' || g, 'Bulk' || g, 'Person' || (g % 997), NOW() FROM generate_series(1, 20000) g`);
  await db.$executeRawUnsafe(`ANALYZE "Person"`);
  const plan = await db.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
    `EXPLAIN (FORMAT JSON) SELECT "id" FROM "Person" WHERE ${repository.PERSON_COMPACT_NAME_SQL} = ANY($1::text[])`,
    ["josenunez"],
  );
  const planText = JSON.stringify(plan);
  assert(planText.includes("Person_matchable_compact_idx") && !planText.includes('"Seq Scan"'), `the name-group lookup is an index scan at 20,000 people, got ${planText}`);
  await db.person.deleteMany({ where: { id: { startsWith: `${P}_bulk_` } } });
  console.log("ok  the name-group lookup is an index scan on Person_matchable_compact_idx");

  // 6. A roster upload with the same user_ids: "changed", and still matched.
  const rosterCsv = [
    "user_id,user_last,user_first,roles,sites,user_active,compliance,issues",
    "70001,Núñez,José,Adult,Verify Pathfinders,y,y,",
    "70005,O'Neil,Sam,Adult,Verify Pathfinders,y,n,Training missing",
    "70007,Cho,Kim,Adult,Verify Pathfinders,y,!,Expires 2026-11-01",
  ].join("\n");
  const rosterRows = parseRosterBackgroundCsv(rosterCsv).map(rosterRowToListRow);
  const preview = await repository.planBackgroundCheckUpload(rosterRows);
  assertEqual({ added: preview.added, changed: preview.changed }, { added: 0, changed: 3 }, "the same user_ids count as changed, not added");
  // Racing confirms of one preview: exactly one wins; the other is told the preview changed.
  const race = await Promise.allSettled([
    repository.applyBackgroundCheckUpload(rosterRows, "ROSTER", ids.user, new Date(), { expectedFingerprint: preview.fingerprint }),
    repository.applyBackgroundCheckUpload(rosterRows, "ROSTER", ids.user, new Date(), { expectedFingerprint: preview.fingerprint }),
  ]);
  const won = race.filter((result) => result.status === "fulfilled");
  const lost = race.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert(won.length === 1 && lost.length === 1, `exactly one racing confirm wins (got ${won.length} won, ${lost.length} lost)`);
  assert((lost[0]!.reason as { code?: string }).code === "PREVIEW_CHANGED", `the losing confirm is PREVIEW_CHANGED, got ${String(lost[0]!.reason)}`);
  assertEqual((won[0] as PromiseFulfilledResult<{ changed: number }>).value.changed, 3, "the winning confirm's counts were computed inside its transaction");
  assert((await db.backgroundCheckUpload.count({ where: { format: "ROSTER" } })) === 1, "only one roster upload was recorded");
  const rosterKeys = new Set(["jose", "sam", "kim1"]);
  const afterRoster = await statuses();
  for (const person of people.filter((candidate) => rosterKeys.has(candidate.key))) {
    assertEqual(afterRoster[ids.member(person.key)], expected[ids.member(person.key)], `${person.key}'s state is unchanged by the roster upload`);
  }
  const rosterMatches = await db.backgroundCheckMatch.findMany({ where: { personId: { in: [...rosterKeys].map(ids.person) } }, select: { matchedBy: true } });
  assert(rosterMatches.length === 3 && rosterMatches.every((match) => match.matchedBy === "IDENTITY"), "each remembered user_id matches by identity");
  assert(afterRoster[ids.member("kim2")]?.state === "NO_RECORD", "the other Kim Cho is not guessed into a match");
  console.log("ok  a roster upload with the same user_ids counts them as changed and still matches them; racing confirms leave one upload");

  // 7. A new adult registered after the upload, through the registration write path.
  const sterlingCsv = [
    "First name,Last name,Email,Expiration date,Status",
    `Zoë,O'Brien-Hale,zoe.${P}@example.test,2029-12-31,Clear`,
    `Ana,Rivera,family.${P}@example.test,2029-12-31,Clear`,
    `Luis,Rivera,family.${P}@example.test,2029-12-31,Clear`,
  ].join("\n");
  const sterlingRows = parseSterlingCsv(sterlingCsv).map(sterlingRowToListRow);
  const sterlingPreview = await repository.planBackgroundCheckUpload(sterlingRows);
  await repository.applyBackgroundCheckUpload(sterlingRows, "STERLING", ids.user, new Date(), { expectedFingerprint: sterlingPreview.fingerprint });
  assert((await db.backgroundCheckEntry.count()) === 3, "a couple sharing one email are two entries, neither dropped");
  const eventStart = new Date(now.getTime() + 30 * 86_400_000);
  await db.event.create({
    data: {
      id: ids.event, slug: `${P}-event`, name: "Background check list verification", startsAt: eventStart,
      endsAt: new Date(eventStart.getTime() + 2 * 86_400_000), isPublished: true, checksAdultBackgrounds: true,
    },
  });
  // The staff form's attendee types (ATTENDEE, WORKER, CHILD) never say
  // "adult" on their own, and it records no age: the registrant's age comes
  // from a form answer, which is set here the way a registration form would.
  const registration = await createRegistration(ids.event, {
    firstName: "Zoe", lastName: "O'Brien-Hale", email: `zoe.${P}@example.test`, phone: "", attendeeType: "WORKER", status: "SUBMITTED", totalAmountCents: 0,
  }, ids.user);
  assert(registration, "the registration was created");
  const zoe = await db.registrationAttendee.findFirstOrThrow({ where: { registrationId: registration.id }, select: { id: true, personId: true } });
  await db.registrationAttendee.update({ where: { id: zoe.id }, data: { profileSnapshot: { firstName: "Zoe", lastName: "O'Brien-Hale", email: `zoe.${P}@example.test`, ageOnEventDate: 41 } } });
  assert(!(await db.backgroundCheckMatch.findUnique({ where: { personId: zoe.personId } })), "no cached match yet (so the next check is read-time only)");
  let flags = await repository.listEventBackgroundFlags(ids.event);
  assert(flags?.adults === 1, "the new registrant counts as an adult");
  assert(!flags.people.some((flag) => flag.attendeeId === zoe.id), "the new adult on the list is checked at read time, with no re-upload");
  // A write path (the staff attendee-email edit) fills the cache by itself.
  await updateRegistrationAttendeeEmail(ids.event, registration.id, zoe.id, `zoe.${P}@example.test`, ids.user);
  assert((await db.backgroundCheckMatch.findUnique({ where: { personId: zoe.personId } }))?.matchedBy === "AUTO", "the write path's refresh fills the cache (AUTO)");
  flags = await repository.listEventBackgroundFlags(ids.event);
  assert(flags?.people.length === 0, "still checked once the cache is filled");
  console.log("ok  a new adult registered after the upload is checked at read time, then from the cache the write path filled");

  // 7b. An upload holding the list never holds up a user's save: the refresh is skipped, not waited on.
  let releaseLock!: () => void;
  let lockTaken!: () => void;
  const taken = new Promise<void>((resolve) => { lockTaken = resolve; });
  const holder = db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${repository.BACKGROUND_CHECK_LOCK_KEY}::bigint)`;
    lockTaken();
    await new Promise<void>((resolve) => { releaseLock = resolve; });
  }, { timeout: 60_000, maxWait: 10_000 });
  await taken;
  try {
    const started = Date.now();
    const held = await createRegistration(ids.event, {
      firstName: "Held", lastName: "Lock", email: `held.${P}@example.test`, phone: "", attendeeType: "WORKER", status: "SUBMITTED", totalAmountCents: 0,
    }, ids.user);
    const elapsed = Date.now() - started;
    assert(held, "the save went through while an upload held the list");
    assert(elapsed < 5_000, `the save wasn't held up behind the upload (took ${elapsed}ms)`);
    const reviewAttempt = await repository.undoManualBackgroundCheckMatch("none", ids.user).then(() => null, (error: unknown) => error);
    assert((reviewAttempt as { code?: string } | null)?.code === "UPLOAD_IN_PROGRESS", "a staff decision during an upload is refused, not held up");
  } finally {
    releaseLock();
    await holder;
  }
  console.log("ok  a save during an upload isn't delayed; the refresh is skipped and staff decisions are refused with a clear error");

  // 8. One entry, two people with that name in two clubs of one church.
  const churchTwoClub = `${P}_club_two`;
  await db.organization.create({ data: { id: churchTwoClub, type: "CLUB", name: "Verify Adventurers", normalizedName: "verify adventurers", parentOrganizationId: ids.church } });
  const dana = [
    { key: "dana1", club: ids.club },
    { key: "dana2", club: churchTwoClub },
  ];
  const danaCsv = "user_id,user_last,user_first,sites,compliance\n80001,Lee,Dana,Verify Church,y";
  const danaRows = parseRosterBackgroundCsv(danaCsv).map(rosterRowToListRow);
  // a. Added after the upload with no refresh: each club page alone sees one
  //    Dana, but another exists, so neither is matched at read time.
  const danaPreview = await repository.planBackgroundCheckUpload(danaRows);
  await repository.applyBackgroundCheckUpload(danaRows, "ROSTER", ids.user, new Date(), { expectedFingerprint: danaPreview.fingerprint });
  for (const person of dana) {
    await db.person.create({ data: { id: ids.person(person.key), firstName: "Dana", lastName: "Lee" } });
    await db.clubRosterMember.create({ data: { id: ids.member(person.key), organizationId: person.club, clubYear, personId: ids.person(person.key), attendeeType: "ADULT", source: "DIRECTOR" } });
  }
  const danaStates = async () => [
    (await repository.clubRosterComplianceStatuses(ids.club, clubYear, { includeNotes: false })).statuses[ids.member("dana1")]?.state,
    (await repository.clubRosterComplianceStatuses(churchTwoClub, clubYear, { includeNotes: false })).statuses[ids.member("dana2")]?.state,
  ];
  assertEqual(await danaStates(), ["NO_RECORD", "NO_RECORD"], "an entry two people could be is matched to neither at read time");
  // b. The full pass sends it to review; staff dismiss it; still neither.
  const danaPreview2 = await repository.planBackgroundCheckUpload(danaRows);
  await repository.applyBackgroundCheckUpload(danaRows, "ROSTER", ids.user, new Date(), { expectedFingerprint: danaPreview2.fingerprint });
  const [danaReview] = await repository.listBackgroundCheckReviews();
  assert(danaReview && danaReview.candidates.length === 2, "the full pass sends the ambiguous entry to review");
  await repository.resolveBackgroundCheckReview(danaReview.id, { type: "dismiss" }, ids.user);
  assertEqual(await danaStates(), ["NO_RECORD", "NO_RECORD"], "a dismissed entry is matched to no one at read time");
  for (const person of dana) await repository.refreshBackgroundCheckMatchForPerson(ids.person(person.key));
  assertEqual(await danaStates(), ["NO_RECORD", "NO_RECORD"], "a dismissed entry is matched to no one by a refresh");
  assert((await db.backgroundCheckReview.count()) === 1, "the dismissal is kept, and no second review is created");
  assert((await repository.listBackgroundCheckReviews()).length === 0, "a dismissed review is off the staff review list");
  console.log("ok  one entry two people could be is never matched to either, before or after staff dismiss it");
}

main()
  .then(() => console.log("background-check list verification passed"))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await appClient?.$disconnect();
    await db.$disconnect();
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    } finally {
      await admin.$disconnect();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
