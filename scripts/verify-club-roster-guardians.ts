/**
 * Proves guardian contacts on club roster members (#510) against a real
 * PostgreSQL database, where the unit tests' fake database can't:
 *
 * - up to two guardians per member, one row per slot, and the database itself
 *   refuses a third slot, a duplicate slot, and a guardian with no member;
 * - an edit replaces the whole set; a blank slot removes that guardian;
 * - removing a member deletes every guardian of that member (and only theirs),
 *   inactive members keep theirs, and deleting the row cascades;
 * - readers: the club's own leader, any Area Coordinator and sensitive-data
 *   staff read; another club's leader is refused;
 * - no audit row holds a guardian value.
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:club-roster-guardians
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { addRosterMember, removeRosterMember, updateRosterMember } from "@/modules/club-rosters/repository";
import { GuardianAccessError, listGuardianContactsForClub, listGuardiansByMember } from "@/modules/club-rosters/guardians-repository";
import type { GuardianViewer } from "@/modules/club-rosters/guardians-domain";

loadEnvConfig(process.cwd());
process.env.SECRET_ENCRYPTION_KEY ||= "verify-guardians-synthetic-key-not-a-secret";

const prisma = new PrismaClient();
const P = "gd510";
const clubs = { a: `${P}_club_a`, b: `${P}_club_b` };
const clubYear = "2026-27";
const actor = { accountId: `${P}_acct` };
const SECRET_NAME = "Verify Guardian Only";
const SECRET_EMAIL = "verify.guardian@example.test";
const SECRET_PHONE = "(515) 555-0188";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function rejects(promise: Promise<unknown>) {
  return promise.then(() => false, () => true);
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { metadata: { path: ["organizationId"], string_starts_with: P } } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: { in: Object.values(clubs) } } });
  await prisma.person.deleteMany({ where: { firstName: { in: ["Verifya", "Verifyb"] }, lastName: { in: ["Alpha", "Beta"] } } });
  await prisma.organization.deleteMany({ where: { id: { in: Object.values(clubs) } } });
  await prisma.attendeeAccount.deleteMany({ where: { id: actor.accountId } });
  await prisma.user.deleteMany({ where: { id: `${P}_staff` } });
}

const guardian = (name: string, extra: Partial<{ relationship: string; email: string; phone: string }> = {}) => ({
  name, relationship: "Mother", email: "", phone: "", ...extra,
});
const blank = { name: "", relationship: "", email: "", phone: "" };

async function main() {
  await cleanup();
  await prisma.attendeeAccount.create({ data: { id: actor.accountId, email: `director@guardians.example.test`, displayName: "Verify Director", status: "ACTIVE" } });
  await prisma.user.create({ data: { id: `${P}_staff`, email: "staff@guardians.example.test", displayName: "Verify Staff", globalRole: null } });
  for (const [key, id] of Object.entries(clubs)) {
    await prisma.organization.create({ data: { id, type: "CLUB", name: `Verify Club ${key}`, normalizedName: `verify club ${key} ${P}` } });
  }
  const base = { attendeeType: "YOUTH" as const, role: "Pathfinder", classLevel: null, gender: "FEMALE" as const };
  const added = await addRosterMember(clubs.a, clubYear, {
    ...base, firstName: "Verifya", lastName: "Alpha", birthDate: "2014-05-06",
    guardians: [guardian(SECRET_NAME, { email: SECRET_EMAIL, phone: SECRET_PHONE }), guardian("Verify Second", { relationship: "Uncle" })],
  }, actor);
  const other = await addRosterMember(clubs.a, clubYear, {
    ...base, firstName: "Verifyb", lastName: "Beta", birthDate: "2013-04-05", guardians: [guardian("Verify Other Guardian")],
  }, actor);
  const countFor = (id: string) => prisma.clubRosterGuardian.count({ where: { rosterMemberId: id } });
  assert((await countFor(added.memberId)) === 2, "two guardians are stored for the first member");

  // The database enforces the shape, not only the app.
  assert(await rejects(prisma.clubRosterGuardian.create({ data: { rosterMemberId: added.memberId, position: 3, name: "Third" } })), "a third slot is refused");
  assert(await rejects(prisma.clubRosterGuardian.create({ data: { rosterMemberId: added.memberId, position: 1, name: "Duplicate" } })), "a duplicate slot is refused");
  assert(await rejects(prisma.clubRosterGuardian.create({ data: { rosterMemberId: "no-such-member", position: 1, name: "Orphan" } })), "a guardian needs a member");

  // An edit replaces the whole set.
  await updateRosterMember(clubs.a, added.memberId, { guardians: [guardian("Verify Renamed"), blank] }, actor);
  const afterEdit = await prisma.clubRosterGuardian.findMany({ where: { rosterMemberId: added.memberId } });
  assert(afterEdit.length === 1 && afterEdit[0]!.position === 1 && afterEdit[0]!.name === "Verify Renamed", "an edit replaces the set and a blank slot removes that guardian");
  await updateRosterMember(clubs.a, added.memberId, { role: "TLT" }, actor);
  assert((await countFor(added.memberId)) === 1, "an edit that doesn't send guardians leaves them alone");
  await updateRosterMember(clubs.a, added.memberId, { guardians: [guardian(SECRET_NAME, { email: SECRET_EMAIL, phone: SECRET_PHONE }), guardian("Verify Second", { relationship: "Uncle" })] }, actor);

  // Readers.
  const leaderA: GuardianViewer = { kind: "CLUB_LEADER", organizationId: clubs.a, actor: { kind: "ATTENDEE", accountId: actor.accountId } };
  const leaderB: GuardianViewer = { kind: "CLUB_LEADER", organizationId: clubs.b, actor: { kind: "ATTENDEE", accountId: `${P}_acct_b` } };
  const coordinator: GuardianViewer = { kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: `${P}_acct_area` } };
  const staff: GuardianViewer = { kind: "STAFF", userId: `${P}_staff` };
  assert(Object.keys(await listGuardiansByMember(leaderA, clubs.a, clubYear)).length === 2, "the club's leader reads its guardians");
  assert(await rejects(listGuardiansByMember(leaderB, clubs.a, clubYear)), "another club's leader is refused");
  assert((await listGuardianContactsForClub(leaderB, clubs.a, clubYear).catch((error) => error)) instanceof GuardianAccessError, "another club's leader gets a guardian access error");
  assert((await listGuardianContactsForClub(coordinator, clubs.a, clubYear)).length === 2, "an Area Coordinator reads any club");
  assert((await listGuardianContactsForClub(staff, clubs.a, clubYear)).length === 2, "sensitive-data staff read any club");

  // An inactive member keeps theirs; removal deletes only that member's.
  await updateRosterMember(clubs.a, other.memberId, { status: "INACTIVE" }, actor);
  assert((await countFor(other.memberId)) === 1, "an inactive member keeps their guardians");
  await removeRosterMember(clubs.a, added.memberId, actor);
  assert((await countFor(added.memberId)) === 0, "removing a member deletes every guardian of that member");
  assert((await countFor(other.memberId)) === 1, "removal leaves other members' guardians");
  assert(!(await listGuardianContactsForClub(coordinator, clubs.a, clubYear)).some((contact) => contact.memberId === added.memberId), "a removed member is not listed");

  // Deleting the member row cascades.
  await prisma.clubRosterMember.delete({ where: { id: other.memberId } });
  assert((await countFor(other.memberId)) === 0, "deleting the member row cascades to its guardians");

  // No audit row holds a guardian value.
  const audits = await prisma.auditLog.findMany({ where: { metadata: { path: ["organizationId"], string_starts_with: P } } });
  const text = JSON.stringify(audits);
  for (const secret of [SECRET_NAME, SECRET_EMAIL, SECRET_PHONE, "Verify Renamed", "Verify Second", "Verify Other Guardian"]) {
    assert(!text.includes(secret), `no audit row contains "${secret}"`);
  }
  assert(audits.some((row) => row.action === "CLUB_ROSTER_GUARDIANS_VIEWED"), "a coordinator's or staff opening is audited");

  console.log("Club roster guardians (#510): all checks passed.");
}

main()
  .finally(async () => {
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
