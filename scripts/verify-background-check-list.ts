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
 *  9. (#572) Site matching against the real export's shapes: a location
 *     suffix, several sites in one cell, ALL-CAPS, and a school that must not
 *     match a church; an adult on the previous club year's roster is matched;
 *     stored entries re-match through a refresh with no new upload.
 * 10. (#572) Nevada (IA) never auto-matches a Nevada (MO) row.
 * 11. (#598) A unique name matches by name only although the site differs
 *     (NAME_ONLY, the additive enum migration); a first-name variant and two
 *     same-name candidates go to review; a roster member 18 or older is a
 *     candidate whatever the roster type; "not the same person" holds through
 *     a Refresh and a new upload, and a hand match clears it; Refresh, reject
 *     and per-person refresh exclude each other on the list lock; the lookup
 *     explains non-matches and shows no birth dates.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { clubComplianceState, matchableName, parseRosterBackgroundCsv, parseSterlingCsv, rosterRowToListRow, sterlingRowToListRow } from "../modules/background-checks/domain";
import { describeIssues } from "../modules/background-checks/issues";
import { clubYearChoices, clubYearFor } from "../modules/club-rosters/domain";
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
  // Before the later migrations are deployed, select only the id: the default
  // RETURNING lists every column of the current client, including ones these
  // older migrations have not added yet (#649).
  await db.organization.create({ data: { id: ids.church, type: "CHURCH", name: "Verify Church", normalizedName: "verify church" }, select: { id: true } });
  await db.organization.create({ data: { id: ids.club, type: "CLUB", name: "Verify Pathfinders", normalizedName: "verify pathfinders", parentOrganizationId: ids.church }, select: { id: true } });
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
    reasons: describeIssues(person.check?.issuesNote, today),
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
  // Then every later migration too, so the app code below (generated from the current schema) finds every column it selects.
  for (const name of readdirSync(migrationsDir).filter((entry) => entry > MIGRATION_527 && !existsSync(path.join(workDir, "migrations", entry)))) {
    cpSync(path.join(migrationsDir, name), path.join(workDir, "migrations", name), { recursive: true });
  }
  deployWorkDirMigrations();
  process.env.DATABASE_URL = scratchUrl;
  process.env.SECRET_ENCRYPTION_KEY ??= "bgverify-synthetic-secret-encryption-key-0000";
  const repository = await import("../modules/background-checks/repository");
  const { createRegistration, updateRegistrationAttendeeEmail } = await import("../modules/registrations/repository");
  const { getPrisma } = await import("../lib/prisma");
  appClient = getPrisma();

  const statuses = async () => (await repository.clubRosterComplianceStatuses(ids.club, clubYear, { includeNotes: true })).statuses;
  assertEqual(await statuses(), expected, "every roster adult's state is unchanged by the migration");
  // The issues text and its readable reasons are for system administrators only (#427, #544).
  const withoutNotes = (await repository.clubRosterComplianceStatuses(ids.club, clubYear, { includeNotes: false })).statuses;
  assert(Object.values(withoutNotes).every((status) => status.note === null && status.reasons.length === 0), "without includeNotes there is no issues text and no reasons");
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
  // 9. #572: the export's site shapes, and the previous club year's roster.
  const previousYear = clubYearChoices(now)[0]!;
  const siteCases = [
    { key: "robin", first: "Robin", last: "Vale", userId: "81001", sites: "VERIFY CHURCH (Springfield),Lakeside Adventist School", year: previousYear, matches: true },
    { key: "wren", first: "Wren", last: "Moss", userId: "81002", sites: "Verify Church (Springfield)", year: clubYear, matches: true },
    // A school never matches a church by site (#572). A second Tara Finch (on no roster) is on file, so the site is the only
    // difference: the row is never AUTO-matched by school-vs-church, and never guessed by name alone (#598); it goes to review.
    { key: "tara", first: "Tara", last: "Finch", userId: "81003", sites: "Verify Adventist School", year: clubYear, matches: false },
  ];
  await db.person.create({ data: { id: ids.person("tara-twin"), firstName: "Tara", lastName: "Finch" } });
  for (const item of siteCases) {
    await db.person.create({ data: { id: ids.person(item.key), firstName: item.first, lastName: item.last } });
    await db.clubRosterMember.create({ data: { id: ids.member(item.key), organizationId: ids.club, clubYear: item.year, personId: ids.person(item.key), attendeeType: "ADULT", source: "DIRECTOR" } });
  }
  const siteCsv = ["user_id,user_last,user_first,sites,compliance", ...siteCases.map((item) => `${item.userId},${item.last},${item.first},"${item.sites}",y`)].join("\n");
  const siteRows = parseRosterBackgroundCsv(siteCsv).map(rosterRowToListRow);
  const sitePreview = await repository.planBackgroundCheckUpload(siteRows);
  await repository.applyBackgroundCheckUpload(siteRows, "ROSTER", ids.user, new Date(), { expectedFingerprint: sitePreview.fingerprint });
  for (const item of siteCases) {
    const matched = await db.backgroundCheckMatch.findUnique({ where: { personId: ids.person(item.key) } });
    assert(Boolean(matched) === item.matches, `${item.key} ${item.matches ? "matches" : "does not match"} by site`);
    if (matched) assert(matched.matchedBy === "AUTO", `${item.key} matched by name and site`);
  }
  // Stored entries re-match under the rule with no new upload: drop the matches, then refresh.
  await db.backgroundCheckMatch.deleteMany({ where: { personId: { in: siteCases.map((item) => ids.person(item.key)) } } });
  for (const item of siteCases) await repository.refreshBackgroundCheckMatchForPerson(ids.person(item.key));
  for (const item of siteCases) {
    const again = await db.backgroundCheckMatch.findUnique({ where: { personId: ids.person(item.key) } });
    assert(Boolean(again) === item.matches, `${item.key} re-matches through a refresh, with no new upload`);
    // The first upload remembered the user_id, so the re-match is by that identity (never name-only).
    if (again) assert(again.matchedBy === "IDENTITY", `${item.key} re-matches by its remembered user_id`);
  }
  assert((await repository.listBackgroundCheckReviews()).some((review) => review.name === "Tara Finch"), "the school-vs-church row with a same-name twin goes to review");
  console.log("ok  site suffixes, multi-site cells, ALL-CAPS, and the previous club year match; a school does not match a church");
  // 10. #572 review: Nevada (IA) and Nevada (MO) are different churches. Two
  // people share a name; only one is on the IA roster, and the row lists the MO church.
  const iaChurch = `${P}_church_ia`;
  const iaClub = `${P}_club_ia`;
  await db.organization.create({ data: { id: iaChurch, type: "CHURCH", name: "Nevada (IA) SDA Church", normalizedName: "nevada ia sda church" } });
  await db.organization.create({ data: { id: iaClub, type: "CLUB", name: "Nevada (IA) Pathfinders", normalizedName: "nevada ia pathfinders", parentOrganizationId: iaChurch } });
  await db.person.create({ data: { id: ids.person("nell-ia"), firstName: "Nell", lastName: "Hart" } });
  await db.clubRosterMember.create({ data: { id: ids.member("nell-ia"), organizationId: iaClub, clubYear, personId: ids.person("nell-ia"), attendeeType: "ADULT", source: "DIRECTOR" } });
  await db.person.create({ data: { id: ids.person("nell-mo"), firstName: "Nell", lastName: "Hart" } });
  await db.person.create({ data: { id: ids.person("otto-ia"), firstName: "Otto", lastName: "Hart" } });
  await db.clubRosterMember.create({ data: { id: ids.member("otto-ia"), organizationId: iaClub, clubYear, personId: ids.person("otto-ia"), attendeeType: "ADULT", source: "DIRECTOR" } });
  const nevadaCsv = [
    "user_id,user_last,user_first,sites,compliance",
    '82001,Hart,Nell,"Nevada (MO) SDA Church (Nevada)",y',
    '82002,Hart,Otto,"Nevada (IA) SDA Church (Nevada)",y',
  ].join("\n");
  const nevadaRows = parseRosterBackgroundCsv(nevadaCsv).map(rosterRowToListRow);
  const nevadaPreview = await repository.planBackgroundCheckUpload(nevadaRows);
  await repository.applyBackgroundCheckUpload(nevadaRows, "ROSTER", ids.user, new Date(), { expectedFingerprint: nevadaPreview.fingerprint });
  assert(!(await db.backgroundCheckMatch.findUnique({ where: { personId: ids.person("nell-ia") } })), "the IA person is not auto-matched to the MO row");
  assert(!(await db.backgroundCheckMatch.findUnique({ where: { personId: ids.person("nell-mo") } })), "the MO person, on no roster, is not guessed either");
  assert((await db.backgroundCheckMatch.findUnique({ where: { personId: ids.person("otto-ia") } }))?.matchedBy === "AUTO", "an IA row still matches the IA roster through its city suffix");
  console.log("ok  Nevada (IA) never auto-matches a Nevada (MO) row");

  // 11. #598: name-only matches, first-name variant reviews, adults by age,
  // the staff Refresh, "not the same person", and the lookup.
  const { sealBirthDate } = await import("../modules/club-rosters/birth-dates");
  const rosterPerson = async (key: string, first: string, last: string, options: { type?: "ADULT" | "STAFF" | "YOUTH" | "UNDERAGE"; birthDate?: string } = {}) => {
    await db.person.create({ data: { id: ids.person(key), firstName: first, lastName: last } });
    await db.clubRosterMember.create({
      data: {
        id: ids.member(key), organizationId: ids.club, clubYear, personId: ids.person(key), attendeeType: options.type ?? "ADULT", source: "DIRECTOR",
        sealedBirthDate: options.birthDate ? sealBirthDate(options.birthDate) : null,
      },
    });
  };
  await rosterPerson("ines", "Ines", "Varga");
  await rosterPerson("jonathan", "Jonathan", "Quill");
  await rosterPerson("bea", "Bea", "Lindqvist", { type: "YOUTH", birthDate: "1988-05-06" });
  await rosterPerson("cy", "Cy", "Lindqvist", { type: "YOUTH", birthDate: `${new Date().getUTCFullYear() - 12}-05-06` });
  await rosterPerson("dot", "Dot", "Marsh");
  await rosterPerson("dot-2", "Dot", "Marsh");
  const otherSite = "Faraway Hills SDA Church (Elsewhere)";
  const nameOnlyCsv = [
    "user_id,user_last,user_first,sites,compliance",
    `83001,Varga,Ines,"${otherSite}",y`, // name-only
    `83002,Quill,Jon,"${otherSite}",y`, // first-name variant: review
    `83003,Lindqvist,Bea,"${otherSite}",y`, // roster type is YOUTH, but she is 18 or older
    `83004,Lindqvist,Cy,"${otherSite}",y`, // a child: never a candidate
    `83005,Marsh,Dot,"${otherSite}",y`, // two candidates, nothing to separate them
  ].join("\n");
  const nameOnlyRows = parseRosterBackgroundCsv(nameOnlyCsv).map(rosterRowToListRow);
  const nameOnlyPreview = await repository.planBackgroundCheckUpload(nameOnlyRows);
  await repository.applyBackgroundCheckUpload(nameOnlyRows, "ROSTER", ids.user, new Date(), { expectedFingerprint: nameOnlyPreview.fingerprint });
  const matchOf = async (key: string) => db.backgroundCheckMatch.findUnique({ where: { personId: ids.person(key) } });
  assert((await matchOf("ines"))?.matchedBy === "NAME_ONLY", "a unique name matches by name only although the site differs");
  assert((await matchOf("bea"))?.matchedBy === "NAME_ONLY", "a roster member 18 or older is a candidate whatever the roster type");
  assert(!(await matchOf("cy")), "a child on the roster is never a candidate");
  assert(!(await matchOf("jonathan")), "a first-name variant is never auto-matched");
  const nameOnlyReviews = await repository.listBackgroundCheckReviews();
  const jonReview = nameOnlyReviews.find((review) => review.name === "Jon Quill");
  assertEqual(jonReview?.candidates.map((candidate) => candidate.name), ["Jonathan Quill"], "a first-name variant goes to review with the candidate");
  const dotReview = nameOnlyReviews.find((review) => review.name === "Dot Marsh");
  assert(dotReview?.candidates.length === 2, "two same-name candidates with nothing to separate them go to review");
  assert((await db.externalIdentity.count({ where: { externalId: { in: ["userId:83001", "userId:83003"] } } })) === 0, "a name-only match never writes a remembered id (#619)");
  assert((await db.backgroundCheckRememberedMatch.count({ where: { identityKey: { in: ["userId:83001", "userId:83003"] } } })) === 2, "it is remembered in the relabel-only table instead (#619)");
  const nameOnly = await repository.listNameOnlyBackgroundCheckMatches();
  assert(nameOnly.length === 2 && nameOnly.some((item) => item.personName === "Ines Varga" && item.site === otherSite), "the name-only matches are listed with the row's site");
  console.log("ok  name-only matches, variant reviews, and adults by age");

  // "Not the same person": unmatched now, after a Refresh, and after a new upload with the same user_id.
  const inesMatch = await matchOf("ines");
  await repository.rejectNameOnlyBackgroundCheckMatch(inesMatch!.id, ids.user);
  assert(!(await matchOf("ines")), "not the same person unmatches the row");
  assert((await db.backgroundCheckRejectedPairing.count({ where: { identityKey: "userId:83001", personId: ids.person("ines") } })) === 1, "the rejection is stored by the row's identity key");
  await repository.rematchBackgroundCheckList();
  await repository.refreshBackgroundCheckMatchForPerson(ids.person("ines"));
  assert(!(await matchOf("ines")), "a rejected name-only match stays unmatched through a Refresh");
  assert((await matchOf("bea"))?.matchedBy === "NAME_ONLY", "Refresh re-derives the other name-only match");
  const reuploadPreview = await repository.planBackgroundCheckUpload(nameOnlyRows);
  await repository.applyBackgroundCheckUpload(nameOnlyRows, "ROSTER", ids.user, new Date(), { expectedFingerprint: reuploadPreview.fingerprint });
  assert(!(await matchOf("ines")), "a rejected name-only match stays unmatched after a new upload with the same user_id");
  assert((await matchOf("bea"))?.matchedBy === "IDENTITY", "the new upload matches the earlier name-only row from the memory, with no staff action (#619)");
  assert((await repository.listNameOnlyBackgroundCheckMatches()).length === 0, "the spot-check list shows only matches new since the last upload (#619)");
  // A match by hand clears the rejection.
  const inesEntry = await db.backgroundCheckEntry.findFirst({ where: { identityKey: "userId:83001" }, select: { id: true } });
  const handReview = await db.backgroundCheckReview.create({ data: { entryId: inesEntry!.id, reason: "Check it.", candidatePersonIds: [ids.person("ines")] } });
  await repository.resolveBackgroundCheckReview(handReview.id, { type: "match", personId: ids.person("ines") }, ids.user);
  assert((await matchOf("ines"))?.matchedBy === "MANUAL", "staff can still match the rejected person by hand");
  assert((await db.backgroundCheckRejectedPairing.count({ where: { identityKey: "userId:83001" } })) === 0, "a match by hand clears the rejection");
  console.log("ok  not the same person holds through a Refresh and a new upload; a match by hand clears it");

  // The whole-list Refresh and staff decisions exclude each other on the list lock.
  const holdLockWhile = async (work: () => Promise<void>) => {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${repository.BACKGROUND_CHECK_LOCK_KEY}::bigint)`;
      await work();
    });
  };
  await holdLockWhile(async () => {
    await repository.rematchBackgroundCheckList().then(
      () => { throw new Error("FAILED: a Refresh ran while another writer held the list"); },
      (error: { code?: string }) => assert(error.code === "LIST_BUSY", "a Refresh is refused with LIST_BUSY while the list is held"),
    );
  });
  const beaMatch = await matchOf("bea");
  let concurrentRefresh: Promise<unknown> | null = null;
  await db.$transaction(async (tx) => {
    // Hold the lock exclusively the way a Refresh does, and try every other writer.
    await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${repository.BACKGROUND_CHECK_LOCK_KEY}::bigint)`;
    concurrentRefresh = repository.rematchBackgroundCheckList().catch((error: { code?: string }) => error.code);
    assert((await concurrentRefresh) === "LIST_BUSY", "a second Refresh is refused while one runs");
    await repository.rejectNameOnlyBackgroundCheckMatch(beaMatch!.id, ids.user).then(
      () => { throw new Error("FAILED: a reject ran during a Refresh"); },
      (error: { code?: string }) => assert(error.code === "LIST_BUSY", "a reject is refused while the list is held exclusively"),
    );
  });
  assert((await matchOf("bea"))?.matchedBy === "IDENTITY", "the refused reject changed nothing");
  console.log("ok  Refresh, reject, and per-person refresh exclude each other on the list lock");

  // Stored entries re-match through the staff Refresh with no new upload.
  await db.backgroundCheckMatch.deleteMany({ where: { matchedBy: "NAME_ONLY" } });
  await db.backgroundCheckReview.deleteMany({ where: { dismissedAt: null } });
  await repository.rematchBackgroundCheckList();
  assert(["IDENTITY", "NAME_ONLY"].includes((await matchOf("bea"))?.matchedBy ?? ""), "Refresh re-matches stored entries under the current rules");
  assert((await repository.listBackgroundCheckReviews()).some((review) => review.name === "Jon Quill"), "Refresh recreates the first-name variant review");

  // The lookup: reasons, and no birth dates.
  const lookup = await repository.lookupBackgroundCheckName("Quill");
  assert(/first name differs/i.test(lookup.pairs[0]?.reason ?? ""), "the lookup explains a first-name difference");
  const lookupChild = await repository.lookupBackgroundCheckName("Cy Lindqvist");
  assert(/not an adult/i.test(lookupChild.pairs[0]?.reason ?? ""), "the lookup explains a roster child is not an adult");
  const lookupJson = JSON.stringify([lookup, lookupChild, await repository.lookupBackgroundCheckName("Lindqvist")]);
  assert(!/1988|sealed|birth/i.test(lookupJson), "the lookup never shows a birth date");
  console.log("ok  Refresh re-matches stored entries; the lookup explains non-matches without birth dates");

  // 12. #619: name-only and variant matches are remembered in
  // BackgroundCheckRememberedMatch. Memory only changes a label; it never
  // overrides the normal rules, and staff can reject a remembered match.
  await rosterPerson("lena", "Lena", "Ortiz");
  await rosterPerson("jonas", "Jonas", "Vega");
  await rosterPerson("jane", "Jane", "Doe");
  // Sterling-shaped rows: no user_id, no site, keyed by email or by name alone.
  const sterlingRow = (first: string, last: string, options: { email?: string | null; site?: string | null } = {}) => {
    const email = options.email ?? null;
    return {
      ...parseRosterBackgroundCsv(`user_id,user_last,user_first,sites,compliance\n1,${last},${first},"x",y`).map(rosterRowToListRow)[0]!,
      sourceUserId: null,
      site: options.site ?? null,
      email,
      identityKey: email ? `email:${email}|${matchableName(`${first} ${last}`)}` : `name:${matchableName(`${first} ${last}`)}`,
    };
  };
  const janeEmail = `jane.doe.${P}@example.test`;
  const noIdRows = [
    { ...sterlingRow("Lena", "Ortiz"), site: otherSite, identityKey: "name-site:lena ortiz|faraway" },
    sterlingRow("Jon", "Vega", { site: "Verify Church (Springfield)" }),
    sterlingRow("Jane", "Doe", { email: janeEmail }),
  ];
  const noIdUpload = async () => {
    const preview = await repository.planBackgroundCheckUpload(noIdRows);
    await repository.applyBackgroundCheckUpload(noIdRows, "STERLING", ids.user, new Date(), { expectedFingerprint: preview.fingerprint });
  };
  const lastUploadAudit = async () => (await db.auditLog.findFirst({ where: { action: "BACKGROUND_CHECK_LIST_UPLOADED" }, orderBy: { createdAt: "desc" } }))?.metadata as Record<string, number> | undefined;
  await noIdUpload();
  assert((await matchOf("lena"))?.matchedBy === "NAME_ONLY", "a row with no user_id matches by name only");
  assert((await matchOf("jonas"))?.matchedBy === "NAME_ONLY", "a lone first-name variant with a matching site matches");
  assert((await matchOf("jane"))?.matchedBy === "NAME_ONLY", "a Sterling row with an email and no site matches the only Jane Doe by name");
  assertEqual((await db.backgroundCheckRememberedMatch.findMany({ where: { personId: { in: ["lena", "jonas", "jane"].map((key) => ids.person(key)) } }, select: { matchedBy: true }, orderBy: { matchedBy: "asc" } })), [
    { matchedBy: "NAME_ONLY" }, { matchedBy: "NAME_ONLY" }, { matchedBy: "VARIANT" },
  ], "all three are remembered by the row's identity key");
  assert((await repository.listNameOnlyBackgroundCheckMatches()).length === 3, "all three are new on the spot-check list");
  const firstAudit = await lastUploadAudit();
  assert(firstAudit?.rememberedWritten === 3 && firstAudit?.rememberedMatched === 0 && firstAudit?.forgotRemembered === 0, "the upload audit counts what was remembered, and nothing else");
  await noIdUpload();
  for (const key of ["lena", "jonas", "jane"]) assert((await matchOf(key))?.matchedBy === "IDENTITY", `the next upload matches ${key} from the memory`);
  assert((await repository.listNameOnlyBackgroundCheckMatches()).length === 0, "and lists none as new");
  assert((await lastUploadAudit())?.rememberedMatched === 3, "the audit counts the remembered matches");
  // B1: a second Jane Doe whose email equals the row's wins by AUTO; the memory never keeps the first.
  await db.person.create({ data: { id: ids.person("jane-2"), firstName: "Jane", lastName: "Doe", normalizedEmail: janeEmail } });
  await db.clubRosterMember.create({ data: { id: ids.member("jane-2"), organizationId: ids.club, clubYear, personId: ids.person("jane-2"), attendeeType: "ADULT", source: "DIRECTOR" } });
  await noIdUpload();
  assert((await matchOf("jane-2"))?.matchedBy === "AUTO" && !(await matchOf("jane")), "a second Jane Doe with the row's email is matched by AUTO, not the remembered first");
  assert((await db.backgroundCheckRememberedMatch.count({ where: { personId: ids.person("jane") } })) === 0, "the stale memory is dropped");
  assert(((await lastUploadAudit())?.forgotRemembered ?? 0) >= 1, "the audit counts the dropped memory");
  // B3: reject remembered IDENTITY matches (no user_id, and a remembered variant) without touching the DB rows.
  const lenaMatch = (await matchOf("lena"))!;
  assert(lenaMatch.matchedBy === "IDENTITY", "the match to reject is a remembered IDENTITY match");
  await repository.rejectNameOnlyBackgroundCheckMatch(lenaMatch.id, ids.user);
  assert((await db.backgroundCheckRememberedMatch.count({ where: { identityKey: "name-site:lena ortiz|faraway" } })) === 0, "not the same person deletes the memory");
  assert((await db.auditLog.count({ where: { action: "BACKGROUND_CHECK_NAME_ONLY_MATCH_REJECTED" } })) >= 1, "the rejection is audited");
  await repository.rejectNameOnlyBackgroundCheckMatch((await matchOf("jonas"))!.id, ids.user);
  await noIdUpload();
  assert(!(await matchOf("lena")) && !(await matchOf("jonas")), "rejected rows stay unmatched on the next upload");
  console.log("ok  name-only and variant matches are remembered without overriding the rules; a rejection clears the memory");

  // 13. #619: a name-only match on a user_id row must not become a remembered id
  // that keeps beating a better match. Mia Stone #1 (another church) matches
  // name-only; Mia Stone #2 (the row's church) then arrives.
  const stoneChurch = `${P}_church_stone`;
  const stoneClub = `${P}_club_stone`;
  await db.organization.create({ data: { id: stoneChurch, type: "CHURCH", name: "Stone Hollow SDA Church", normalizedName: "stone hollow sda church" } });
  await db.organization.create({ data: { id: stoneClub, type: "CLUB", name: "Stone Hollow Pathfinders", normalizedName: "stone hollow pathfinders", parentOrganizationId: stoneChurch } });
  await rosterPerson("mia1", "Mia", "Stone");
  const stoneRows = parseRosterBackgroundCsv(`user_id,user_last,user_first,sites,compliance\n84001,Stone,Mia,"Stone Hollow SDA Church (Elsewhere)",y`).map(rosterRowToListRow);
  const stoneUpload = async () => {
    const preview = await repository.planBackgroundCheckUpload(stoneRows);
    await repository.applyBackgroundCheckUpload(stoneRows, "ROSTER", ids.user, new Date(), { expectedFingerprint: preview.fingerprint });
  };
  await stoneUpload();
  assert((await matchOf("mia1"))?.matchedBy === "NAME_ONLY", "Mia Stone #1 matches by name only");
  assert((await db.externalIdentity.count({ where: { externalId: "userId:84001" } })) === 0, "no remembered id is written for it");
  await db.person.create({ data: { id: ids.person("mia2"), firstName: "Mia", lastName: "Stone" } });
  await db.clubRosterMember.create({ data: { id: ids.member("mia2"), organizationId: stoneClub, clubYear, personId: ids.person("mia2"), attendeeType: "ADULT", source: "DIRECTOR" } });
  await repository.refreshBackgroundCheckMatchForPerson(ids.person("mia2"));
  assert((await matchOf("mia2"))?.matchedBy === "AUTO" && !(await matchOf("mia1")), "the per-person refresh moves the row to Mia Stone #2 by AUTO");
  await repository.rematchBackgroundCheckList();
  assert(["AUTO", "IDENTITY"].includes((await matchOf("mia2"))?.matchedBy ?? "") && !(await matchOf("mia1")), "so does the staff Refresh (now by the id the AUTO match remembered)");
  await stoneUpload();
  assert(["AUTO", "IDENTITY"].includes((await matchOf("mia2"))?.matchedBy ?? "") && !(await matchOf("mia1")), "and the next upload");
  assert((await db.backgroundCheckRememberedMatch.count({ where: { identityKey: "userId:84001" } })) === 0, "the memory is dropped");
  assert((await repository.listBackgroundCheckReviews()).every((review) => review.name !== "Mia Stone"), "no review is raised for the row");
  console.log("ok  a name-only match on a user_id row never becomes a remembered id that keeps beating a better match");
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
