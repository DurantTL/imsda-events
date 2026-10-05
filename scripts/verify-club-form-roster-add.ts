/**
 * Proves "Add to roster" from a submitted club form (#721) against a real
 * PostgreSQL database, where the unit tests' fake database can't:
 *
 * - the migration's columns and foreign key work: adding records the member on
 *   the submission (`rosterAction`, `rosterActionMemberId`, `rosterMemberId`),
 *   and erasing the member clears the link instead of failing;
 * - the add and the submission record are one transaction: when two confirms
 *   race, exactly one wins, the loser rolls its new member back, and the club
 *   ends with one person (the race guard);
 * - a form already added cannot be added or linked again, until its member is
 *   removed from the roster, after which it can;
 * - linking changes nothing on the member (no merge) and another club's member
 *   is refused;
 * - the birth date is sealed on the roster row, and no audit row holds a name,
 *   birth date or guardian value.
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:club-form-roster-add
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import type { ClubFormsViewer } from "@/modules/club-forms/domain";
import { confirmAddToRoster } from "@/modules/club-forms/roster-add";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { removeRosterMember } from "@/modules/club-rosters/repository";
import type { RosterMemberInput } from "@/modules/club-rosters/schemas";

loadEnvConfig(process.cwd());
// Local-only, before any Prisma client or connection exists.
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-roster-add-synthetic-key-not-a-secret");

const prisma = new PrismaClient();
const P = "ra721";
const clubs = { a: `${P}_club_a`, b: `${P}_club_b` };
const accountId = `${P}_acct`;
const templateKey = `${P}_membership`;
const seed = clubFormTemplateSeeds.find((candidate) => candidate.key === "pathfinder_membership_application")!;
const now = new Date();
const clubYear = clubYearFor(now);
const director: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: clubs.a, actor: { kind: "ATTENDEE", accountId } };
const SECRET_GUARDIAN = "Verify Guardian Only";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function code(promise: Promise<unknown>) {
  return promise.then(() => null, (error: { code?: string }) => error.code ?? "ERROR");
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { metadata: { path: ["organizationId"], string_starts_with: P } } });
  await prisma.clubFormSubmission.deleteMany({ where: { organizationId: { in: Object.values(clubs) } } });
  const members = await prisma.clubRosterMember.findMany({ where: { organizationId: { in: Object.values(clubs) } }, select: { personId: true } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: { in: Object.values(clubs) } } });
  await prisma.person.deleteMany({ where: { id: { in: members.flatMap((member) => (member.personId ? [member.personId] : [])) } } });
  await prisma.clubFormTemplate.deleteMany({ where: { key: templateKey } });
  await prisma.organization.deleteMany({ where: { id: { in: Object.values(clubs) } } });
  await prisma.attendeeAccount.deleteMany({ where: { id: accountId } });
}

const input = (firstName: string, birthDate = "2014-05-06"): RosterMemberInput => ({
  firstName,
  lastName: "Rosteradd",
  birthDate,
  attendeeType: "YOUTH",
  role: "Pathfinder",
  classLevel: "EXPLORER",
  gender: "FEMALE",
  guardians: [{ name: SECRET_GUARDIAN, relationship: "Mother", email: "", phone: "" }],
});

async function main() {
  await cleanup();
  await prisma.attendeeAccount.create({ data: { id: accountId, email: "director@roster-add.example.test", displayName: "Verify Director", status: "ACTIVE" } });
  for (const [key, id] of Object.entries(clubs)) {
    await prisma.organization.create({ data: { id, type: "CLUB", name: `Verify Club ${key}`, normalizedName: `verify club ${key} ${P}` } });
  }
  const template = await prisma.clubFormTemplate.create({
    data: {
      key: templateKey, name: seed.name, version: seed.version, definition: JSON.parse(JSON.stringify(seed.definition)), sectionNotes: seed.sectionNotes,
      sensitiveFieldKeys: seed.sensitiveFieldKeys, birthDateFieldKeys: seed.birthDateFieldKeys, staffOnlyFieldKeys: seed.staffOnlyFieldKeys,
      rosterMapping: { ...seed.rosterMapping!, enabled: true }, enabled: true, customizedAt: now,
    },
  });
  const submission = async (id: string, organizationId = clubs.a) => prisma.clubFormSubmission.create({
    data: {
      id, templateId: template.id, organizationId, clubYear, subjectName: "Verify Applicant", status: "SUBMITTED", answers: { full_name: "Verify Applicant" },
      templateVersion: template.version, enteredVia: "LINK", submittedAt: now,
    },
  });
  const state = (id: string) => prisma.clubFormSubmission.findUniqueOrThrow({ where: { id }, select: { rosterAction: true, rosterActionMemberId: true, rosterMemberId: true, rosterActionAt: true, answers: true } });
  const members = () => prisma.clubRosterMember.findMany({ where: { organizationId: clubs.a } });

  // 1. Add: the member is created and recorded on the submission, sealed birth date, answers untouched.
  await submission(`${P}_s1`);
  const added = await confirmAddToRoster(director, { action: "ADD", organizationId: clubs.a, submissionId: `${P}_s1`, member: input("Verifya") }, now);
  assert(added.action === "ADDED" && added.clubYear === clubYear, "an add reports the current club year");
  const afterAdd = await state(`${P}_s1`);
  assert(afterAdd.rosterAction === "ADDED" && afterAdd.rosterActionMemberId === added.rosterMemberId && afterAdd.rosterMemberId === added.rosterMemberId, "the submission records the member");
  assert(JSON.stringify(afterAdd.answers) === JSON.stringify({ full_name: "Verify Applicant" }), "the answers are unchanged");
  const row = await prisma.clubRosterMember.findUniqueOrThrow({ where: { id: added.rosterMemberId } });
  assert(row.sealedBirthDate && !row.sealedBirthDate.includes("2014"), "the birth date is sealed on the roster row");
  assert((await prisma.clubRosterGuardian.count({ where: { rosterMemberId: added.rosterMemberId } })) === 1, "the guardian contact is stored");

  // 2. Already added: nothing more can be added or linked.
  assert((await code(confirmAddToRoster(director, { action: "ADD", organizationId: clubs.a, submissionId: `${P}_s1`, member: input("Verifyb") }, now))) === "ALREADY_ON_ROSTER", "a second add is refused");
  assert((await code(confirmAddToRoster(director, { action: "LINK", organizationId: clubs.a, submissionId: `${P}_s1`, memberId: added.rosterMemberId }, now))) === "ALREADY_ON_ROSTER", "a link after an add is refused");
  assert((await members()).length === 1, "the refused add created nobody");

  // 3. Race: two confirms on one form, with different people so only the claim guard can decide.
  await submission(`${P}_s2`);
  const race = await Promise.allSettled([
    confirmAddToRoster(director, { action: "ADD", organizationId: clubs.a, submissionId: `${P}_s2`, member: input("Racera", "2013-01-02") }, now),
    confirmAddToRoster(director, { action: "ADD", organizationId: clubs.a, submissionId: `${P}_s2`, member: input("Racerb", "2013-03-04") }, now),
  ]);
  const won = race.filter((result) => result.status === "fulfilled");
  const lost = race.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert(won.length === 1 && lost.length === 1, "exactly one of two racing confirms wins");
  assert((lost[0].reason as { code?: string }).code === "ALREADY_ON_ROSTER", "the loser is told the form is already on the roster");
  assert((await members()).length === 2, "the loser's new member was rolled back (two people: the first form's and the race winner)");
  const raced = await state(`${P}_s2`);
  assert(raced.rosterActionMemberId === (won[0] as PromiseFulfilledResult<{ rosterMemberId: string }>).value.rosterMemberId, "the winner is the recorded member");

  // 4. Link: another club's member is refused, the form's own club's member is recorded, and the member is untouched.
  const foreign = await prisma.clubRosterMember.create({ data: { organizationId: clubs.b, clubYear, attendeeType: "YOUTH", source: "DIRECTOR" } });
  await submission(`${P}_s3`);
  assert((await code(confirmAddToRoster(director, { action: "LINK", organizationId: clubs.a, submissionId: `${P}_s3`, memberId: foreign.id }, now))) === "MEMBER_NOT_FOUND", "another club's member is refused");
  const before = await prisma.clubRosterMember.findUniqueOrThrow({ where: { id: added.rosterMemberId } });
  const linked = await confirmAddToRoster(director, { action: "LINK", organizationId: clubs.a, submissionId: `${P}_s3`, memberId: added.rosterMemberId }, now);
  assert(linked.action === "LINKED", "a link reports LINKED");
  const after = await prisma.clubRosterMember.findUniqueOrThrow({ where: { id: added.rosterMemberId } });
  assert(JSON.stringify({ ...before, updatedAt: 0 }) === JSON.stringify({ ...after, updatedAt: 0 }), "linking changes nothing on the member (no merge)");
  assert((await prisma.clubFormSubmission.count({ where: { rosterMemberId: added.rosterMemberId } })) === 2, "the member's own list of forms now has both forms");

  // 5. Removing the member frees the form: the link clears or the form reads as not added, and it can be added again.
  await removeRosterMember(clubs.a, added.rosterMemberId, { accountId }, now);
  assert((await prisma.clubRosterMember.findUniqueOrThrow({ where: { id: added.rosterMemberId } })).status === "REMOVED", "the member is removed");
  const readded = await confirmAddToRoster(director, { action: "ADD", organizationId: clubs.a, submissionId: `${P}_s1`, member: input("Verifyc", "2012-02-03") }, now);
  assert(readded.action === "ADDED" && (await state(`${P}_s1`)).rosterActionMemberId === readded.rosterMemberId, "a form whose member was removed can be added again");

  // 6. Deleting a member row clears the foreign key instead of failing.
  await prisma.clubRosterMember.delete({ where: { id: readded.rosterMemberId } });
  const cleared = await state(`${P}_s1`);
  assert(cleared.rosterActionMemberId === null && cleared.rosterMemberId === null && cleared.rosterAction === "ADDED", "deleting the member clears the submission's links (SET NULL)");

  // 7. No audit row holds a name, birth date or guardian value.
  const audits = await prisma.auditLog.findMany({ where: { metadata: { path: ["organizationId"], string_starts_with: P } } });
  const text = JSON.stringify(audits);
  for (const secret of ["Verifya", "Racera", "Rosteradd", "2014-05-06", SECRET_GUARDIAN, "Verify Applicant"]) {
    assert(!text.includes(secret), `no audit row contains "${secret}"`);
  }
  assert(audits.some((entry) => entry.action === "CLUB_FORM_SUBMISSION_ADDED_TO_ROSTER") && audits.some((entry) => entry.action === "CLUB_FORM_SUBMISSION_LINKED_TO_ROSTER"), "add and link are audited");

  console.log("Club form Add to roster (#721): all checks passed.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
  });
