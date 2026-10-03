/**
 * Proves the Pathfinder Health Record (#611) against a real PostgreSQL
 * database, where the unit tests' fake database can't:
 *
 * - with HEALTH_RECORDS_ENABLED off nothing is stored, even when asked to;
 * - with it on, every health field is its own sealed row and the plaintext
 *   appears in no column, audit row or outbox row; it round-trips for the
 *   club's director, and another club's director is refused;
 * - every view writes one audit row with no health text;
 * - a parent's private link: minted at delivery, stored only as a hash, works
 *   exactly once even when many submits race, and the record it writes is
 *   Current for this club year; an older club year reads Needs update;
 * - removing a roster member erases the record and withdraws its open links.
 *
 * Uses fictitious rows it creates and removes itself, and a synthetic key.
 *
 *   npm run test:health-records
 */
import { createHash } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { assertLocalDatabase } from "./support/local-only-guard";
import { PrismaClient } from "@prisma/client";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";

loadEnvConfig(process.cwd());
// Local-only, before any Prisma client or connection exists.
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("RESEND_API_KEY", "verify-script-placeholder-never-sent");
fillBlankSyntheticEnv("ACCOUNT_EMAIL_SENDER_ADDRESS", "events@health.example.test");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-health-records-synthetic-key-not-a-secret");
// The origin the links are built on is set explicitly, whatever .env holds
// (the local default is http://localhost:3000). Nothing is delivered to it.
const syntheticOrigin = "https://events.health.example.test";
process.env.APP_BASE_URL = syntheticOrigin;
process.env.HEALTH_RECORDS_ENABLED = "false";

/** The delivered link, over http or https, and only on the synthetic origin set above. */
function linkFrom(bodyText: string) {
  const link = bodyText.match(/https?:\/\/\S+/)?.[0];
  if (link && !link.startsWith(`${syntheticOrigin}/`)) {
    throw new Error("The delivered link is not on the synthetic verification origin.");
  }
  return link;
}

const prisma = new PrismaClient();
const P = "hr611";
const clubs = { a: `${P}_club_a`, b: `${P}_club_b` };
const accounts = { a: `${P}_acct_a`, b: `${P}_acct_b` };
const emailDomain = "health.example.test";
const SECRETS = ["Verify allergy text only", "Verify medication text only", "Verify Mutual Insurer", "4 Verify Road", "515-555-0188"];

const record = {
  addressLine1: "4 Verify Road",
  city: "Exampleville",
  state: "IA",
  zip: "50001",
  phone: "515-555-0188",
  email: "kid@health.example.test",
  lastTetanusBooster: "2024-03-01",
  hasAllergies: "YES",
  allergyDetails: "Verify allergy text only",
  medications: "Verify medication text only",
  hasInsurance: "YES",
  insuranceCompany: "Verify Mutual Insurer",
  insuranceGroupNumber: "VG-1",
  insurancePolicyNumber: "VP-1",
  insurancePhone: "515-555-0189",
  guardianFirstName: "Pat",
  guardianLastName: "Verify",
  guardianPhone: "515-555-0190",
  emergencyContacts: [{ firstName: "Alex", lastName: "Verify", phone: "515-555-0191", relationship: "Aunt" }],
  consentEmergencyTreatment: true,
  consentActivities: true,
  consentPhotocopy: true,
  signature: "Pat Verify",
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function expectCode(promise: Promise<unknown>, code: string, message: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  assert(
    error && typeof error === "object" && "code" in error && (error as { code: string }).code === code,
    `${message}: expected ${code}, got ${String(error)}`,
  );
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function cleanup() {
  const records = await prisma.healthRecord.findMany({ where: { organizationId: { in: Object.values(clubs) } }, select: { id: true } });
  const links = await prisma.healthRecordLink.findMany({ where: { organizationId: { in: Object.values(clubs) } }, select: { id: true, messageId: true } });
  await prisma.auditLog.deleteMany({
    where: { OR: [{ entityId: { in: [...records, ...links].map((row) => row.id) } }, { entityId: { startsWith: P } }] },
  });
  await prisma.healthRecord.deleteMany({ where: { organizationId: { in: Object.values(clubs) } } });
  await prisma.healthRecordLink.deleteMany({ where: { organizationId: { in: Object.values(clubs) } } });
  await prisma.messageOutbox.deleteMany({ where: { recipientEmail: { endsWith: `@${emailDomain}` } } });
  await prisma.rateLimitBucket.deleteMany({ where: { policy: { startsWith: "club-form." } } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: { in: Object.values(clubs) } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.attendeeAccount.deleteMany({ where: { id: { in: Object.values(accounts) } } });
  await prisma.organization.deleteMany({ where: { id: { in: Object.values(clubs) } } });
}

async function main() {
  const repo = await import("../modules/health-records/repository");
  const linkEmail = await import("../modules/health-records/link-email");
  const rosterDomain = await import("../modules/club-rosters/domain");
  const rosterRepo = await import("../modules/club-rosters/repository");
  type Viewer = import("../modules/health-records/domain").HealthViewer;
  const directorA: Viewer = { kind: "CLUB_LEADER", organizationId: clubs.a, accountId: accounts.a };
  const directorB: Viewer = { kind: "CLUB_LEADER", organizationId: clubs.b, accountId: accounts.b };
  const now = new Date();
  const clubYear = rosterDomain.clubYearFor(now);

  await cleanup();
  await prisma.organization.createMany({
    data: [
      { id: clubs.a, type: "CLUB", name: "Verify Health Club A", normalizedName: "verify health club a" },
      { id: clubs.b, type: "CLUB", name: "Verify Health Club B", normalizedName: "verify health club b" },
    ],
  });
  for (const [key, id] of Object.entries(accounts)) {
    await prisma.attendeeAccount.create({ data: { id, email: `account-${key}@${emailDomain}`, displayName: `Verify ${key}`, status: "ACTIVE" } });
  }
  await prisma.person.create({ data: { id: `${P}_riley`, firstName: "Riley", lastName: "Verify" } });
  const member = await prisma.clubRosterMember.create({
    data: { organizationId: clubs.a, clubYear, personId: `${P}_riley`, attendeeType: "YOUTH", role: "Pathfinder", source: "DIRECTOR" },
  });

  // 1. Switched off: nothing is stored -----------------------------------
  await expectCode(repo.saveHealthRecord(directorA, clubs.a, member.id, record, now), "NOT_FOUND", "saving with the flag off");
  await expectCode(repo.viewHealthRecord(directorA, clubs.a, member.id, now), "NOT_FOUND", "viewing with the flag off");
  assert((await prisma.healthRecord.count({ where: { organizationId: clubs.a } })) === 0, "nothing is stored with the flag off");

  // 2. Switched on: sealed per field, audited, role scoped ---------------
  process.env.HEALTH_RECORDS_ENABLED = "true";
  // The environment is read once per process; load a fresh copy of it.
  const envModule = await import("../lib/env");
  envModule.resetServerEnvCache();
  assert((await import("../modules/health-records/flag")).healthRecordsEnabled(), "the flag is on for the rest of this script");

  await repo.saveHealthRecord(directorA, clubs.a, member.id, record, now);
  const stored = await prisma.healthRecord.findUniqueOrThrow({ where: { rosterMemberId: member.id }, include: { fields: true } });
  assert(stored.hasHealthNote === true && stored.confirmedClubYear === clubYear, "the flag and club year are stored in the clear");
  assert(stored.fields.length >= 15, "each field is its own row");
  assert(new Set(stored.fields.map((field) => field.sealedValue)).size === stored.fields.length, "no two fields share a ciphertext");
  const dump = JSON.stringify(stored) + JSON.stringify(await prisma.auditLog.findMany({ where: { entityId: stored.id } }));
  for (const secret of SECRETS) assert(!dump.includes(secret), `"${secret}" is in no stored column or audit row`);

  await expectCode(repo.viewHealthRecord(directorB, clubs.a, member.id, now), "MEMBER_NOT_FOUND", "another club's director");
  await expectCode(repo.saveHealthRecord(directorB, clubs.a, member.id, record, now), "MEMBER_NOT_FOUND", "another club's director saving");

  const before = await prisma.auditLog.count({ where: { action: "HEALTH_RECORD_VIEWED", entityId: stored.id } });
  const view = await repo.viewHealthRecord(directorA, clubs.a, member.id, now);
  assert(view.values.allergyDetails === "Verify allergy text only" && view.status === "CURRENT", "the director reads the record back");
  const viewRows = await prisma.auditLog.findMany({ where: { action: "HEALTH_RECORD_VIEWED", entityId: stored.id } });
  assert(viewRows.length === before + 1, "one view writes one audit row");
  for (const secret of SECRETS) assert(!JSON.stringify(viewRows).includes(secret), "the view audit row holds no health text");

  const old = await prisma.healthRecord.update({ where: { id: stored.id }, data: { confirmedClubYear: "2020-21" } });
  assert((await repo.viewHealthRecord(directorA, clubs.a, member.id, now)).status === "NEEDS_UPDATE" && old.id === stored.id, "an old club year reads Needs update");
  await repo.confirmHealthRecord(directorA, clubs.a, member.id, now);
  assert((await repo.viewHealthRecord(directorA, clubs.a, member.id, now)).status === "CURRENT", "confirming makes it Current");

  // 3. Parent link: hash only, exactly once, even under a race -----------
  const created = await repo.createHealthRecordLink(directorA, { organizationId: clubs.a, rosterMemberId: member.id, recipientEmail: `parent@${emailDomain}` }, now);
  const outbox = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: created.messageId } });
  assert(outbox.bodyTextSnapshot.includes(linkEmail.HEALTH_RECORD_LINK_SENTINEL) && !/https?:\/\//.test(outbox.bodyTextSnapshot), "the queued body holds a sentinel, never a link");
  assert(!/Riley|allerg|medicat/i.test(outbox.bodyTextSnapshot), "the email names neither the child nor any health text");
  assert((await prisma.healthRecordLink.findUniqueOrThrow({ where: { id: created.linkId } })).tokenHash === null, "no token exists until delivery");
  const delivered = await linkEmail.prepareHealthRecordLinkBodyForDelivery({ messageId: created.messageId, bodyText: outbox.bodyTextSnapshot, now });
  const url = linkFrom(delivered.bodyText);
  assert(url, "delivery produces the link");
  const token = decodeURIComponent(url.split("/health-records/")[1]!);
  assert((await prisma.healthRecordLink.findUniqueOrThrow({ where: { id: created.linkId } })).tokenHash === sha256(token), "only the hash of the token is stored");
  const page = await repo.resolveHealthLinkForFill(token, now);
  assert(page.memberFirstName === "Riley" && !JSON.stringify(page).includes("Verify allergy"), "the page shows the first name and no stored value");

  const racers = await Promise.allSettled(Array.from({ length: 8 }, () => repo.submitHealthRecordViaLink(token, { ...record, medications: "Verify medication text only" }, now)));
  assert(racers.filter((result) => result.status === "fulfilled").length === 1, "exactly one of eight racing submits succeeds");
  await expectCode(repo.submitHealthRecordViaLink(token, record, now), "LINK_UNAVAILABLE", "a used link");
  await expectCode(repo.resolveHealthLinkForFill(token, now), "LINK_UNAVAILABLE", "opening a used link");
  assert((await prisma.healthRecord.count({ where: { organizationId: clubs.a } })) === 1, "the link updated the member's one record");

  const expiring = await repo.createHealthRecordLink(directorA, { organizationId: clubs.a, rosterMemberId: member.id, recipientEmail: `parent2@${emailDomain}`, expiresInDays: 1 }, now);
  const expiringMessage = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: expiring.messageId } });
  const expiringBody = await linkEmail.prepareHealthRecordLinkBodyForDelivery({ messageId: expiring.messageId, bodyText: expiringMessage.bodyTextSnapshot, now });
  const expiringToken = decodeURIComponent(linkFrom(expiringBody.bodyText)!.split("/health-records/")[1]!);
  const later = new Date(now.getTime() + 3 * 86_400_000);
  await expectCode(repo.submitHealthRecordViaLink(expiringToken, record, later), "LINK_UNAVAILABLE", "an expired link");

  // 4. Removing the member erases the record and withdraws the link ------
  await prisma.$transaction((tx) => rosterRepo.eraseRosterRow(tx, member.id, now));
  assert((await prisma.healthRecord.count({ where: { rosterMemberId: member.id } })) === 0, "removal erases the health record");
  assert((await prisma.healthRecordField.count({ where: { recordId: stored.id } })) === 0, "removal erases the sealed fields");
  assert((await prisma.healthRecordLink.count({ where: { rosterMemberId: member.id, status: "OPEN" } })) === 0, "removal withdraws open links");

  // 5. A record on an earlier year's row dies with the person -------------
  await prisma.person.create({ data: { id: `${P}_casey`, firstName: "Casey", lastName: "Verify" } });
  const lastYearDate = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate(), 15));
  const priorRow = await prisma.clubRosterMember.create({
    data: { organizationId: clubs.a, clubYear: rosterDomain.clubYearFor(lastYearDate), personId: `${P}_casey`, attendeeType: "YOUTH", role: "Pathfinder", source: "DIRECTOR" },
  });
  const currentRow = await prisma.clubRosterMember.create({
    data: { organizationId: clubs.a, clubYear, personId: `${P}_casey`, attendeeType: "YOUTH", role: "Pathfinder", source: "DIRECTOR" },
  });
  await repo.saveHealthRecord(directorA, clubs.a, priorRow.id, record, lastYearDate);
  const carried = await repo.viewHealthRecord(directorA, clubs.a, currentRow.id, now);
  assert(carried.status === "NEEDS_UPDATE", "last year's record follows the person and reads Needs update");
  await prisma.healthRecordLink.create({
    data: { organizationId: clubs.a, rosterMemberId: priorRow.id, clubYear: rosterDomain.clubYearFor(lastYearDate), recipientEmail: `old@${emailDomain}`, expiresAt: new Date(now.getTime() + 86_400_000), tokenHash: sha256("verify-open-link") },
  });
  await prisma.$transaction((tx) => rosterRepo.eraseRosterRow(tx, currentRow.id, now));
  assert((await prisma.healthRecord.count({ where: { organizationId: clubs.a, rosterMemberId: { in: [priorRow.id, currentRow.id] } } })) === 0, "removing the current-year row erases the earlier year's record too");
  assert((await prisma.healthRecordLink.count({ where: { rosterMemberId: priorRow.id, status: "OPEN" } })) === 0, "and withdraws the earlier row's open link");

  await cleanup();
  console.log("Health record checks passed.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
  });
