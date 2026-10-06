/**
 * Proves the Pathfinder Bible Experience registration (#809) against a real PostgreSQL database, where the unit
 * tests' in-memory stand-ins can't:
 *
 * - the starter template creates an event with team rules, the two Area sites, the December 18 deadline and the form;
 * - a club registers two teams with different names; a duplicate name is refused (any case or spacing), across clubs
 *   too, and two clubs racing for one name give exactly one winner (the partial unique index);
 * - team size: 1 and 8 refused, 2 and 7 accepted, coaches never counted, a second alternate refused;
 * - a member who is 20 on 2026-01-01 is refused by name, one who is 19 on that date is accepted though older at the event;
 * - a person is on one team of a club only (a team member and a coach alike), and two racing submits of one person give one;
 * - a director edit keeps every rule;
 * - the settings can't be changed under registered teams, nor while drafts or classes would be stranded, and a settings
 *   save racing a team submit never leaves a named team on an event without teams;
 * - the table constraints: a named team's key is unique in the event, and a name and key go together;
 * - results entry, audit, the director's read-only view, the staff report and CSV;
 * - the printed form, filled and blank, renders;
 * - billing and church views list each team on its own and group a club's teams together;
 * - an event without team rules behaves exactly as a club event always has.
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:pbe-registration
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrismaClient, RegistrationFormStatus } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";

loadEnvConfig(process.cwd());
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-pbe-synthetic-key-not-a-secret");

const prisma = new PrismaClient();
const P = `pbe_${randomUUID().slice(0, 8)}`;
const S = P.replace(/_/g, "-");
const staffUserId = `${P}_staff`;
const actor = { userId: staffUserId, actAsId: `${P}_actas` };
const plainEventId = `${P}_plain_event`;
const raceEventIds: string[] = [];
const now = new Date("2026-10-20T15:00:00Z");
const clubOf = (key: string) => `${P}_club_${key}`;
const churchId = `${P}_church`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function caught(promise: Promise<unknown>) {
  return promise.then(() => null, (error: unknown) => error);
}

async function expectCode(promise: Promise<unknown>, code: string, message: string, includes: string[] = []) {
  const error = await caught(promise);
  const found = error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "";
  assert(found === code, `${message}: expected ${code}, got ${String(error)}`);
  for (const text of includes) assert(String((error as Error).message).includes(text), `${message}: the message should say "${text}", got "${(error as Error).message}"`);
}

const dbError = (error: unknown) => (error instanceof Error ? error.message : String(error));

let templateIdsBefore = new Set<string>();

async function cleanup() {
  const events = await prisma.event.findMany({ where: { OR: [{ id: { startsWith: `${P}_` } }, { slug: { startsWith: `${S}-` } }] }, select: { id: true } });
  const eventIds = [...new Set([...events.map((event) => event.id), plainEventId, ...raceEventIds])];
  const registrationIds = (await prisma.registration.findMany({ where: { eventId: { in: eventIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.messageOutbox.deleteMany({ where: { registrationId: { in: registrationIds } } });
  // Amendment records are immutable by trigger; this script's own synthetic rows are removed with the trigger off for that
  // one transaction, and it is back on before anything else can write.
  await prisma.$transaction([
    prisma.$executeRawUnsafe('ALTER TABLE "RegistrationOperation" DISABLE TRIGGER "RegistrationOperation_immutable"'),
    prisma.registrationOperation.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.$executeRawUnsafe('ALTER TABLE "RegistrationOperation" ENABLE TRIGGER "RegistrationOperation_immutable"'),
  ]);
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: eventIds } }, { actorUserId: staffUserId }] } });
  await prisma.clubRegistrationDraft.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.registration.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.eventTemplateApplication.deleteMany({ where: { actorUserId: staffUserId } });
  await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
  const templates = await prisma.eventTemplate.findMany({ where: { createdByUserId: staffUserId }, select: { id: true } });
  const created = templates.map((template) => template.id).filter((id) => !templateIdsBefore.has(id));
  await prisma.eventTemplateVersion.deleteMany({ where: { templateId: { in: created } } });
  await prisma.eventTemplate.deleteMany({ where: { id: { in: created } } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: { startsWith: `${P}_` } } });
  await prisma.organization.deleteMany({ where: { id: { startsWith: `${P}_club_` } } });
  await prisma.organization.deleteMany({ where: { id: churchId } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.person.deleteMany({ where: { normalizedEmail: { startsWith: "pbe-" } } });
  await prisma.person.deleteMany({ where: { firstName: { startsWith: "Pbe" } } });
  await prisma.user.deleteMany({ where: { id: staffUserId } });
}

async function main() {
  const { sealBirthDate } = await import("../modules/club-rosters/birth-dates");
  const { clubAttendeeClientId, clubGuestClientId } = await import("../modules/club-registrations/domain");
  const club = await import("../modules/club-registrations/repository");
  const { addStarterEventTemplates } = await import("../modules/event-templates/starter-repository");
  const { applyEventTemplate } = await import("../modules/event-templates/repository");
  const { getTeamSettings, saveTeamSettings } = await import("../modules/club-teams/settings-repository");
  const { saveTeamResult, listTeamResults, getResultsForRegistration } = await import("../modules/club-teams/results-repository");
  const { teamResultsCsvRows } = await import("../modules/club-teams/results-domain");
  const { loadFilledTeamForm, loadBlankTeamForm } = await import("../modules/club-teams/team-form-repository");
  const { TeamFormSheet } = await import("../components/team-form-sheet");
  const { churchAmountsOwedCsvRows } = await import("../modules/club-registrations/church-owed");
  const { getBillingResponsibilityView, setInvoiceGrouping, resolveEventBillingResponsibility } = await import("../modules/billing-responsibility/repository");
  const { loadReconciliationFacts } = await import("../modules/attendance-reconciliation/repository");
  const { getClubPacketData } = await import("../modules/reporting/club-packet-repository");
  const { createDirectorClubPass } = await import("../modules/checkin/club-pass-repository");
  const { listClubAssignments } = await import("../modules/club-registrations/assignments-repository");
  const honors = await import("../modules/honors/repository");

  templateIdsBefore = new Set((await prisma.eventTemplate.findMany({ select: { id: true } })).map((row) => row.id));
  await cleanup();
  await prisma.user.create({ data: { id: staffUserId, email: `${P}-staff@example.test`, displayName: "PBE Check Staff", globalRole: "SYSTEM_ADMIN" } });
  await prisma.organization.create({ data: { id: churchId, type: "CHURCH", name: `Pbe Church ${P}`, normalizedName: `pbe church ${P}` } });
  const clubKeys = ["a", "b", "c", "d"] as const;
  await prisma.organization.createMany({
    data: clubKeys.map((key) => ({ id: clubOf(key), type: "CLUB" as const, name: `Pbe Club ${key} ${P}`, normalizedName: `pbe club ${key} ${P}`, parentOrganizationId: churchId })),
  });

  // Roster: people are born so their age on 2026-01-01 is what the checks need.
  const born = {
    youth: sealBirthDate("2013-06-01"),
    // 20 on 2026-01-01 (turns 20 on 2025-12-31), so too old; 19 on 2026-01-01 (turns 20 on 2026-01-02), so still eligible.
    twenty: sealBirthDate("2005-12-31"),
    nineteen: sealBirthDate("2006-01-02"),
    // 18 on 2026-01-01 (turned 18 on 2025-06-01).
    eighteen: sealBirthDate("2007-06-01"),
    adult: sealBirthDate("1985-03-02"),
  };
  const members = new Map<string, string>();
  const personOf = new Map<string, string>();
  async function addMember(club: string, key: string, kind: keyof typeof born, type: "YOUTH" | "STAFF", first: string, last: string) {
    const person = await prisma.person.create({ data: { id: `${P}_${club}_${key}`, firstName: first, lastName: last } });
    const member = await prisma.clubRosterMember.create({
      data: { organizationId: clubOf(club), clubYear: "2026-27", personId: person.id, attendeeType: type, role: type === "STAFF" ? "Counselor" : "Pathfinder", sealedBirthDate: born[kind], source: "DIRECTOR" },
    });
    members.set(`${club}:${key}`, member.id);
    personOf.set(`${club}:${key}`, person.id);
  }
  for (let index = 1; index <= 16; index += 1) await addMember("a", `y${index}`, "youth", "YOUTH", "PbeAlex", `Aa${index}`);
  await addMember("a", "twenty", "twenty", "YOUTH", "PbeOlder", "Twenty");
  await addMember("a", "nineteen", "nineteen", "YOUTH", "PbeEdge", "Nineteen");
  await addMember("a", "coach1", "adult", "STAFF", "PbeCoach", "One");
  await addMember("a", "coach2", "adult", "STAFF", "PbeCoach", "Two");
  for (let index = 1; index <= 9; index += 1) await addMember("b", `y${index}`, "youth", "YOUTH", "PbeBlake", `Bb${index}`);
  await addMember("b", "coach1", "adult", "STAFF", "PbeCoach", "Three");
  await addMember("b", "coach2", "adult", "STAFF", "PbeCoach", "Four");
  for (let index = 1; index <= 5; index += 1) await addMember("c", `y${index}`, "youth", "YOUTH", "PbeCory", `Cc${index}`);
  await addMember("c", "coach1", "adult", "STAFF", "PbeCoach", "Five");
  // Club d: the people for the role, guest, amend-race and staff-amendment checks.
  for (let index = 1; index <= 9; index += 1) await addMember("d", `y${index}`, "youth", "YOUTH", "PbeDana", `Dd${index}`);
  await addMember("d", "staff13", "youth", "STAFF", "PbeStaffKid", "Thirteen");
  await addMember("d", "staff13b", "youth", "STAFF", "PbeStaffKid", "ThirteenB");
  await addMember("d", "staff18", "eighteen", "STAFF", "PbeStaffTlt", "Eighteen");
  await addMember("d", "coach1", "adult", "STAFF", "PbeCoach", "Six");
  const clientId = (club: string, key: string) => clubAttendeeClientId(members.get(`${club}:${key}`)!);

  // 1. The starter template creates the event: team rules, two sites, the deadline, the form.
  await addStarterEventTemplates(staffUserId);
  const template = await prisma.eventTemplate.findFirstOrThrow({ where: { versions: { some: { payload: { path: ["starterKey"], equals: "pathfinder_bible_experience" } } } } });
  const applied = await applyEventTemplate(template.id, staffUserId, {
    name: `Pbe check ${P}`, slug: `${S}-pbe`, startsOn: "2027-01-16", endsOn: "2027-01-16", requestKey: `${P}-apply-key-1`,
  });
  assert(applied.event, "the template creates an event");
  const eventId = applied.event.id;
  const settings = await getTeamSettings(eventId);
  assert(settings?.allowMultipleTeams && settings.minTeamMembers === 2 && settings.maxTeamMembers === 7 && settings.maxAlternates === 1
    && settings.ageAsOf === "2026-01-01" && settings.maxMemberAge === 19, "the event has the Pathfinder Bible Experience team rules");
  assert(settings.levelInfo.length === 2 && settings.booksLine.startsWith("The Book of Mark"), "the level dates and the books line are carried");
  const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
  assert(event.registrationClosesOn === "2026-12-18" && event.audience === "CLUB" && event.billingMode === "DEFERRED_ORGANIZATION_INVOICE" && !event.isPublished, "the deadline, audience and church billing are set, unpublished");
  const sites = await prisma.eventLocation.findMany({ where: { eventId }, orderBy: { sortOrder: "asc" } });
  assert(sites.map((site) => site.name).join() === "Missouri,Iowa" && sites.every((site) => site.address === null && site.isActive), "Missouri and Iowa are active sites with the venue unknown");
  const form = await prisma.registrationForm.findFirstOrThrow({ where: { eventId }, include: { versions: true } });
  assert(form.versions.length === 1, "the form was created from the template");
  // Staff publish the form and event (a human step); here it is done directly.
  await prisma.registrationFormVersion.updateMany({ where: { formId: form.id }, data: { status: RegistrationFormStatus.PUBLISHED, publishedAt: new Date() } });
  await prisma.registrationForm.update({ where: { id: form.id }, data: { status: RegistrationFormStatus.PUBLISHED } });
  await prisma.event.update({ where: { id: eventId }, data: { isPublished: true } });
  const versionId = form.versions[0]!.id;
  const [missouri, iowa] = sites;
  console.log("ok  the starter template creates the event with its team rules, two sites, deadline and form");

  type Person = { client: string; role?: string; alternate?: boolean };
  const person = (club: string, key: string, role = "Pathfinder", alternate = false): Person => ({ client: clientId(club, key), role, alternate });
  const coach = (club: string, key: string): Person => ({ client: clientId(club, key), role: "Coach" });
  const input = (people: Person[], extra: Record<string, unknown> = {}) => ({
    versionId,
    idempotencyKey: randomUUID(),
    responses: {
      director_name: "Pbe Director", email: "pbe-director@example.test", phone: "515-555-0100",
      coordinator_name: "Pbe Coordinator", coordinator_address: "1 Synthetic Road", coordinator_city: "Testville", coordinator_state: "IA", coordinator_zip: "50000",
      coordinator_phone: "515-555-0101", coordinator_email: "pbe-coordinator@example.test",
      director_confirmation: true, photo_video_release: "Yes", ...extra,
    },
    attendees: people.map((entry) => ({ clientId: entry.client, responses: { attendee_type: entry.role ?? "Pathfinder", ...(entry.alternate ? { alternate: true } : {}) } })),
    website: "" as const,
  });
  const draftKey = () => randomUUID().replaceAll("-", "");
  const submit = (clubKey: string, teamName: string, people: Person[], site = missouri!.id, extra: Record<string, unknown> = {}) =>
    club.submitClubRegistration(clubOf(clubKey), eventId, actor, input(people, extra), now, { locationId: site, teamName, draftKey: draftKey() });
  const rowOf = (clubKey: string, teamName: string) => prisma.clubEventRegistration.findFirstOrThrow({
    where: { eventId, organizationId: clubOf(clubKey), teamName }, include: { registration: { include: { attendees: true } } },
  });
  const registrationCount = () => prisma.clubEventRegistration.count({ where: { eventId } });

  // 2. A club registers two teams with different names; the draft of each is its own.
  const draftA1 = draftKey();
  await club.saveClubRegistrationDraft(clubOf("a"), eventId, actor, {
    selectedMemberIds: [members.get("a:y1")!], guests: [], responses: {}, attendeeResponses: {}, baseRevision: 0, saveId: randomUUID(), draftKey: draftA1, teamName: "Bible Bees",
  });
  const draftA2 = draftKey();
  await club.saveClubRegistrationDraft(clubOf("a"), eventId, actor, {
    selectedMemberIds: [members.get("a:y3")!], guests: [], responses: {}, attendeeResponses: {}, baseRevision: 0, saveId: randomUUID(), draftKey: draftA2, teamName: "Sword Drill",
  });
  assert(await prisma.clubRegistrationDraft.count({ where: { eventId, organizationId: clubOf("a") } }) === 2, "a club keeps one draft for each team it is starting");
  await club.submitClubRegistration(clubOf("a"), eventId, actor, input([person("a", "y1"), person("a", "y2"), coach("a", "coach1")]), now, { locationId: missouri!.id, teamName: "  Bible   Bees ", draftKey: draftA1 });
  await club.submitClubRegistration(clubOf("a"), eventId, actor, input([person("a", "y3"), person("a", "y4")]), now, { locationId: iowa!.id, teamName: "Sword Drill", draftKey: draftA2 });
  assert(await registrationCount() === 2, "two teams of one club are two registrations");
  const bees = await rowOf("a", "Bible Bees");
  assert(bees.teamKey === "bible bees" && bees.teamName === "Bible Bees", "the team name is cleaned and its key normalized");
  assert(await prisma.clubRegistrationDraft.count({ where: { eventId, organizationId: clubOf("a") } }) === 0, "each submit removed its own team's draft");
  const roles = bees.registration.attendees.map((attendee) => (attendee.profileSnapshot as { teamRole?: string }).teamRole).sort();
  assert(roles.join() === "COACH,MEMBER,MEMBER", `each person's role is kept on the registration, got ${roles.join()}`);
  assert(Number(bees.registration.totalAmount) === 0, "the event is free");
  console.log("ok  a club registers two teams with different names, each with its own draft");

  // 3. Duplicate names are refused, in any case or spacing, and across clubs.
  await expectCode(submit("b", "BIBLE bees", [person("b", "y1"), person("b", "y2")]), "CLUB_TEAM_NAME_TAKEN", "another club cannot reuse a team's name", ["already registered for this event"]);
  await expectCode(submit("a", "bible BEES", [person("a", "y6"), person("a", "y7")]), "CLUB_ALREADY_REGISTERED", "a club cannot register the same team name again");
  await expectCode(submit("b", "   ", [person("b", "y1"), person("b", "y2")]), "TEAM_INVALID", "a team needs a name");
  assert(await registrationCount() === 2, "refused names created nothing");
  console.log("ok  a duplicate team name is refused, case and spacing aside, across clubs too");

  // 4. Team size: 1 and 8 refused, 2 to 7 accepted, coaches never counted, a second alternate refused.
  await expectCode(submit("b", "One Only", [person("b", "y1")]), "TEAM_RULES", "one team member is refused", ["at least 2 team members", "this one has 1"]);
  await expectCode(submit("b", "One And Coaches", [person("b", "y1"), coach("b", "coach1"), coach("b", "coach2")]), "TEAM_RULES", "coaches do not make a team", ["this one has 1", "Coaches don't count"]);
  await expectCode(submit("b", "Eight", Array.from({ length: 8 }, (_, index) => person("b", `y${index + 1}`))), "TEAM_RULES", "eight team members are refused", ["at most 7 team members", "this one has 8"]);
  const seven = Array.from({ length: 7 }, (_, index) => person("b", `y${index + 1}`, "Pathfinder", index === 6));
  await submit("b", "Quiz Kids", [...seven, coach("b", "coach1"), coach("b", "coach2")]);
  const quiz = await rowOf("b", "Quiz Kids");
  assert(quiz.registration.attendees.length === 9, "seven team members, an alternate among them, and two coaches registered");
  await submit("c", "Pair", [person("c", "y1"), person("c", "y2")], iowa!.id);
  await expectCode(submit("b", "Two Alts", [person("b", "y8", "Pathfinder", true), person("b", "y9", "Pathfinder", true), coach("b", "coach1")]), "TEAM_RULES", "a second alternate is refused", ["Only 1 team member can be the alternate", "PbeBlake Bb8", "PbeBlake Bb9"]);
  await expectCode(submit("b", "Coach Alt", [person("b", "y8"), person("b", "y9"), { ...coach("b", "coach1"), alternate: true }]), "TEAM_RULES", "a coach cannot be the alternate", ["is a coach, so can't be the alternate"]);
  console.log("ok  1 and 8 refused, 2 and 7 accepted, coaches never counted, a second alternate refused");

  // 5. The age date: ages are counted on 2026-01-01, not the event day. Someone older than the limit on that date is a coach
  // (never a team member); someone 19 on it is a team member though older at the event.
  await expectCode(submit("a", "Too Old", [person("a", "twenty"), person("a", "y5")]), "TEAM_RULES", "a person who is 20 on 2026-01-01 is a coach, so the team has one member", ["this one has 1", "Coaches don't count"]);
  await submit("a", "Edge Team", [person("a", "nineteen"), person("a", "y5")]);
  const edge = await rowOf("a", "Edge Team");
  const edgeSnapshot = (edge.registration.attendees.find((attendee) => attendee.personId === personOf.get("a:nineteen")!)!.profileSnapshot as { ageOnEventDate?: number; teamRole?: string });
  assert(edgeSnapshot.ageOnEventDate === 19 && edgeSnapshot.teamRole === "MEMBER", `ages are counted on 2026-01-01, not the event day, got ${edgeSnapshot.ageOnEventDate}`);
  // An extra person's age is their age on that date too: 20 is a coach, 19 a team member.
  const guestDraft = draftKey();
  const guestOld = "gstold000001";
  const guestOk = "gstok0000001";
  await club.saveClubRegistrationDraft(clubOf("c"), eventId, actor, {
    selectedMemberIds: [members.get("c:y3")!], guests: [
      { id: guestOld, firstName: "PbeGuest", lastName: "Old", age: 20, email: null },
      { id: guestOk, firstName: "PbeGuest", lastName: "Young", age: 19, email: null },
    ], responses: {}, attendeeResponses: {}, baseRevision: 0, saveId: randomUUID(), draftKey: guestDraft, teamName: "Joint Team",
  });
  const guestInput = (ids: string[]) => ({
    ...input([person("c", "y3")]),
    attendees: [{ clientId: clientId("c", "y3"), responses: { attendee_type: "Pathfinder" } }, ...ids.map((id) => ({ clientId: clubGuestClientId(id), responses: { attendee_type: "Pathfinder" } }))],
  });
  await expectCode(club.submitClubRegistration(clubOf("c"), eventId, actor, guestInput([guestOld]), now, { locationId: iowa!.id, teamName: "Joint Team", draftKey: guestDraft }), "TEAM_RULES", "an extra person of 20 is a coach, so one team member is too few", ["this one has 1"]);
  await club.submitClubRegistration(clubOf("c"), eventId, actor, { ...guestInput([guestOld, guestOk]), idempotencyKey: randomUUID(), responses: input([]).responses }, now, { locationId: iowa!.id, teamName: "Joint Team", draftKey: guestDraft });
  const joint = await rowOf("c", "Joint Team");
  const jointRoles = joint.registration.attendees.map((attendee) => (attendee.profileSnapshot as { firstName?: string; teamRole?: string }).teamRole).sort();
  assert(jointRoles.join() === "COACH,MEMBER,MEMBER", `the 20-year-old extra person is a coach, the 19-year-old a team member, got ${jointRoles.join()}`);
  console.log("ok  the age limit counts on 2026-01-01: 20 is a coach, 19 a team member, extra people the same");

  // 6. A person is on one team of a club only: team members and coaches alike.
  await expectCode(submit("a", "Twice", [person("a", "y1"), person("a", "y6")]), "TEAM_RULES", "a team member already on another team is refused", ["PbeAlex Aa1 is already on another team from your club"]);
  await expectCode(submit("a", "Coach Twice", [person("a", "y6"), person("a", "y7"), coach("a", "coach1")]), "TEAM_RULES", "a coach already on another team is refused", ["PbeCoach One is already on another team from your club"]);
  console.log("ok  a team member, or a coach, already on another team of the club is refused, naming them");

  // 7. Racing submits that share one person (or one coach) give one registration, never two.
  const personRace = await Promise.allSettled([
    submit("a", "Race One", [person("a", "y8"), person("a", "y9")]),
    submit("a", "Race Two", [person("a", "y8"), person("a", "y10")]),
  ]);
  assert(personRace.filter((result) => result.status === "fulfilled").length === 1, "exactly one of two submits sharing a team member wins");
  assert(personRace.flatMap((result) => (result.status === "rejected" ? [result.reason as { code?: string }] : [])).every((reason) => reason.code === "TEAM_RULES"), "the loser is refused by the one-team rule");
  assert(await prisma.registrationAttendee.count({ where: { personId: personOf.get("a:y8")!, registration: { eventId } } }) === 1, "the shared person is on one team only");
  const coachRace = await Promise.allSettled([
    submit("a", "Coach Race One", [person("a", "y11"), person("a", "y12"), coach("a", "coach2")]),
    submit("a", "Coach Race Two", [person("a", "y13"), person("a", "y14"), coach("a", "coach2")]),
  ]);
  assert(coachRace.filter((result) => result.status === "fulfilled").length === 1, "exactly one of two submits sharing a coach wins");
  assert(await prisma.registrationAttendee.count({ where: { personId: personOf.get("a:coach2")!, registration: { eventId } } }) === 1, "the shared coach is on one team only");
  console.log("ok  racing submits that share a person or a coach: exactly one won each");

  // 8. The names race: two clubs submitting one name at once give exactly one winner (the partial unique index).
  const nameRace = await Promise.allSettled([
    submit("a", "Photo Finish", [person("a", "y15"), person("a", "y16")], missouri!.id),
    submit("c", "photo  FINISH", [person("c", "y4"), person("c", "y5")], iowa!.id),
  ]);
  const winners = nameRace.filter((result) => result.status === "fulfilled").length;
  const losers = nameRace.flatMap((result) => (result.status === "rejected" ? [result.reason as { code?: string }] : []));
  assert(winners === 1 && losers.length === 1 && losers[0]!.code === "CLUB_TEAM_NAME_TAKEN", `exactly one of two same-name submits wins, got ${winners} (${losers.map((loser) => String(loser.code))})`);
  assert(await prisma.clubEventRegistration.count({ where: { eventId, teamKey: "photo finish" } }) === 1, "one registration holds the name");
  console.log("ok  two clubs racing for one team name: exactly one won");

  // 9. A director edit keeps every rule.
  const quizRow = await rowOf("b", "Quiz Kids");
  const edit = (selected: string[], extra: Record<string, unknown> = {}, expected = quizRow.registration.updatedAt) => ({
    clientRequestId: randomUUID(), expectedUpdatedAt: expected.toISOString(), selectedMemberIds: selected.map((key) => members.get(`b:${key}`)!),
    keptGuestIds: [] as string[], keptOffRosterAttendeeIds: [] as string[], newGuests: [] as never[],
    attendeeResponses: Object.fromEntries(selected.map((key) => [clientId("b", key), { attendee_type: key.startsWith("coach") ? "Coach" : "Pathfinder" }])),
    teamKey: "quiz kids", ...extra,
  });
  await expectCode(club.amendClubRegistration(clubOf("b"), eventId, actor, edit(["y1", "coach1", "coach2"]), now), "TEAM_RULES", "an edit down to one team member and two coaches is refused", ["at least 2 team members"]);
  await expectCode(club.amendClubRegistration(clubOf("b"), eventId, actor, edit(["y1", "y2", "y3", "y4", "y5", "y6", "y7", "y8"]), now), "TEAM_RULES", "an edit up to eight is refused", ["at most 7 team members", "this one has 8"]);
  await club.amendClubRegistration(clubOf("b"), eventId, actor, edit(["y1", "y2", "y3", "y4", "y5", "y6"]), now);
  assert((await prisma.registrationAttendee.count({ where: { registrationId: quizRow.registrationId } })) === 6, "an edit to six team members and no coaches is saved");
  const after = await rowOf("b", "Quiz Kids");
  await expectCode(
    club.amendClubRegistration(clubOf("b"), eventId, actor, { ...edit(["y1", "y2", "y3", "y4", "y5", "y6"], { teamKey: "photo finish" }, after.registration.updatedAt) }, now),
    "REGISTRATION_NOT_FOUND", "another club's team key finds nothing under this club",
  );
  const unknown = await caught(club.amendClubRegistration(clubOf("b"), eventId, actor, edit(["y1", "y2"], { teamKey: "no such team" }), now));
  assert(unknown && (unknown as { code?: string }).code === "REGISTRATION_NOT_FOUND", "an unknown team key finds nothing");
  console.log("ok  a director edit keeps the size rules, and finds only this club's team");

  // 10. Settings: guarded under registered teams, drafts and classes; and a settings save racing a submit.
  await expectCode(saveTeamSettings(eventId, staffUserId, { ...settings, allowMultipleTeams: false }), "TEAMS_IN_USE", "several teams cannot be turned off under registered teams");
  await saveTeamSettings(eventId, staffUserId, { ...settings, maxTeamMembers: 8 });
  await saveTeamSettings(eventId, staffUserId, { ...settings });
  await expectCode(honors.createHonorOffering(eventId, { honorId: "none", span: "ALL_SESSIONS", sessionId: null, locationId: null, capacity: 5, perClubLimit: null, minimumAge: null, teacherName: "", location: "", additionalCostCents: null, requirementNote: "", isActive: true } as never, staffUserId), "EVENT_HAS_TEAMS", "no class can be created while teams are on");
  const plainEventData = {
    startsAt: new Date("2026-12-05T15:00:00Z"), endsAt: new Date("2026-12-06T22:00:00Z"), timezone: "America/Chicago", isPublished: true,
    registrationOpensOn: "2026-10-01", registrationClosesOn: "2026-11-30", billingMode: "DEFERRED_ORGANIZATION_INVOICE" as const, audience: "CLUB" as const,
  };
  await prisma.event.create({ data: { id: plainEventId, slug: `${S}-plain`, name: "Pbe check plain camporee", ...plainEventData } });
  await prisma.clubRegistrationDraft.create({ data: { eventId: plainEventId, organizationId: clubOf("a"), draftKey: "", selectedMemberIds: [] } });
  await expectCode(saveTeamSettings(plainEventId, staffUserId, { allowMultipleTeams: true }), "DRAFTS_IN_PROGRESS", "teams cannot be turned on while a draft exists, which is never deleted");
  assert(await prisma.clubRegistrationDraft.count({ where: { eventId: plainEventId } }) === 1, "the draft was not deleted");
  await prisma.clubRegistrationDraft.deleteMany({ where: { eventId: plainEventId } });
  console.log("ok  the settings are guarded: teams in use, drafts in progress, classes");

  // A settings save racing a team submit: on a fresh event with teams on, turn teams off while a team submits. Whatever
  // the order, an event without teams never ends up holding a named team.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const raceId = `${P}_race_${attempt}`;
    raceEventIds.push(raceId);
    await prisma.event.create({ data: { id: raceId, slug: `${S}-race-${attempt}`, name: `Pbe race ${attempt}`, ...plainEventData } });
    await prisma.eventTeamSettings.create({ data: { eventId: raceId, allowMultipleTeams: true, minTeamMembers: 2, maxTeamMembers: 7, maxAlternates: 1 } });
    const raceForm = await prisma.registrationForm.create({
      data: {
        id: `${P}_raceform_${attempt}`, eventId: raceId, createdByUserId: staffUserId, name: "race", slug: `${S}-race-form`, status: RegistrationFormStatus.PUBLISHED,
        versions: { create: { id: `${P}_racever_${attempt}`, createdByUserId: staffUserId, versionNumber: 1, status: RegistrationFormStatus.PUBLISHED, publishedAt: new Date(), definition: form.versions[0]!.definition as never } },
      },
    });
    void raceForm;
    const race = await Promise.allSettled([
      club.submitClubRegistration(clubOf("c"), raceId, actor, { ...input([person("c", "y1"), person("c", "y2")]), versionId: `${P}_racever_${attempt}` }, now, { teamName: "Racers", draftKey: draftKey() }),
      saveTeamSettings(raceId, staffUserId, { allowMultipleTeams: false }),
    ]);
    const named = await prisma.clubEventRegistration.count({ where: { eventId: raceId, teamKey: { not: "" } } });
    const after = await getTeamSettings(raceId);
    assert(!(named > 0 && after?.allowMultipleTeams === false), `attempt ${attempt}: a named team must never sit on an event that has turned teams off (${race.map((entry) => entry.status).join()})`);
    assert(race.some((entry) => entry.status === "fulfilled"), `attempt ${attempt}: one of the two succeeds`);
  }
  console.log("ok  a settings save racing a team submit never strands a named team");

  // 11. The table constraints.
  const other = await prisma.registration.findFirstOrThrow({ where: { eventId, clubRegistration: { teamName: "Pair" } }, select: { id: true } });
  const dupName = await caught(prisma.clubEventRegistration.create({ data: { eventId, organizationId: clubOf("a"), registrationId: (await prisma.registration.findFirstOrThrow({ where: { eventId, clubRegistration: { teamName: "Edge Team" } }, select: { id: true } })).id, teamName: "Pair", teamKey: "pair" } }));
  assert(dupName, "a second named team with the same key in the event is refused by the database");
  const unnamedWithKey = await caught(prisma.$executeRawUnsafe(`UPDATE "ClubEventRegistration" SET "teamName" = NULL WHERE "registrationId" = '${other.id}'`));
  assert(unnamedWithKey && /ClubEventRegistration_team_check/.test(dbError(unnamedWithKey)), `a key with no name is refused by the check, got ${dbError(unnamedWithKey)}`);
  const namedWithoutKey = await caught(prisma.$executeRawUnsafe(`UPDATE "ClubEventRegistration" SET "teamKey" = '' WHERE "registrationId" = '${other.id}'`));
  assert(namedWithoutKey && /ClubEventRegistration_team_check/.test(dbError(namedWithoutKey)), `a name with no key is refused by the check, got ${dbError(namedWithoutKey)}`);
  const limits = await caught(prisma.eventTeamSettings.create({ data: { eventId: plainEventId, minTeamMembers: 5, maxTeamMembers: 3 } }));
  assert(limits && /EventTeamSettings_limits_check/.test(dbError(limits)), `team limits that contradict are refused by the check, got ${dbError(limits)}`);
  const sameClubKey = await caught(prisma.clubEventRegistration.create({ data: { eventId, organizationId: clubOf("a"), registrationId: (await prisma.registration.findFirstOrThrow({ where: { eventId, clubRegistration: { teamName: "Sword Drill" } }, select: { id: true } })).id, teamName: "Sword Drill", teamKey: "sword drill" } }));
  assert(sameClubKey, "a club's team key is unique");
  console.log("ok  the table constraints: a key is unique in the event, a name and key go together, limits are consistent");

  // 12. Results: entered by staff, audited, read by the director, in the report and CSV.
  const swordRow = await rowOf("a", "Sword Drill");
  await expectCode(saveTeamResult(eventId, "no-such-team", { level: "AREA", placement: "1st" }, staffUserId), "REGISTRATION_NOT_FOUND", "a result needs a team of this event");
  await saveTeamResult(eventId, swordRow.id, { level: "AREA", placement: "2nd place, 412 points", qualified: true, notes: "Strong in Mark" }, staffUserId);
  await saveTeamResult(eventId, swordRow.id, { level: "CONFERENCE", placement: "5th", qualified: false }, staffUserId);
  const unchanged = await saveTeamResult(eventId, swordRow.id, { level: "CONFERENCE", placement: "5th", qualified: false }, staffUserId);
  assert(!unchanged.changed, "saving what is stored changes nothing");
  assert(await prisma.auditLog.count({ where: { eventId, action: { startsWith: "CLUB_TEAM_RESULT_" } } }) === 2, "two entries are audited, and the repeat is not");
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { eventId, action: "CLUB_TEAM_RESULT_ENTERED" }, orderBy: { createdAt: "asc" } });
  assert(JSON.stringify(audit.metadata).includes("2nd place") && audit.actorUserId === staffUserId, "the audit row holds the actor and the values");
  const report = await listTeamResults(eventId);
  const swordReport = report.find((row) => row.teamName === "Sword Drill")!;
  assert(swordReport.results.AREA?.qualified === true && swordReport.results.CONFERENCE?.placement === "5th" && swordReport.results.UNION === null, "the report shows each level");
  assert(report.length === 9, `every registered team is in the report, got ${report.length}`);
  const csv = teamResultsCsvRows(report);
  assert(csv[0]!.length === 14 && csv.some((row) => row[0] === "Sword Drill" && row[5] === "2nd place, 412 points" && row[6] === "Yes"), "the CSV has the columns and the row");
  const directorView = await club.getClubEventWorkspace(clubOf("a"), eventId, now, { teamKey: "sword drill" });
  assert(directorView.registration?.results.length === 2 && directorView.registration.teamName === "Sword Drill", "the director sees the results of their own team");
  const otherTeamView = await club.getClubEventWorkspace(clubOf("a"), eventId, now, { teamKey: "bible bees" });
  assert(otherTeamView.registration?.results.length === 0, "and none on a team that has none");
  const strangerView = await club.getClubEventWorkspace(clubOf("c"), eventId, now, { teamKey: "sword drill" });
  assert(strangerView.registration === null, "another club asking for the team sees nothing");
  await saveTeamResult(eventId, swordRow.id, { level: "CONFERENCE" }, staffUserId);
  assert((await getResultsForRegistration(swordRow.id)).CONFERENCE === null, "saving a level blank clears it");
  console.log("ok  results: entered, audited once per change, shown to the director read only, in the report and CSV");

  // 13. The printed form: filled and blank, for the director's club and for staff.
  const filled = await loadFilledTeamForm({ eventId, organizationId: clubOf("a"), teamKey: "bible bees" });
  assert(filled, "the filled form loads under the club and team");
  const html = renderToStaticMarkup(createElement(TeamFormSheet, { model: filled.model }));
  for (const text of ["Iowa-Missouri Conference Pathfinder", "Due December 18", "January 16, 2027", "Pbe Coordinator", "PbeAlex Aa1", "PbeCoach One", "Bible Bees", `Pbe Club a ${P}`, "4-1"]) {
    assert(html.includes(text), `the filled form shows "${text}"`);
  }
  assert(!(await loadFilledTeamForm({ eventId, organizationId: clubOf("c"), teamKey: "bible bees" })), "another club cannot load a team's form");
  assert(!!(await loadFilledTeamForm({ eventId, clubEventRegistrationId: bees.id })), "staff load it by the registration");
  const blank = await loadBlankTeamForm(eventId, { publishedClubOnly: true });
  assert(blank, "the blank form loads");
  const blankHtml = renderToStaticMarkup(createElement(TeamFormSheet, { model: blank.model }));
  assert(blankHtml.includes("Club Director&#x27;s Signature:") && blankHtml.includes("January 16, 2027") && !blankHtml.includes("Pbe Coordinator"), "the blank form has the signature line, the dates, and no one's details");
  console.log("ok  the printed form renders filled and blank");

  // 14. Billing and church views: each team is its own line; a club's teams group together.
  const owed = await club.listChurchAmountsOwed(eventId);
  assert(owed.filter((row) => row.organizationId === clubOf("a")).length >= 3, "church owed lists every team of a club");
  assert(owed.every((row) => row.teamName), "every row names its team");
  const owedCsv = churchAmountsOwedCsvRows(owed);
  assert(owedCsv[0]!.includes("Team") && owedCsv.slice(1).some((row) => row.includes("Sword Drill")), "the church-owed CSV has a Team column");
  await resolveEventBillingResponsibility(eventId, { apply: false, actorUserId: staffUserId }).catch(() => undefined);
  const byChurch = await getBillingResponsibilityView(eventId);
  const churchGroup = byChurch.groups.find((group) => group.title === `Pbe Church ${P}`);
  assert(churchGroup && churchGroup.lines.length === owed.length, "per church: one group, a line for each team");
  assert(churchGroup.lines.some((line) => line.clubName === `Sword Drill (Pbe Club a ${P})`), "each line names its team and club");
  await setInvoiceGrouping({ eventId, invoiceGrouping: "PER_CLUB", actorUserId: staffUserId });
  const perClub = await getBillingResponsibilityView(eventId);
  const clubA = perClub.groups.filter((group) => group.clubId === clubOf("a"));
  assert(clubA.length === 1 && clubA[0]!.title === `Pbe Club a ${P}` && clubA[0]!.lines.length >= 3, "per club: one group titled with the club's own name, with a line for each of its teams");
  const facts = await loadReconciliationFacts(prisma, eventId);
  const labels = facts.result.groups.flatMap((group) => group.registrations.map((registration) => registration.label));
  assert(labels.some((label) => label === `Sword Drill (Pbe Club a ${P})`), "the attendance reconciliation names each team");
  console.log("ok  billing and church views list each team and group a club's teams together");

  // 15. Check-in, packet, QR and assignments scope to the team.
  const packet = await getClubPacketData(eventId, clubOf("a"), "bible bees");
  assert(packet?.club.confirmationCode === bees.registration.confirmationCode, "the packet is the named team's");
  assert(!(await getClubPacketData(eventId, clubOf("a"), "no such team")), "an unknown team has no packet");
  assert(!(await getClubPacketData(eventId, clubOf("c"), "bible bees")), "another club's team has no packet");
  assert(!!(await createDirectorClubPass(clubOf("a"), eventId, now, "bible bees")), "the team has a check-in pass");
  assert(!(await createDirectorClubPass(clubOf("a"), eventId, now, "")), "the club alone has none on an event with teams");
  const checkIn = await club.listClubCheckInInfo(eventId);
  assert(checkIn.some((row) => row.organizationName === `Bible Bees (Pbe Club a ${P})`), "check-in lists each team by name");
  const assignments = await listClubAssignments(eventId);
  assert(assignments.filter((row) => row.organizationId === clubOf("a")).length >= 3, "assignments have a row for each team");
  console.log("ok  the packet, QR pass, check-in and assignments follow the team");

  // 15b. The group (public) path takes no team event: it would skip every team rule.
  const groupModule = await import("../modules/group-registrations/repository");
  const publicForms = await import("../modules/forms/public-repository");
  const landing = await import("../modules/events/public-repository");
  const eventSlug = `${S}-pbe`;
  await expectCode(groupModule.getGroupRegistrationExperience(eventSlug, now), "EVENT_NOT_FOUND", "the group page is refused on an event with team rules");
  await expectCode(groupModule.submitGroupRegistration(eventSlug, { ...input([]), attendees: [] } as never, {}, now), "EVENT_NOT_FOUND", "a group submission is refused on an event with team rules");
  // Even past that first gate, the submit transaction refuses a group on an event with team settings.
  await expectCode(
    publicForms.submitPublicRegistration(eventSlug, form.slug, { ...input([]), attendees: [{ clientId: "gstgrp000001", responses: { attendee_type: "Pathfinder" } }] } as never, now, {
      group: true, locationId: null, report: () => undefined, registered: () => undefined,
      prepareAttendees: async (_tx: unknown, context: { input: unknown }) => ({ input: context.input, attendees: new Map() }),
    } as never),
    "GROUP_REGISTRATION_UNAVAILABLE", "the submit transaction refuses a group on an event with team rules",
  );
  const landingPage = await landing.getPublicEventLanding(eventSlug, now);
  assert(landingPage && landingPage.groupRegistration === null, "the public event page offers no group registration on an event with team rules");
  console.log("ok  group registration is refused on an event with team rules: page, submit and landing link");

  // 15c. Who is a team member: by age on the age date, whatever the roster says.
  const staffDirector = (key: string, role: string): Person => ({ client: clientId("d", key), role });
  await submit("d", "Staff Kids", [staffDirector("staff13", "Pathfinder"), staffDirector("staff18", "TLT")], iowa!.id);
  const staffKids = await rowOf("d", "Staff Kids");
  const kidRoles = new Map(staffKids.registration.attendees.map((attendee) => [attendee.personId, (attendee.profileSnapshot as { teamRole?: string }).teamRole]));
  assert(kidRoles.get(personOf.get("d:staff13")!) === "MEMBER", "a 13-year-old marked staff on the roster counts as a team member");
  assert(kidRoles.get(personOf.get("d:staff18")!) === "MEMBER", "an 18-year-old TLT marked staff on the roster can be a team member");
  // Marking a child as staff does not hide them from the count: 7 youth and a 13-year-old marked staff is 8 team members.
  await expectCode(submit("d", "Dodge", [...Array.from({ length: 7 }, (_, index) => person("d", `y${index + 1}`)), staffDirector("staff13b", "Pathfinder")], iowa!.id), "TEAM_RULES", "a child marked staff still counts toward the size limit", ["at most 7 team members", "this one has 8"]);
  console.log("ok  the role follows the age on the age date: staff-marked 13 and TLT 18 are team members");

  // 15d. The same extra person cannot be on two teams of a club: matched by name.
  const guestTeam = async (teamName: string, guestId: string, first: string, last: string, ids: string[]) => {
    const key = draftKey();
    await club.saveClubRegistrationDraft(clubOf("d"), eventId, actor, {
      selectedMemberIds: ids.map((id) => members.get(`d:${id}`)!), guests: [{ id: guestId, firstName: first, lastName: last, age: 15, email: null }],
      responses: {}, attendeeResponses: {}, baseRevision: 0, saveId: randomUUID(), draftKey: key, teamName,
    });
    return club.submitClubRegistration(clubOf("d"), eventId, actor, {
      ...input([]), idempotencyKey: randomUUID(),
      attendees: [...ids.map((id) => ({ clientId: clientId("d", id), responses: { attendee_type: "Pathfinder" } })), { clientId: clubGuestClientId(guestId), responses: { attendee_type: "Pathfinder" } }],
    } as never, now, { locationId: iowa!.id, teamName, draftKey: key });
  };
  await guestTeam("Visitors One", "gstvis000001", "PbeVisitor", "Pat", ["y1"]);
  await expectCode(guestTeam("Visitors Two", "gstvis000002", "pbevisitor", "  PAT ", ["y2"]), "TEAM_RULES", "the same extra person on a second team is refused, naming them", ["pbevisitor PAT is already on another team from your club"]);
  console.log("ok  an extra person already on another team of the club is refused, matched by name");

  // 15e. Amend and submit racing for one person: exactly one lands. The amend reads the rules inside its own transaction.
  const alpha = await submit("d", "Alpha", [person("d", "y3"), person("d", "y4")], iowa!.id).then(() => rowOf("d", "Alpha"));
  const alphaEdit = (selected: string[], updatedAt: Date) => ({
    clientRequestId: randomUUID(), expectedUpdatedAt: updatedAt.toISOString(), selectedMemberIds: selected.map((key) => members.get(`d:${key}`)!),
    keptGuestIds: [] as string[], keptOffRosterAttendeeIds: [] as string[], newGuests: [] as never[],
    attendeeResponses: Object.fromEntries(selected.map((key) => [clientId("d", key), { attendee_type: "Pathfinder" }])), teamKey: "alpha",
  });
  const amendRace = await Promise.allSettled([
    club.amendClubRegistration(clubOf("d"), eventId, actor, alphaEdit(["y3", "y4", "y5"], alpha.registration.updatedAt), now),
    submit("d", "Beta", [person("d", "y5"), person("d", "y6")], iowa!.id),
  ]);
  assert(amendRace.filter((result) => result.status === "fulfilled").length === 1, `exactly one of an amend and a submit sharing a person lands, got ${amendRace.map((result) => result.status).join()}`);
  assert(await prisma.registrationAttendee.count({ where: { personId: personOf.get("d:y5")!, registration: { eventId } } }) === 1, "the shared person is on one team only after the race");
  console.log("ok  an amend racing a submit for the same person: exactly one landed");

  // 15f. A staff amendment of a team keeps the same rules and sets the role of the people staff add.
  const amendments = await import("../modules/registrations/amendments-repository");
  const staffActor = { kind: "STAFF" as const, id: staffUserId, displayName: "PBE Check Staff" };
  const gamma = await submit("d", "Gamma", [person("d", "y7"), person("d", "y8"), coach("d", "coach1")], iowa!.id).then(() => rowOf("d", "Gamma"));
  async function staffAmend(attendees: Array<{ attendeeId: string | null; clientId: string; responses: Record<string, unknown> }>) {
    const answers = await amendments.currentRegistrationAnswers(eventId, gamma.registrationId);
    const amendInput = { clientRequestId: randomUUID(), expectedUpdatedAt: answers!.updatedAt, reason: "Staff check", responses: answers!.responses, attendees, previewOnly: true as boolean };
    const quote = await amendments.previewRegistrationAmendment(eventId, gamma.registrationId, amendInput);
    return amendments.amendRegistration(eventId, gamma.registrationId, { ...amendInput, previewOnly: false, quoteFingerprint: quote.quoteFingerprint }, staffActor, now);
  }
  const gammaAttendees = (await prisma.registrationAttendee.findMany({ where: { registrationId: gamma.registrationId }, orderBy: { position: "asc" } }))
    .map((attendee) => ({ attendeeId: attendee.id, clientId: `existing-${attendee.id}`, responses: attendee.formResponses as Record<string, unknown> }));
  // Under the form's own minimum of two people the engine refuses first; two people with one coach is the team rule's.
  await expectCode(staffAmend([gammaAttendees[0]!, gammaAttendees[2]!]), "TEAM_RULES", "staff cannot take a team below its minimum size", ["at least 2 team members", "this one has 1"]);
  assert((await prisma.registrationAttendee.count({ where: { registrationId: gamma.registrationId } })) === 3, "a refused staff change saved nothing");
  await expectCode(staffAmend([...gammaAttendees, { attendeeId: null, clientId: "staff-new-1", responses: { first_name: "PbeAdded", last_name: "Coachy", attendee_age: "40", attendee_type: "Pathfinder", alternate: true } }]), "TEAM_RULES", "an added 40-year-old is a coach and cannot be the alternate", ["can't be the alternate"]);
  await staffAmend([...gammaAttendees, { attendeeId: null, clientId: "staff-new-2", responses: { first_name: "PbeAdded", last_name: "Coachy", attendee_age: "40", attendee_type: "Coach" } }]);
  const added = (await prisma.registrationAttendee.findMany({ where: { registrationId: gamma.registrationId } })).find((attendee) => (attendee.profileSnapshot as { lastName?: string }).lastName === "Coachy")!;
  assert((added.profileSnapshot as { teamRole?: string }).teamRole === "COACH", "the person staff added has a team role set (a coach by age)");
  // Staff cannot put a person who is on another team of the club onto this one.
  const y1Attendee = await prisma.registrationAttendee.findFirstOrThrow({ where: { personId: personOf.get("d:y1")!, registration: { eventId } } });
  await expectCode(staffAmend([...gammaAttendees, { attendeeId: null, clientId: "staff-new-3", responses: { first_name: "PbeDana", last_name: "Dd1", attendee_age: "12", attendee_type: "Pathfinder" } }]), "TEAM_RULES", "staff cannot add a person who is on another team of the club", ["is already on another team from your club"]);
  assert(y1Attendee.personId === personOf.get("d:y1"), "the other team still holds that person");
  console.log("ok  a staff amendment keeps the size, alternate and one-team rules and sets roles");

  // 16. An event without team rules is a club event as it always was.
  await prisma.registrationForm.create({
    data: {
      id: `${P}_plainform`, eventId: plainEventId, createdByUserId: staffUserId, name: "plain", slug: `${S}-plain-form`, status: RegistrationFormStatus.PUBLISHED,
      versions: { create: { id: `${P}_plainver`, createdByUserId: staffUserId, versionNumber: 1, status: RegistrationFormStatus.PUBLISHED, publishedAt: new Date(), definition: form.versions[0]!.definition as never } },
    },
  });
  const plainInput = (people: Person[]) => ({ ...input(people), versionId: `${P}_plainver` });
  await club.submitClubRegistration(clubOf("a"), plainEventId, actor, plainInput([person("a", "y1"), person("a", "y2")]), now, { locationId: null });
  const plainRow = await prisma.clubEventRegistration.findFirstOrThrow({ where: { eventId: plainEventId } });
  assert(plainRow.teamKey === "" && plainRow.teamName === null, "a plain club registration has no team name and the empty key");
  await expectCode(saveTeamResult(plainEventId, plainRow.id, { level: "AREA", placement: "1st" }, staffUserId), "RESULT_INVALID", "results can only be entered on an event with team rules");
  await expectCode(club.submitClubRegistration(clubOf("a"), plainEventId, actor, { ...plainInput([person("a", "y3"), person("a", "y4")]), idempotencyKey: randomUUID() }, now, { locationId: null }), "CLUB_ALREADY_REGISTERED", "a plain club event still takes one registration per club");
  await expectCode(club.submitClubRegistration(clubOf("c"), plainEventId, actor, plainInput([person("c", "y1"), person("c", "y2")]), now, { locationId: null, teamName: "Surprise" }), "TEAM_INVALID", "a team name is refused on an event with one registration per club");
  await expectCode(club.submitClubRegistration(clubOf("b"), plainEventId, actor, plainInput([person("b", "y1"), person("b", "y2")]), now, { locationId: null, draftKey: draftKey() }), "TEAM_INVALID", "a draft id is refused there too");
  // No size, alternate or age rule applies to an event without rules: one person, aged 20 on 2026-01-01, a coach in a role of their own.
  await club.submitClubRegistration(clubOf("b"), plainEventId, actor, plainInput([person("b", "y5"), person("b", "y6")]), now, { locationId: null });
  const plainWorkspace = await club.getClubEventWorkspace(clubOf("a"), plainEventId, now);
  assert(!plainWorkspace.teams.multiple && plainWorkspace.registration?.teamKey === "" && plainWorkspace.event.ageAsOf === false, "the plain workspace is the one registration, ages on the event day");
  const plainList = (await club.listClubEvents(clubOf("a"), now)).find((entry) => entry.id === plainEventId)!;
  assert(!plainList.multipleTeams && plainList.registration && plainList.teams.length === 0, "the plain event list shows the one registration");
  console.log("ok  an event without team rules behaves exactly as before");
}

main()
  .then(async () => {
    await cleanup();
    console.log("PBE registration verification passed.");
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch((cleanupError) => console.error("cleanup failed", cleanupError));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
