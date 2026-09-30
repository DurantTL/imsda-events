/**
 * Proves "Group" registration on a club event (#650) against a real PostgreSQL
 * database: people who are not in a club register through one contact and go
 * through the same server-owned pricing, ages, location seats and class seats
 * clubs do. Checks that a group is never attributable to a club or church and
 * creates no roster members; that the contact is recorded as the billing party;
 * that class seats are shared with clubs under concurrent saves (a club and a
 * group racing for the last seat, exactly one wins; several groups racing for
 * two seats, exactly two win); that a group is its own "club" for per-club
 * limits; that location seats hold under concurrent group submits; and that the
 * contact can reopen and change the registration, with ages, seats and class
 * picks re-validated and a change that would break a pick refused.
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:group-registration
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { PrismaClient, RegistrationFormStatus } from "@prisma/client";

loadEnvConfig(process.cwd());

// Cleanup turns the immutability trigger on RegistrationOperation off for one transaction, so this
// only ever runs against a local or CI database, never a shared or production one.
const databaseHost = (() => {
  try { return new URL(process.env.DATABASE_URL ?? "").hostname; } catch { return ""; }
})();
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(databaseHost)) {
  console.error(`Refusing to run: DATABASE_URL points at "${databaseHost || "nothing"}", not a local or CI database.`);
  process.exit(1);
}

const prisma = new PrismaClient();
const P = "grp";
const staffUserId = `${P}_staff`;
const eventId = `${P}_event`;
const formSlug = `${P}-club-form`;
const formVersionId = `${P}_formver_1`;
const eventSlug = `${P}-event`;
const clubId = `${P}_club`;
const october = new Date("2026-10-15T15:00:00Z");
const lateTier = new Date("2026-11-05T15:00:00Z");
const afterClose = new Date("2026-12-02T15:00:00Z");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function caught(promise: Promise<unknown>) {
  return promise.then(() => null, (error: unknown) => error);
}

async function expectCode(promise: Promise<unknown>, code: string, message: string) {
  const error = await caught(promise);
  assert(
    error && typeof error === "object" && "code" in error && (error as { code: string }).code === code,
    `${message}: expected ${code}, got ${String(error)}`,
  );
}

async function cleanup() {
  const registrationIds = (await prisma.registration.findMany({ where: { eventId }, select: { id: true } })).map((row) => row.id);
  await prisma.messageOutbox.deleteMany({ where: { registrationId: { in: registrationIds } } });
  await prisma.$transaction([
    prisma.$executeRawUnsafe('ALTER TABLE "RegistrationOperation" DISABLE TRIGGER "RegistrationOperation_immutable"'),
    prisma.registrationOperation.deleteMany({ where: { eventId } }),
    prisma.$executeRawUnsafe('ALTER TABLE "RegistrationOperation" ENABLE TRIGGER "RegistrationOperation_immutable"'),
  ]);
  await prisma.honorEnrollment.deleteMany({ where: { eventId } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId }, { actorUserId: staffUserId }] } });
  await prisma.groupEventRegistration.deleteMany({ where: { eventId } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId } });
  await prisma.registration.deleteMany({ where: { eventId } });
  await prisma.honorOffering.deleteMany({ where: { eventId } });
  await prisma.honorSession.deleteMany({ where: { eventId } });
  await prisma.honor.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.event.deleteMany({ where: { id: eventId } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: clubId } });
  await prisma.organization.deleteMany({ where: { id: clubId } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.person.deleteMany({ where: { normalizedEmail: { startsWith: `${P}-` } } });
  await prisma.person.deleteMany({ where: { firstName: { startsWith: "Grp" } } });
  await prisma.user.deleteMany({ where: { id: staffUserId } });
}

const field = (id: string, key: string, label: string, type: string, scope: "ATTENDEE" | "REGISTRATION", required = false, extra: Record<string, unknown> = {}) => (
  { id: `${P}_${id}`, key, label, helpText: "", type, scope, required, options: [], ...extra }
);

async function main() {
  // Imported after the environment is set, so the server env sees it.
  const { registrationFormDefinitionSchema } = await import("../modules/forms/definition");
  const locations = await import("../modules/event-locations/repository");
  const group = await import("../modules/group-registrations/repository");
  const { estimateFromPricing } = await import("../modules/group-registrations/domain");
  const { lineItemsFromPricingSnapshot, currentPricingSnapshot } = await import("../modules/club-registrations/per-person-price");
  const { getClassSelectionWorkspace, setClassSelections, setGroupClassSelections, ClassSelectionError } = await import("../modules/honors/enrollment-repository");
  const { issueRegistrationAccessToken } = await import("../modules/public-access/repository");

  await cleanup();
  await prisma.user.create({ data: { id: staffUserId, email: `${P}-staff@example.test`, displayName: "Group Check Staff", globalRole: "SYSTEM_ADMIN" } });
  await prisma.organization.create({ data: { id: clubId, type: "CLUB", name: "Grp Check Club", normalizedName: "grp check club" } });
  await prisma.event.create({
    data: {
      id: eventId, slug: eventSlug, name: "Group check weekend", startsAt: new Date("2026-12-05T15:00:00Z"), endsAt: new Date("2026-12-06T22:00:00Z"),
      timezone: "America/Chicago", isPublished: true, registrationOpensOn: "2026-10-01", registrationClosesOn: "2026-11-30",
      billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB",
    },
  });
  const definition = registrationFormDefinitionSchema.parse({
    title: "Group check club registration",
    description: "Fictitious club form.",
    confirmationMessage: "Registered.",
    attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Person", addButtonLabel: "Add" },
    sections: [
      { id: `${P}_club`, title: "Club", description: "", fields: [
        field("club", "club_name", "Club", "SELECT", "REGISTRATION", true, { optionSource: "CLUBS_DIRECTORY" }),
        field("church", "church_name", "Church", "SELECT", "REGISTRATION", true, { optionSource: "CHURCHES_DIRECTORY" }),
      ] },
      { id: `${P}_contact`, title: "Contact", description: "", fields: [
        field("c_first", "primary_contact_first_name", "First name", "TEXT", "REGISTRATION", true),
        field("c_last", "primary_contact_last_name", "Last name", "TEXT", "REGISTRATION", true),
        field("c_email", "email", "Email", "EMAIL", "REGISTRATION", true),
      ] },
      { id: `${P}_roster`, title: "People", description: "", fields: [
        field("a_first", "first_name", "First name", "TEXT", "ATTENDEE", true),
        field("a_last", "last_name", "Last name", "TEXT", "ATTENDEE", true),
        field("a_age", "attendee_age", "Age", "NUMBER", "ATTENDEE", true),
        field("a_fee", "registration_fee", "Registration fee", "CALCULATED", "ATTENDEE", false, {
          priceCents: 2500, latePricing: { startsOn: "2026-11-01", label: "Late registration pricing", priceCents: 3500 },
        }),
      ] },
    ],
  });
  await prisma.registrationForm.create({
    data: {
      id: `${P}_form`, eventId, createdByUserId: staffUserId, name: definition.title, slug: formSlug, status: RegistrationFormStatus.PUBLISHED,
      versions: { create: { id: formVersionId, createdByUserId: staffUserId, versionNumber: 1, status: RegistrationFormStatus.PUBLISHED, publishedAt: new Date(), definition } },
    },
  });
  const siteA = await locations.createEventLocation(eventId, staffUserId, { name: "Group Site A", capacity: 40 });
  const siteB = await locations.createEventLocation(eventId, staffUserId, { name: "Group Site B", capacity: 3 });

  // Classes. No site, so every location offers them. The minimum-age class and the seat races use separate offerings.
  const session = await prisma.honorSession.create({ data: { eventId, name: "Sabbath", normalizedName: "sabbath" } });
  const session2 = await prisma.honorSession.create({ data: { eventId, name: "Sunday", normalizedName: "sunday", sortOrder: 1 } });
  const session3 = await prisma.honorSession.create({ data: { eventId, name: "Monday", normalizedName: "monday", sortOrder: 2 } });
  for (const [key, name] of [["race", "Race Honor"], ["limit", "Limit Honor"], ["age", "Age Honor"], ["pool", "Pool Honor"]]) {
    await prisma.honor.create({ data: { id: `${P}_honor_${key}`, code: `GRP-${key.toUpperCase()}`, name, normalizedName: name.toLowerCase() } });
  }
  const offering = (key: string, sessionId: string, data: { capacity: number; perClubLimit?: number; minimumAge?: number }) => prisma.honorOffering.create({
    data: { id: `${P}_off_${key}`, eventId, honorId: `${P}_honor_${key}`, sessionId, span: "SINGLE_SESSION", ...data },
  });
  const raceOffering = await offering("race", session.id, { capacity: 1 });
  const limitOffering = await offering("limit", session2.id, { capacity: 20, perClubLimit: 1 });
  const ageOffering = await offering("age", session3.id, { capacity: 20, minimumAge: 10 });
  const poolOffering = await offering("pool", session.id, { capacity: 2 });
  void ageOffering;

  const base = (email: string, people: Array<{ id: string; first: string; last: string; age: string | number }>, extra: Record<string, unknown> = {}) => ({
    versionId: formVersionId,
    idempotencyKey: randomUUID(),
    responses: { primary_contact_first_name: "Grp", primary_contact_last_name: "Contact", email, ...extra },
    attendees: people.map((person) => ({
      clientId: person.id,
      responses: { first_name: person.first, last_name: person.last, attendee_age: person.age },
    })),
    website: "" as const,
  });
  const tokenOf = (confirmation: { managePath: string | null }) => {
    assert(confirmation.managePath, "a group registration returns its private manage link");
    return confirmation.managePath.replace("/manage/", "");
  };
  const regByCode = (code: string) => prisma.registration.findFirstOrThrow({
    where: { eventId, confirmationCode: code },
    select: { id: true, locationId: true, status: true, updatedAt: true, accountHolderPersonId: true, totalAmount: true },
  });

  // 1. The public page sees the form without club or church questions, and the billing words.
  const experience = await group.getGroupRegistrationExperience(eventSlug, october);
  assert(experience.experience && !experience.problem, `the event is ready for groups: ${String(experience.problem)}`);
  const visibleKeys = experience.experience.form.definition.sections.flatMap((section) => section.fields.map((entry) => entry.key));
  assert(!visibleKeys.includes("club_name") && !visibleKeys.includes("church_name"), "a group is not asked for a club or church");
  assert(visibleKeys.includes("attendee_age"), "a group is asked for each person's age");
  assert(experience.locations.length === 2 && experience.locations.every((location) => !("remaining" in location) && !("capacity" in location)), "locations show no seat counts to the public");
  assert(experience.billingNotice === "You'll be billed after the event.", "the billing notice is shown");
  console.log("ok  public page: no club or church question, locations without seat counts, billing notice");

  // 2. A real group submit: three people, one contact, at Site A, with classes.
  const first = await group.submitGroupRegistration(eventSlug, base(`${P}-contact1@example.test`, [
    { id: "p-youth-a", first: "Grp", last: "YouthA", age: 12 },
    { id: "p-youth-b", first: "Grp", last: "YouthB", age: 9 },
    { id: "p-adult", first: "Grp", last: "Adult", age: 40 },
  ]), { locationId: siteA.id, honorSelections: {} }, october);
  assert(first.confirmation.registrationStatus === "SUBMITTED", "the group is registered");
  assert("totalCents" in first.confirmation && first.confirmation.totalCents === 7500, `3 people at the early rate cost 7500, got ${String(first.confirmation.totalCents)}`);
  assert(first.confirmation.lineItems.length === 3, "the group sees its price lines (unlike a church-billed club)");
  const reg1 = await regByCode(first.confirmation.confirmationCode);
  const groupRow = await prisma.groupEventRegistration.findUniqueOrThrow({ where: { registrationId: reg1.id } });
  assert(groupRow.billingPersonId === reg1.accountHolderPersonId, "the contact is recorded as the billing party");
  assert((await prisma.clubEventRegistration.count({ where: { registrationId: reg1.id } })) === 0, "a group has no club registration");
  assert(reg1.locationId === siteA.id, "the group is at the location it picked");
  const attendees1 = await prisma.registrationAttendee.findMany({ where: { registrationId: reg1.id }, orderBy: { position: "asc" } });
  assert(attendees1.length === 3, "three people registered");
  for (const attendee of attendees1) {
    const snapshot = attendee.profileSnapshot as Record<string, unknown>;
    assert(snapshot.source === "GROUP_REGISTRATION", "attendees are marked as group people");
    assert(!("clubOrganizationId" in snapshot) && !("clubRosterMemberId" in snapshot) && !("clubGuestId" in snapshot), "no person names a club or a roster member");
    assert(typeof snapshot.ageOnEventDate === "number", "the age the server read is kept");
  }
  assert((attendees1[0].profileSnapshot as { temporaryAttendeeType: string }).temporaryAttendeeType === "YOUTH", "under 18 uses a class seat");
  assert((attendees1[2].profileSnapshot as { temporaryAttendeeType: string }).temporaryAttendeeType === "ADULT", "an adult joins without a seat");
  assert((await prisma.clubRosterMember.count({ where: { organizationId: clubId } })) === 0, "no roster member was created");
  const stored = await prisma.registration.findUniqueOrThrow({
    where: { id: reg1.id },
    select: { publicFormSubmission: { select: { responses: true } }, operations: { take: 1, select: { id: true } } },
  });
  assert(!JSON.stringify(stored.publicFormSubmission?.responses).includes("club_name"), "no club answer is stored on a group");
  const audit1 = await prisma.auditLog.findFirstOrThrow({ where: { eventId, entityId: reg1.id, action: "GROUP_REGISTRATION_SUBMITTED" } });
  assert(!JSON.stringify(audit1.metadata).includes("clubOrganizationId"), "the audit record names no club");
  const estimate = estimateFromPricing({ lineItems: lineItemsFromPricingSnapshot(currentPricingSnapshot({ publicFormSubmission: await prisma.publicRegistrationSubmission.findUnique({ where: { registrationId: reg1.id }, select: { pricingSnapshot: true } }), operations: [] })), attendeeCount: 3 });
  assert(estimate.totalCents === 7500 && estimate.perPersonCents === 2500, "the estimated total is the server's priced lines");
  // The confirmation tells the contact the truth: billed after the event, with the estimated total, no church.
  const confirmationEmail = await prisma.messageOutbox.findFirstOrThrow({ where: { registrationId: reg1.id, recipientKind: "REGISTRANT" } });
  assert(confirmationEmail.bodyTextSnapshot.includes("You'll be billed after the event"), "the confirmation email says the contact is billed after the event");
  assert(confirmationEmail.bodyTextSnapshot.includes("Estimated total: $75.00"), "the confirmation email shows the estimated total");
  assert(!/church|responsible organization/i.test(confirmationEmail.bodyTextSnapshot), "the confirmation email never mentions a church or organization");
  console.log("ok  group submit: priced, billing contact recorded, no club, no roster, no club on any person or audit record, truthful email");

  // 3. The late tier applies from its date.
  const lateGroup = await group.submitGroupRegistration(eventSlug, base(`${P}-late@example.test`, [{ id: "late-1", first: "Grp", last: "Late", age: 30 }]), { locationId: siteA.id }, lateTier);
  assert("totalCents" in lateGroup.confirmation && lateGroup.confirmation.totalCents === 3500, "the late rate applies after its start date");
  console.log("ok  early and late rates come from the server's pricing date");

  // 4. Server rules: age is required, location is required, a full/closed site is refused, forms can't smuggle a club.
  await expectCode(group.submitGroupRegistration(eventSlug, base(`${P}-noage@example.test`, [{ id: "x1", first: "Grp", last: "NoAge", age: "" }]), { locationId: siteA.id }, october), "INVALID_SUBMISSION", "a missing age is refused with the field pointed out");
  await expectCode(group.submitGroupRegistration(eventSlug, base(`${P}-age2@example.test`, [{ id: "x2", first: "Grp", last: "BadAge", age: 200 }]), { locationId: siteA.id }, october), "GROUP_ATTENDEES_INVALID", "an impossible age is refused");
  await expectCode(group.submitGroupRegistration(eventSlug, base(`${P}-noloc@example.test`, [{ id: "x3", first: "Grp", last: "NoLoc", age: 20 }]), {}, october), "LOCATION_REQUIRED", "a location is required when the event has locations");
  await expectCode(group.submitGroupRegistration(eventSlug, base(`${P}-dup@example.test`, [{ id: "same", first: "Grp", last: "One", age: 20 }, { id: "same", first: "Grp", last: "Two", age: 20 }]), { locationId: siteA.id }, october), "GROUP_ATTENDEES_INVALID", "duplicate person ids are refused");
  await expectCode(group.submitGroupRegistration(eventSlug, base(`${P}-closed@example.test`, [{ id: "x5", first: "Grp", last: "Late", age: 20 }]), { locationId: siteA.id }, afterClose), "REGISTRATION_CLOSED", "a closed event is refused");
  // A club or church answer is not a question a group is asked, so sending one is refused outright.
  await expectCode(
    group.submitGroupRegistration(eventSlug, base(`${P}-smuggle@example.test`, [{ id: "s1", first: "Grp", last: "Smuggle", age: 25 }], { club_name: clubId, church_name: "Some Church" }), { locationId: siteA.id }, october),
    "INVALID_SUBMISSION",
    "a club or church answer sent by a group is refused",
  );
  assert((await prisma.registration.count({ where: { eventId, accountHolderPerson: { normalizedEmail: `${P}-smuggle@example.test` } } })) === 0, "a refused group registration leaves nothing behind");
  assert((await prisma.clubEventRegistration.count({ where: { eventId } })) === 0, "no club registration exists for this event");
  console.log("ok  server rules: age required, location required, closed refused, club answers refused");

  // 5. Replays: the same submission key returns the same registration, takes no second seat.
  const replayInput = base(`${P}-replay@example.test`, [{ id: "r1", first: "Grp", last: "Replay", age: 30 }]);
  const replayA = await group.submitGroupRegistration(eventSlug, replayInput, { locationId: siteA.id }, october);
  const replayB = await group.submitGroupRegistration(eventSlug, replayInput, { locationId: siteA.id }, october);
  assert(replayA.confirmation.confirmationCode === replayB.confirmation.confirmationCode, "a retried submit returns the same registration");
  assert((await prisma.registration.count({ where: { eventId, confirmationCode: replayA.confirmation.confirmationCode } })) === 1, "a retried submit creates nothing new");
  console.log("ok  a retried submit is an idempotent replay");

  // 6. Classes: age rules, per-group limit as its own club, shared seats.
  const reg1Workspace = await group.getGroupRegistrationWorkspace(tokenOf(first.confirmation), october);
  assert(reg1Workspace, "the contact's page loads from the private link");
  const [youthA, youthB, adult] = reg1Workspace.registration.attendees.map((attendee) => attendee.attendeeId);
  const pick = (attendeeId: string, offeringIds: string[], at = october) => setGroupClassSelections(reg1.id, eventId, { groupContactPersonId: reg1.accountHolderPersonId }, { [attendeeId]: offeringIds }, at);
  await expectCode(pick(youthB, [`${P}_off_age`]), "SELECTION_INVALID", "a 9-year-old cannot take a class for ages 10 and up");
  await pick(youthA, [`${P}_off_age`, poolOffering.id]);
  await pick(youthA, [`${P}_off_age`, poolOffering.id, limitOffering.id]);
  await expectCode(pick(youthB, [limitOffering.id]), "CLUB_LIMIT_REACHED", "a group's second youth hits the per-group limit, as a club's would");
  await pick(adult, [limitOffering.id]);
  assert(!(await prisma.honorEnrollment.findFirstOrThrow({ where: { registrationAttendeeId: adult } })).consumesSeat, "an adult in a class uses no seat");
  const enrollments1 = await prisma.honorEnrollment.findMany({ where: { registrationId: reg1.id } });
  assert(enrollments1.length > 0 && enrollments1.every((row) => row.organizationId === null), "a group's class seats name no club");
  // A second group, and a club, each get their own limit of 1.
  const second = await group.submitGroupRegistration(eventSlug, base(`${P}-contact2@example.test`, [
    { id: "g2-a", first: "Grp", last: "TwoA", age: 11 },
  ]), { locationId: siteA.id, honorSelections: { "g2-a": [limitOffering.id] } }, october);
  assert(second.honors && "saved" in second.honors && second.honors.saved === 1, `classes chosen while registering are saved: ${JSON.stringify(second.honors)}`);
  console.log("ok  classes: minimum age, per-group limit (its own club), adults take no seat, no club on any seat");

  // 7. Shared seats under concurrent saves: a club and a group race for the last seat of a class.
  const clubHolder = await prisma.person.create({ data: { id: `${P}_club_holder`, firstName: "Grp", lastName: "ClubHolder" } });
  const clubRegistration = await prisma.registration.create({
    data: { eventId, accountHolderPersonId: clubHolder.id, confirmationCode: "REG-GRPCLUB", status: "SUBMITTED", totalAmount: 0, submittedAt: october, locationId: siteA.id },
  });
  await prisma.clubEventRegistration.create({ data: { eventId, organizationId: clubId, registrationId: clubRegistration.id } });
  const clubPerson = await prisma.person.create({ data: { id: `${P}_club_kid`, firstName: "Grp", lastName: "ClubKid" } });
  const clubMember = await prisma.clubRosterMember.create({
    data: { organizationId: clubId, clubYear: "2026-27", personId: clubPerson.id, attendeeType: "YOUTH", source: "DIRECTOR" },
  });
  const clubAttendee = await prisma.registrationAttendee.create({
    data: {
      eventId, registrationId: clubRegistration.id, personId: clubPerson.id, attendeeType: "YOUTH", position: 0,
      profileSnapshot: { firstName: "Grp", lastName: "ClubKid", ageOnEventDate: 12, clubRosterMemberId: clubMember.id },
    },
  });
  const raceGroup = await group.submitGroupRegistration(eventSlug, base(`${P}-race@example.test`, [{ id: "race-1", first: "Grp", last: "Racer", age: 12 }]), { locationId: siteA.id }, october);
  const raceReg = await regByCode(raceGroup.confirmation.confirmationCode);
  const raceAttendee = await prisma.registrationAttendee.findFirstOrThrow({ where: { registrationId: raceReg.id } });
  const raceResults = await Promise.allSettled([
    setClassSelections(clubId, eventId, { accountId: "director-grp" }, { [clubAttendee.id]: [raceOffering.id] }, october),
    setGroupClassSelections(raceReg.id, eventId, { groupContactPersonId: raceReg.accountHolderPersonId }, { [raceAttendee.id]: [raceOffering.id] }, october),
  ]);
  const won = raceResults.filter((result) => result.status === "fulfilled").length;
  const lost = raceResults.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert(won === 1 && lost.length === 1, `a club and a group racing for the last seat: exactly one wins, got ${won}`);
  assert(lost[0].reason instanceof ClassSelectionError && lost[0].reason.code === "CLASS_FULL", `the loser is told the class is full: ${String(lost[0].reason)}`);
  assert((await prisma.honorEnrollment.count({ where: { offeringId: raceOffering.id, consumesSeat: true } })) === 1, "exactly one seat is held");
  console.log("ok  a club and a group racing for the last class seat: exactly one wins");

  // Several groups racing for two seats: exactly two win.
  const pool = [];
  for (let index = 0; index < 4; index += 1) {
    const submitted = await group.submitGroupRegistration(eventSlug, base(`${P}-pool${index}@example.test`, [{ id: `pool-${index}`, first: "Grp", last: `Pool${index}`, age: 13 }]), { locationId: siteA.id }, october);
    const registration = await regByCode(submitted.confirmation.confirmationCode);
    const person = await prisma.registrationAttendee.findFirstOrThrow({ where: { registrationId: registration.id } });
    pool.push({ registration, attendeeId: person.id });
  }
  const poolResults = await Promise.allSettled(pool.map(({ registration, attendeeId }) => (
    setGroupClassSelections(registration.id, eventId, { groupContactPersonId: registration.accountHolderPersonId }, { [attendeeId]: [poolOffering.id] }, october)
  )));
  const poolWon = poolResults.filter((result) => result.status === "fulfilled").length;
  const poolSeats = await prisma.honorEnrollment.count({ where: { offeringId: poolOffering.id, consumesSeat: true } });
  // youthA from the first group already holds one pool seat.
  assert(poolSeats === 2, `the two-seat class never holds more than two seats, found ${poolSeats}`);
  assert(poolWon === 1, `one seat was left for four racing groups, exactly one wins, got ${poolWon}`);
  assert(poolResults.filter((result) => result.status === "rejected").every((result) => (result as PromiseRejectedResult).reason instanceof ClassSelectionError), "losers are told the class is full");
  console.log("ok  four groups racing for the last seat of a shared class: exactly one wins, capacity never exceeded");

  // The same group saving two youth into a per-group limit of 1 at once: one wins.
  const twin = await group.submitGroupRegistration(eventSlug, base(`${P}-twin@example.test`, [
    { id: "twin-a", first: "Grp", last: "TwinA", age: 14 }, { id: "twin-b", first: "Grp", last: "TwinB", age: 14 },
  ]), { locationId: siteA.id }, october);
  const twinReg = await regByCode(twin.confirmation.confirmationCode);
  const twinPeople = await prisma.registrationAttendee.findMany({ where: { registrationId: twinReg.id }, orderBy: { position: "asc" } });
  const twinResults = await Promise.allSettled(twinPeople.map((person) => (
    setGroupClassSelections(twinReg.id, eventId, { groupContactPersonId: twinReg.accountHolderPersonId }, { [person.id]: [limitOffering.id] }, october)
  )));
  assert(twinResults.filter((result) => result.status === "fulfilled").length === 1, "two saves by one group into a per-group limit of 1: exactly one wins");
  assert((await prisma.honorEnrollment.count({ where: { registrationId: twinReg.id, offeringId: limitOffering.id, consumesSeat: true } })) === 1, "the group holds one limited seat");
  console.log("ok  a group's per-group limit holds under concurrent saves");

  // 8. Location seats under concurrent group submits: Site B holds 3, two groups of 2 race.
  const siteRace = await Promise.allSettled([
    group.submitGroupRegistration(eventSlug, base(`${P}-siteb1@example.test`, [{ id: "b1a", first: "Grp", last: "B1A", age: 20 }, { id: "b1b", first: "Grp", last: "B1B", age: 20 }]), { locationId: siteB.id }, october),
    group.submitGroupRegistration(eventSlug, base(`${P}-siteb2@example.test`, [{ id: "b2a", first: "Grp", last: "B2A", age: 20 }, { id: "b2b", first: "Grp", last: "B2B", age: 20 }]), { locationId: siteB.id }, october),
  ]);
  assert(siteRace.filter((result) => result.status === "fulfilled").length === 1, "two groups of 2 racing for 3 seats: exactly one wins");
  const siteLoser = siteRace.find((result): result is PromiseRejectedResult => result.status === "rejected")!;
  assert((siteLoser.reason as { code?: string }).code === "LOCATION_FULL", `the loser is told the location is full: ${String(siteLoser.reason)}`);
  const siteSeats = await prisma.registrationAttendee.count({ where: { registration: { locationId: siteB.id, status: { in: ["SUBMITTED", "CONFIRMED"] } } } });
  assert(siteSeats === 2, `Site B holds 2 of 3 seats, found ${siteSeats}`);
  console.log("ok  location seats: two groups racing for the last seats, exactly one wins");

  // 9. The contact reopens and changes the registration.
  const token = tokenOf(first.confirmation);
  const before = await group.getGroupRegistrationWorkspace(token, october);
  assert(before && before.event.edit.open, "the registration can be reopened while registration is open");
  const keep = (index: number, age?: number) => {
    const person = before.registration.attendees[index];
    return { attendeeId: person.attendeeId, responses: { ...person.responses, ...(age === undefined ? {} : { attendee_age: age }) } };
  };
  const edit = (attendees: Array<{ attendeeId: string | null; clientId?: string; responses: Record<string, unknown> }>, updatedAt = before.registration.updatedAt, extra: Record<string, unknown> = {}) => ({
    clientRequestId: randomUUID(), expectedUpdatedAt: updatedAt, attendees, ...extra,
  });
  await expectCode(group.amendGroupRegistration(token, edit([keep(0), keep(1), keep(2)], "2026-01-01T00:00:00.000Z"), october), "REGISTRATION_CHANGED", "a stale edit is refused");
  // An age change that puts a child under a class's minimum age is refused, and nothing is saved.
  await expectCode(group.amendGroupRegistration(token, edit([keep(0, 8), keep(1), keep(2)]), october), "CLASS_PICKS_CONFLICT", "an age below a picked class's minimum is refused");
  assert((await regByCode(first.confirmation.confirmationCode)).updatedAt.getTime() === reg1.updatedAt.getTime(), "a refused edit saved nothing");
  // An age change that flips the seat type of someone holding a seat is refused too.
  await expectCode(group.amendGroupRegistration(token, edit([keep(0, 19), keep(1), keep(2)]), october), "CLASS_PICKS_CONFLICT", "an age that changes seat use needs the classes removed first");
  // A harmless age change keeps the picks.
  const aged = await group.amendGroupRegistration(token, edit([keep(0, 13), keep(1), keep(2)]), october);
  assert(aged.result.attendeeCount === 3, "an age change keeps everyone");
  // Add a person: priced by the server, a new person holds no class.
  const afterAge = await group.getGroupRegistrationWorkspace(token, october);
  assert(afterAge, "workspace reloads");
  const keepNow = (index: number) => ({ attendeeId: afterAge.registration.attendees[index].attendeeId, responses: afterAge.registration.attendees[index].responses });
  const added = await group.amendGroupRegistration(token, edit([keepNow(0), keepNow(1), keepNow(2), { attendeeId: null, clientId: "added-1", responses: { first_name: "Grp", last_name: "Added", attendee_age: 7 } }], afterAge.registration.updatedAt), october);
  assert(added.result.attendeeCount === 4 && added.result.totalCents === 10000, `a fourth person is priced by the server: ${JSON.stringify(added.result)}`);
  const operation = await prisma.registrationOperation.findFirstOrThrow({ where: { registrationId: reg1.id, type: "AMENDMENT" }, orderBy: { createdAt: "desc" } });
  assert(operation.actorPersonId === reg1.accountHolderPersonId && operation.actorUserId === null && operation.actorAttendeeAccountId === null, "the edit is recorded against the contact, not a user or account");
  // Removing a person who holds a seat frees it.
  const afterAdd = await group.getGroupRegistrationWorkspace(token, october);
  assert(afterAdd, "workspace reloads");
  const seatsBefore = await prisma.honorEnrollment.count({ where: { offeringId: poolOffering.id, consumesSeat: true } });
  const withoutA = afterAdd.registration.attendees.filter((_, index) => index !== 0).map((person) => ({ attendeeId: person.attendeeId, responses: person.responses }));
  await group.amendGroupRegistration(token, edit(withoutA, afterAdd.registration.updatedAt), october);
  const seatsAfter = await prisma.honorEnrollment.count({ where: { offeringId: poolOffering.id, consumesSeat: true } });
  assert(seatsAfter === seatsBefore - 1, `removing a person frees their class seat (${seatsBefore} to ${seatsAfter})`);
  // The contact can correct a kept person's name: same person, same class picks and seats, audited.
  const workspaceNow = await group.getGroupRegistrationWorkspace(token, october);
  assert(workspaceNow, "workspace reloads");
  const holders = new Set((await prisma.honorEnrollment.findMany({ where: { registrationId: reg1.id }, select: { registrationAttendeeId: true } })).map((row) => row.registrationAttendeeId));
  const targetIndex = workspaceNow.registration.attendees.findIndex((person) => holders.has(person.attendeeId));
  assert(targetIndex >= 0, "someone on the registration holds a class pick");
  const target = workspaceNow.registration.attendees[targetIndex]!;
  const picksBefore = await prisma.honorEnrollment.count({ where: { registrationAttendeeId: target.attendeeId } });
  assert(picksBefore > 0, "the person being renamed holds a class pick");
  const renamed = workspaceNow.registration.attendees.map((person, index) => ({
    attendeeId: person.attendeeId, responses: index === targetIndex ? { ...person.responses, first_name: "Corrected", last_name: "Spelling" } : person.responses,
  }));
  await group.amendGroupRegistration(token, edit(renamed, workspaceNow.registration.updatedAt), october);
  const afterRename = await group.getGroupRegistrationWorkspace(token, october);
  assert(afterRename, "workspace reloads after the rename");
  assert(afterRename.registration.attendees[targetIndex]!.attendeeId === target.attendeeId, "a renamed person is the same person on the registration");
  assert(afterRename.registration.attendees[targetIndex]!.firstName === "Corrected" && afterRename.registration.attendees[targetIndex]!.lastName === "Spelling", "the corrected name is saved");
  assert((await prisma.honorEnrollment.count({ where: { registrationAttendeeId: target.attendeeId } })) === picksBefore, "a rename keeps the person's class picks and seats");
  const renameAudit = await prisma.auditLog.findFirstOrThrow({ where: { eventId, action: "REGISTRATION_AMENDED", entityType: "RegistrationOperation" }, orderBy: { createdAt: "desc" } });
  assert((renameAudit.metadata as { rosterNameUpdatedCount?: number }).rosterNameUpdatedCount === 1, "the rename is counted in the audit record");
  assert(!JSON.stringify(renameAudit.metadata).includes("Corrected"), "the audit record keeps names out");
  // A blank name is refused, and nothing is saved.
  const blank = afterRename.registration.attendees.map((person, index) => ({ attendeeId: person.attendeeId, responses: index === targetIndex ? { ...person.responses, first_name: "" } : person.responses }));
  await expectCode(group.amendGroupRegistration(token, edit(blank, afterRename.registration.updatedAt), october), "ATTENDEES_INVALID", "a blank name is refused");
  // A location move to a full site is refused.
  await expectCode(
    group.amendGroupRegistration(token, edit(afterRename.registration.attendees.map((person) => ({ attendeeId: person.attendeeId, responses: person.responses })), afterRename.registration.updatedAt, { locationId: siteB.id }), october),
    "LOCATION_CAPACITY_UNAVAILABLE",
    "moving to a site without room is refused",
  );
  // After registration closes, the contact can't change it.
  await expectCode(
    group.amendGroupRegistration(token, edit(afterRename.registration.attendees.map((person) => ({ attendeeId: person.attendeeId, responses: person.responses })), afterRename.registration.updatedAt), afterClose),
    "REGISTRATION_CLOSED",
    "a closed registration can't be changed by the contact",
  );
  console.log("ok  contact edits: stale/invalid/closed refused, ages and seat use re-validated, people added, removed and renamed, recorded against the contact");

  // 10. A link is only ever a group's own: a club's link can't be used here, and another group's link sees only its own registration.
  const clubToken = (await issueRegistrationAccessToken(prisma, { registrationId: clubRegistration.id, now: october })).token;
  assert((await group.getGroupRegistrationWorkspace(clubToken, october)) === null, "a club registration's link opens no group page");
  await expectCode(group.amendGroupRegistration(clubToken, edit([keepNow(0)]), october), "REGISTRATION_NOT_FOUND", "a club's link can't amend through the group path");
  const otherToken = tokenOf(second.confirmation);
  const otherWorkspace = await group.getGroupRegistrationWorkspace(otherToken, october);
  assert(otherWorkspace && otherWorkspace.registration.attendees.length === 1 && otherWorkspace.registration.confirmationCode !== first.confirmation.confirmationCode, "another group's link shows only its own registration");
  console.log("ok  links: a club's link opens no group page; a group's link reaches only its own registration");

  // 11. Cancelling a group gives its class seats back, like a club.
  await prisma.registration.update({ where: { id: raceReg.id }, data: { status: "CANCELLED" } });
  const club = await getClassSelectionWorkspace(clubId, eventId, october);
  const raceSeats = club.offerings.find((row) => row.id === raceOffering.id)!.seatsTaken;
  const heldByClub = await prisma.honorEnrollment.count({ where: { offeringId: raceOffering.id, registrationId: clubRegistration.id, consumesSeat: true } });
  assert(raceSeats === heldByClub, `a cancelled group's seat is free again (${raceSeats} vs ${heldByClub})`);
  console.log("ok  a cancelled group gives its class seats back");
}

main()
  .then(() => console.log("Group registration verification passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
