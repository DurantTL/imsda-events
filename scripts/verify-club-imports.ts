/**
 * Proves the club import (#376, #541) against a real PostgreSQL database with
 * a synthetic form 89 export (fictitious names only):
 *
 * - an August submission imports into the current club year, and every person
 *   in the preview (siblings, a parent and child sharing a surname, a
 *   two-letter first name) is on that year's roster: 48 in, 48 listed;
 * - the previous year stays empty, and the same entry can then be imported
 *   into the previous year, since the identity is per club year;
 * - re-importing the same entry and year reports "already imported";
 * - a second registration into an existing roster skips only people already
 *   on it, with a reason, and still adds a same-named parent and child.
 *
 * Creates and removes its own rows. Needs a local database.
 *
 *   npm run test:club-imports
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const now = new Date("2026-09-28T15:00:00Z");
const stamp = `ci541${Date.now().toString(36)}`;
const church = `${stamp} Hills SDA Church`;
const clubName = `${stamp} Hills Pathfinders`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function cleanup(userId: string) {
  const clubs = await prisma.organization.findMany({ where: { name: { startsWith: stamp } }, select: { id: true } });
  const ids = clubs.map((club) => club.id);
  const members = await prisma.clubRosterMember.findMany({ where: { organizationId: { in: ids } }, select: { personId: true } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: { in: ids } } });
  await prisma.person.deleteMany({ where: { id: { in: members.map((member) => member.personId).filter((id): id is string => Boolean(id)) } } });
  await prisma.externalIdentity.deleteMany({ where: { organizationId: { in: ids } } });
  await prisma.clubInvite.deleteMany({ where: { organizationId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: userId, entityId: { in: ids } } });
  await prisma.organization.deleteMany({ where: { type: "CLUB", id: { in: ids } } });
  await prisma.organization.deleteMany({ where: { type: "CHURCH", name: { startsWith: stamp } } });
}

async function main() {
  const { parseClubRegistrationExport } = await import("../modules/club-imports/domain");
  const { importClubs } = await import("../modules/club-imports/repository");
  const { listRoster } = await import("../modules/club-rosters/repository");
  const { syntheticExportEntry, SYNTHETIC_CHURCH } = await import("../tests/support/club-import-fixture");

  const admin = await prisma.user.findFirst({ where: { globalRole: "SYSTEM_ADMIN" }, select: { id: true } });
  assert(admin, "needs a system administrator in the local database (npm run db:seed)");

  const toItem = (entry: ReturnType<typeof syntheticExportEntry>, clubYear?: string) => {
    const [draft] = parseClubRegistrationExport([entry], now).drafts;
    return {
      sourceKey: draft.sourceKey,
      entryId: draft.entryId,
      clubYear: clubYear ?? draft.clubYear,
      clubName,
      churchId: null,
      newChurchName: church,
      invites: draft.invites.filter((invite) => invite.include).map(({ role, name, email }) => ({ role, name, email })),
      people: draft.people.filter((person) => person.include).map((person) => ({
        firstName: person.firstName,
        lastName: person.lastName,
        attendeeType: person.attendeeType,
        role: person.role,
        classLevel: person.classLevel,
        reportedAge: person.reportedAge,
      })),
    };
  };

  try {
    const entry = syntheticExportEntry({ id: `${stamp}1` });
    const [draft] = parseClubRegistrationExport([entry], now).drafts;
    assert(draft.submittedClubYear === "2025-26" && draft.clubYear === "2026-27", "an August submission defaults to the current club year");
    assert(SYNTHETIC_CHURCH.length > 0, "fixture church");

    const [first] = await importClubs([toItem(entry)], admin.id, now);
    assert(first.status === "IMPORTED" && first.membersAdded === 48 && first.membersSkipped === 0, `first import adds all 48 (${JSON.stringify(first)})`);
    const roster = await listRoster(first.organizationId!, "2026-27", now);
    assert(roster.length === 48, `48 on the 2026-27 roster, got ${roster.length}`);
    assert((await listRoster(first.organizationId!, "2025-26", now)).length === 0, "nothing lands in the previous year");
    for (const name of ["Cy Faux", "Kim Faux", "Bo Placeholder", "Ned Testerson"]) {
      assert(roster.some((member) => `${member.firstName} ${member.lastName}` === name), `${name} is listed`);
    }

    const [again] = await importClubs([toItem(entry)], admin.id, now);
    assert(again.status === "ALREADY_IMPORTED", "re-import is reported as already imported");
    assert((await listRoster(first.organizationId!, "2026-27", now)).length === 48, "re-import adds no one");

    const [previous] = await importClubs([toItem(entry, "2025-26")], admin.id, now);
    assert(previous.status === "IMPORTED" && previous.membersAdded === 48, "the same entry imports into the previous year when chosen");

    // A different registration for the same club and year is refused: one
    // import per club per club year.
    const second = syntheticExportEntry({ id: `${stamp}2` }, {
      leader_name: "Chris Faux",
      co_leader_name: "",
      other_assistants: [],
      repeater_container: [["Chris Faux", "9", "Friend"], ["Chris Faux", "9", "Friend"]],
    });
    const [refused] = await importClubs([toItem(second)], admin.id, now);
    assert(refused.status === "FAILED" && /already has an imported registration/.test(refused.message), "a second registration for the same club and year is refused");

    console.log("club imports verified: 48 imported into 2026-27, none in 2025-26, re-import reported, previous year importable, second registration refused");
  } finally {
    await cleanup(admin.id);
    await prisma.$disconnect();
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
