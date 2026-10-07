/**
 * Proves the club import (#376, #541) against a real PostgreSQL database with
 * a synthetic form 89 export (fictitious names only):
 *
 * - an August submission defaults to the current club year;
 * - "Move this import to another club year": an import made into the wrong
 *   year (2025-26) is previewed (48 rows, no conflicts) and moved to 2026-27
 *   with the Person count unchanged, 48 listed in 2026-27 and 0 in 2025-26,
 *   the identity's scope moved, and an audit entry with counts and ids only;
 * - re-uploading it then reports "imported for 2026-27", and re-importing
 *   adds no one;
 * - a move is refused, changing nothing, when the target year already has an
 *   import, or when a moved person is already on the target year's roster;
 * - a second registration for the same club and year is refused and says
 *   what to do;
 * - two people with the same name and section: one is skipped unless "Keep
 *   both" is sent, and "Jr." stays with the last name;
 * - a club can be imported under a company or group (#822): the preview
 *   matches a form that names the company, an existing company is linked
 *   instead of a church being created, and a school is refused.
 *
 * Creates and removes its own rows. Needs a local database with a system
 * administrator (npm run db:seed).
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
  await prisma.organization.deleteMany({ where: { type: { in: ["CHURCH", "COMPANY", "GROUP", "SCHOOL"] }, name: { startsWith: stamp } } });
}

async function main() {
  const { earlierImportNotice, parseClubRegistrationExport, splitName } = await import("../modules/club-imports/domain");
  const { confirmPayload } = await import("../modules/club-imports/confirm-payload");
  const { annotateImportDrafts, importClubs } = await import("../modules/club-imports/repository");
  const { moveImportYear, previewImportYearMove, ImportYearMoveError } = await import("../modules/club-imports/move-year");
  const { clubImportConfirmSchema } = await import("../modules/club-imports/schemas");
  const { listRoster } = await import("../modules/club-rosters/repository");
  const { syntheticExportEntry } = await import("../tests/support/club-import-fixture");

  const admin = await prisma.user.findFirst({ where: { globalRole: "SYSTEM_ADMIN" }, select: { id: true } });
  assert(admin, "needs a system administrator in the local database (npm run db:seed)");

  /** The confirm payload exactly as the preview sends it, through the same schema. */
  const itemsFor = (entry: ReturnType<typeof syntheticExportEntry>, options: { clubYear?: string; name?: string; keepBoth?: boolean } = {}) => {
    const drafts = parseClubRegistrationExport([entry], now).drafts.map((draft) => ({
      ...draft,
      clubYear: options.clubYear ?? draft.clubYear,
      clubName: options.name ?? clubName,
      churchId: null,
      newChurchName: church,
      include: true,
      people: draft.people.map((person) => ({ ...person, keepBoth: options.keepBoth ?? false })),
    }));
    return clubImportConfirmSchema.parse(confirmPayload(drafts)).clubs;
  };
  const expectRefused = async (work: () => Promise<unknown>, pattern: RegExp, message: string) => {
    try {
      await work();
    } catch (error) {
      assert(error instanceof ImportYearMoveError && error.code === "IMPORT_MOVE_CONFLICT", `${message}: refused as a conflict (${String(error)})`);
      assert(error.preview?.conflicts.length && pattern.test(JSON.stringify(error.preview.conflicts)), `${message}: lists the conflict`);
      return;
    }
    throw new Error(`FAILED: ${message}: the move was not refused`);
  };

  const expectRefusedAlreadyMoved = async (work: () => Promise<unknown>, message: string) => {
    try {
      await work();
    } catch (error) {
      // The import record is no longer in the year that was asked about.
      assert(error instanceof ImportYearMoveError && (error.code === "IMPORT_NOT_FOUND" || error.code === "IMPORT_MOVE_CONFLICT"), `${message}: refused (${String(error)})`);
      return;
    }
    throw new Error(`FAILED: ${message}: was not refused`);
  };

  try {
    const entry = syntheticExportEntry({ id: `${stamp}1` });
    const [draft] = parseClubRegistrationExport([entry], now).drafts;
    assert(draft.submittedClubYear === "2025-26" && draft.clubYear === "2026-27", "an August submission defaults to the current club year");

    // The real-world mistake: imported into 2025-26.
    const [wrong] = await importClubs(itemsFor(entry, { clubYear: "2025-26" }), admin.id, now);
    assert(wrong.status === "IMPORTED" && wrong.membersAdded === 48 && wrong.membersSkipped === 0, `wrong-year import adds all 48 (${wrong.status}, ${wrong.membersAdded})`);
    const clubId = wrong.organizationId!;
    assert((await listRoster(clubId, "2025-26", now)).length === 48, "48 on the 2025-26 roster");

    // Re-uploading now points to Move, not to importing again.
    const [reupload] = (await annotateImportDrafts(parseClubRegistrationExport([entry], now).drafts)).drafts;
    const hint = earlierImportNotice(reupload.importedYears, reupload.clubYear);
    assert(hint && !hint.blocking && /Move import to another year/.test(hint.message), "a re-upload for another year suggests the Move action");

    const peopleBefore = await prisma.person.count();
    const preview = await previewImportYearMove(clubId, "2025-26", "2026-27", now);
    assert(preview.rowsToMove === 48 && preview.peopleOnRoster === 48 && preview.conflicts.length === 0, `preview counts 48 with no conflicts (${JSON.stringify({ ...preview, conflicts: preview.conflicts.length })})`);
    assert(await prisma.person.count() === peopleBefore, "a preview changes nothing");

    const moved = await moveImportYear(clubId, "2025-26", "2026-27", admin.id, now);
    assert(moved.rowsMoved === 48, `48 rows moved, got ${moved.rowsMoved}`);
    assert(await prisma.person.count() === peopleBefore, "the move creates and deletes no Person");
    const current = await listRoster(clubId, "2026-27", now);
    assert(current.length === 48, `48 on the 2026-27 roster, got ${current.length}`);
    assert((await listRoster(clubId, "2025-26", now)).length === 0, "0 left on the 2025-26 roster");
    for (const name of ["Cy Faux", "Kim Faux", "Bo Placeholder", "Ned Testerson"]) {
      assert(current.some((member) => `${member.firstName} ${member.lastName}` === name), `${name} is listed in 2026-27`);
    }
    const identity = await prisma.externalIdentity.findFirst({ where: { organizationId: clubId, provider: "FLUENT_FORMS" }, select: { providerScope: true, displayLabel: true } });
    assert(identity?.providerScope === "form-89:2026-27" && identity.displayLabel?.includes("2026-27"), "the import record moved to 2026-27");
    const audit = await prisma.auditLog.findFirst({ where: { action: "CLUB_IMPORT_YEAR_MOVED", entityId: clubId }, select: { metadata: true, actorUserId: true } });
    assert(audit?.actorUserId === admin.id, "the move is audited");
    assert(!/Faux|Testerson|Placeholder|Hills/.test(JSON.stringify(audit.metadata)), "the audit has counts and ids only");
    assert((audit.metadata as { rowsMoved?: number }).rowsMoved === 48, "the audit counts the rows moved");

    // Re-uploading after the move: "imported for 2026-27", and nothing is added.
    const [afterMove] = (await annotateImportDrafts(parseClubRegistrationExport([entry], now).drafts)).drafts;
    const blocked = earlierImportNotice(afterMove.importedYears, afterMove.clubYear);
    assert(blocked?.blocking && /imported for 2026-27/.test(blocked.message), "re-uploading shows imported for 2026-27");
    const [again] = await importClubs(itemsFor(entry), admin.id, now);
    assert(again.status === "ALREADY_IMPORTED" && /imported for 2026-27/.test(again.message), "re-import is reported as already imported for 2026-27");
    assert((await listRoster(clubId, "2026-27", now)).length === 48 && await prisma.person.count() === peopleBefore, "re-import adds no one");

    // Refused: the target year already has an import.
    const [previous] = await importClubs(itemsFor(entry, { clubYear: "2025-26" }), admin.id, now);
    assert(previous.status === "IMPORTED" && previous.membersAdded === 48, "the entry can still be imported into 2025-26 deliberately");
    const beforeRefusal = await prisma.person.count();
    const blockedPreview = await previewImportYearMove(clubId, "2025-26", "2026-27", now);
    assert(blockedPreview.conflicts.some((conflict) => conflict.kind === "TARGET_HAS_IMPORT"), "the preview lists the existing target import");
    await expectRefused(() => moveImportYear(clubId, "2025-26", "2026-27", admin.id, now), /TARGET_HAS_IMPORT/, "moving into a year with an import");

    // Refused: a moved person is already on the target year's roster.
    const someone = await prisma.clubRosterMember.findFirst({ where: { organizationId: clubId, clubYear: "2025-26", source: "IMPORT" }, select: { personId: true, attendeeType: true } });
    await prisma.clubRosterMember.create({ data: { organizationId: clubId, clubYear: "2027-28", personId: someone!.personId, attendeeType: someone!.attendeeType, source: "DIRECTOR" } });
    await expectRefused(() => moveImportYear(clubId, "2025-26", "2027-28", admin.id, now), /ALREADY_ON_TARGET_ROSTER/, "moving someone already on the target roster");
    assert((await listRoster(clubId, "2025-26", now)).length === 48 && (await listRoster(clubId, "2027-28", now)).length === 1, "a refused move changes no roster");
    assert(await prisma.person.count() === beforeRefusal, "a refused move changes no Person");

    // A different registration for the same club and year is refused, and says what to do.
    const second = syntheticExportEntry({ id: `${stamp}2` });
    const [refused] = await importClubs(itemsFor(second), admin.id, now);
    assert(refused.status === "FAILED" && /already has a 2026-27 import\. Add the missing people on the roster, or move the earlier import to another year\./.test(refused.message), `a second registration is refused with next steps (${refused.message})`);

    // Two people with the same name and section, and a suffix.
    assert(splitName("Chris Faux Jr.").lastName === "Faux Jr.", "Jr. stays with the last name");
    const twins = syntheticExportEntry({ id: `${stamp}3` }, {
      leader_name: "Chris Faux Jr.",
      co_leader_name: "",
      other_assistants: [],
      repeater_container: [["Robin Faux", "9", "Friend"], ["Robin Faux", "12", "Explorer"]],
    });
    const [skippedTwin] = await importClubs(itemsFor(twins, { name: `${stamp} Twins Pathfinders` }), admin.id, now);
    assert(skippedTwin.membersAdded === 2 && skippedTwin.skipped.length === 1 && skippedTwin.skipped[0].reason === "DUPLICATE_IN_REGISTRATION", "a same-named youth is skipped without Keep both");
    const staffRow = (await listRoster(skippedTwin.organizationId!, "2026-27", now)).find((member) => member.firstName === "Chris");
    assert(staffRow?.lastName === "Faux Jr.", "the leader is imported as Faux Jr.");
    const bothTwins = syntheticExportEntry({ id: `${stamp}4` }, (twins.response as Record<string, unknown>));
    const [keptTwin] = await importClubs(itemsFor(bothTwins, { name: `${stamp} Keep Pathfinders`, keepBoth: true }), admin.id, now);
    assert(keptTwin.membersAdded === 3 && keptTwin.skipped.length === 0, "Keep both adds both same-named youths");

    // B1: two concurrent Moves of one import to different years. Exactly one
    // wins; the rows and the import record always end up in the same year, and
    // only one audit row is written. Repeated, since it is a race.
    for (let trial = 0; trial < 6; trial += 1) {
      const raced = syntheticExportEntry({ id: `${stamp}r${trial}` });
      const [imported] = await importClubs(itemsFor(raced, { clubYear: "2025-26", name: `${stamp} Race ${trial} Pathfinders` }), admin.id, now);
      const raceClub = imported.organizationId!;
      const settled = await Promise.allSettled([
        moveImportYear(raceClub, "2025-26", "2026-27", admin.id, now),
        moveImportYear(raceClub, "2025-26", "2027-28", admin.id, now),
      ]);
      const won = settled.filter((result) => result.status === "fulfilled");
      const lost = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      assert(won.length === 1 && lost.length === 1, `trial ${trial}: exactly one concurrent move wins (${won.length} won)`);
      assert(lost[0].reason instanceof ImportYearMoveError && lost[0].reason.code === "IMPORT_MOVE_CONFLICT", `trial ${trial}: the loser is refused with a conflict (${String(lost[0].reason)})`);
      const winnerYear = (won[0] as PromiseFulfilledResult<{ toYear: string }>).value.toYear;
      const scope = await prisma.externalIdentity.findFirst({ where: { organizationId: raceClub, provider: "FLUENT_FORMS" }, select: { providerScope: true } });
      assert(scope?.providerScope === `form-89:${winnerYear}`, `trial ${trial}: the import record is in ${winnerYear}`);
      assert((await listRoster(raceClub, winnerYear, now)).length === 48, `trial ${trial}: all 48 rows are in ${winnerYear}`);
      for (const year of ["2025-26", "2026-27", "2027-28"].filter((candidate) => candidate !== winnerYear)) {
        assert((await listRoster(raceClub, year, now)).length === 0, `trial ${trial}: no rows left in ${year}`);
      }
      assert(await prisma.auditLog.count({ where: { entityId: raceClub, action: "CLUB_IMPORT_YEAR_MOVED" } }) === 1, `trial ${trial}: one audit row`);
      // A repeat Move of the already-moved import is refused, with no second audit row.
      await expectRefusedAlreadyMoved(() => moveImportYear(raceClub, "2025-26", "2027-28", admin.id, now), `trial ${trial}: a repeat move`);
      assert(await prisma.auditLog.count({ where: { entityId: raceClub, action: "CLUB_IMPORT_YEAR_MOVED" } }) === 1, `trial ${trial}: a repeat move writes no audit row`);
    }

    // B2: a director hand-added the same child to the target year. Imports
    // create new Person rows, so only the name and section give it away.
    const handAdded = syntheticExportEntry({ id: `${stamp}h1` });
    const [handImport] = await importClubs(itemsFor(handAdded, { clubYear: "2025-26", name: `${stamp} Hand Pathfinders` }), admin.id, now);
    const handClub = handImport.organizationId!;
    const separatePerson = await prisma.person.create({ data: { firstName: "Bo", lastName: "Placeholder" }, select: { id: true } });
    await prisma.clubRosterMember.create({ data: { organizationId: handClub, clubYear: "2026-27", personId: separatePerson.id, attendeeType: "YOUTH", source: "DIRECTOR" } });
    const handPreview = await previewImportYearMove(handClub, "2025-26", "2026-27", now);
    assert(handPreview.conflicts.length === 1 && handPreview.conflicts[0].kind === "ALREADY_ON_TARGET_ROSTER" && handPreview.conflicts[0].sameName === true, `the preview lists the hand-added duplicate (${JSON.stringify(handPreview.conflicts)})`);
    await expectRefused(() => moveImportYear(handClub, "2025-26", "2026-27", admin.id, now), /ALREADY_ON_TARGET_ROSTER/, "moving over a hand-added same-name person");
    assert((await listRoster(handClub, "2025-26", now)).length === 48 && (await listRoster(handClub, "2026-27", now)).length === 1, "the refused move changes no roster");
    // Staff remove the hand-added row, which clears the conflict.
    await prisma.clubRosterMember.deleteMany({ where: { personId: separatePerson.id } });
    const cleared = await moveImportYear(handClub, "2025-26", "2026-27", admin.id, now);
    assert(cleared.rowsMoved === 48, "the move goes through once the duplicate is removed");
    await prisma.person.delete({ where: { id: separatePerson.id } });

    // #822: a company or group may sponsor a club; a school may not.
    const company = await prisma.organization.create({ data: { type: "COMPANY", name: `${stamp} Youth Company`, normalizedName: `${stamp} youth company` }, select: { id: true } });
    const group = await prisma.organization.create({ data: { type: "GROUP", name: `${stamp} Fellowship Group`, normalizedName: `${stamp} fellowship group` }, select: { id: true } });
    const school = await prisma.organization.create({ data: { type: "SCHOOL", name: `${stamp} Sample School`, normalizedName: `${stamp} sample school` }, select: { id: true } });
    const churchesBefore = await prisma.organization.count({ where: { type: "CHURCH" } });
    const sponsorEntry = syntheticExportEntry({ id: `${stamp}s1` });
    const sponsorDrafts = parseClubRegistrationExport([sponsorEntry], now).drafts.map((draft) => ({ ...draft, churchName: `${stamp} Youth Company` }));
    const annotatedSponsors = await annotateImportDrafts(sponsorDrafts);
    assert(annotatedSponsors.churches.some((option) => option.id === company.id && option.type === "COMPANY") && annotatedSponsors.churches.some((option) => option.id === group.id && option.type === "GROUP"), "the picker offers companies and groups with their kind");
    assert(!annotatedSponsors.churches.some((option) => option.id === school.id), "the picker does not offer a school");
    assert(annotatedSponsors.drafts[0].churchId === company.id && annotatedSponsors.drafts[0].newChurchName === "", "a form naming a company matches the company, not a new church");
    const sponsorItems = (overrides: { churchId: string | null; newChurchName: string; name: string; id: string }) => clubImportConfirmSchema.parse(confirmPayload(
      parseClubRegistrationExport([syntheticExportEntry({ id: overrides.id })], now).drafts.map((draft) => ({
        ...draft, clubName: overrides.name, churchId: overrides.churchId, newChurchName: overrides.newChurchName, include: true,
        people: draft.people.map((person) => ({ ...person, keepBoth: false })),
      })),
    )).clubs;
    const [underCompany] = await importClubs(sponsorItems({ id: `${stamp}s1`, name: `${stamp} Company Pathfinders`, churchId: company.id, newChurchName: "" }), admin.id, now);
    assert(underCompany.status === "IMPORTED", `a club imports under a company (${underCompany.message})`);
    const companyClub = await prisma.organization.findUnique({ where: { id: underCompany.organizationId! }, select: { parentOrganizationId: true } });
    assert(companyClub?.parentOrganizationId === company.id, "the club's sponsor is the company");
    const [underGroup] = await importClubs(sponsorItems({ id: `${stamp}s2`, name: `${stamp} Group Pathfinders`, churchId: group.id, newChurchName: "" }), admin.id, now);
    assert(underGroup.status === "IMPORTED", `a club imports under a group (${underGroup.message})`);
    const [typedCompany] = await importClubs(sponsorItems({ id: `${stamp}s3`, name: `${stamp} Typed Pathfinders`, churchId: null, newChurchName: `${stamp} Youth Company` }), admin.id, now);
    assert(typedCompany.status === "IMPORTED", "a typed company name imports");
    const typedClub = await prisma.organization.findUnique({ where: { id: typedCompany.organizationId! }, select: { parentOrganizationId: true } });
    assert(typedClub?.parentOrganizationId === company.id, "a typed name that is an existing company links to it");
    assert(await prisma.organization.count({ where: { type: "CHURCH" } }) === churchesBefore, "no church was created for a company's name");
    const [underSchool] = await importClubs(sponsorItems({ id: `${stamp}s4`, name: `${stamp} School Pathfinders`, churchId: school.id, newChurchName: "" }), admin.id, now);
    assert(underSchool.status === "FAILED" && /no longer available/.test(underSchool.message), `a school is refused as a sponsor (${underSchool.message})`);
    assert(!(await prisma.organization.findFirst({ where: { name: `${stamp} School Pathfinders` } })), "no club was created under the school");

    console.log("club imports verified: wrong-year import moved to 2026-27 (48 rows, Person count unchanged, 0 left in 2025-26), re-upload reports 2026-27, conflicting moves refused, second registration refused with next steps, Keep both and Jr. handled");
  } finally {
    await cleanup(admin.id);
    await prisma.$disconnect();
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
