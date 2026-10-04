/**
 * Proves declared guardian authority (#131, narrow slice) against a real PostgreSQL database, where the
 * unit tests' in-memory stand-in can't:
 *
 * - a registration with a minor records the registrant's choice as one ACTIVE declaration (who, when,
 *   through the registration form, for this event and registration); a submit with no choice, an adult who
 *   is not on the registration, or another minor is refused and leaves no registration behind;
 * - nothing is inferred: household membership (with canManage), a shared surname, a shared email, and being
 *   the account holder create no declaration, and a minor registered without one is listed for staff;
 * - the database enforces the shape: one ACTIVE row per (event, minor) even under parallel writes, a row is
 *   never edited or deleted (only ACTIVE -> SUPERSEDED or REVOKED), an adult who is not on the registration
 *   is refused by a trigger, and foreign-key actions still work (deleting a user clears the actor, deleting
 *   the event removes every row);
 * - a minor's status is decided at the event start date (turning 18 on day two is still a minor), follows
 *   the event's age of majority, and an unknown age is not an adult;
 * - two adults claiming one minor from different registrations create a review item and replace nothing;
 *   staff can resolve it, set, change and revoke with a reason; revocation is immediate and keeps history;
 *   another event's people are refused; no audit row holds a reason or a name;
 * - the registrant's own change (private page) supersedes their earlier choice but cannot undo staff.
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:guardian-authority
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient, RegistrationFormStatus } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";
import { registrationFormDefinitionSchema } from "../modules/forms/definition";
import { submitPublicRegistration, PublicRegistrationError } from "../modules/forms/public-repository";
import {
  GuardianAuthorityError,
  declareResponsibleAdultsForRegistration,
  dismissConflict,
  getGuardianReview,
  getRegistrationResponsibleAdultView,
  recordRegistrationDeclarations,
  revokeResponsibleAdult,
  setResponsibleAdult,
} from "../modules/guardian-authority/repository";

loadEnvConfig(process.cwd());
// Local-only, before any Prisma client or connection exists.
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-guardian-authority-synthetic-key-not-a-secret");

const prisma = new PrismaClient();
const P = `ga131_${randomUUID().slice(0, 8)}`;
const surname = `Sample${P}`;
const ids = {
  staff: `${P}_staff`,
  doomed: `${P}_doomed`,
  eventA: `${P}_ev_a`,
  eventB: `${P}_ev_b`,
  form: `${P}_form`,
  formVersion: `${P}_form_v1`,
};
const formSlug = `${P}-form`;
const slugOf = (eventId: string) => `${eventId.replace(/_/g, "-")}-slug`;
const REASON = "Verify reason text that must never reach an audit row";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function rejects(promise: Promise<unknown>, pattern?: RegExp) {
  return promise.then(() => false, (error: unknown) => (pattern ? pattern.test(String(error instanceof Error ? error.message : error)) : true));
}

async function expectCode(promise: Promise<unknown>, code: string, message: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  assert(error instanceof GuardianAuthorityError && error.code === code, `${message}: expected ${code}, got ${String(error)}`);
}

async function cleanup() {
  const registrationIds = (await prisma.registration.findMany({ where: { eventId: { in: [ids.eventA, ids.eventB] } }, select: { id: true } })).map((row) => row.id);
  await prisma.messageOutbox.deleteMany({ where: { registrationId: { in: registrationIds } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: [ids.eventA, ids.eventB] } }, { actorUserId: { in: [ids.staff, ids.doomed] } }] } });
  await prisma.event.deleteMany({ where: { id: { in: [ids.eventA, ids.eventB] } } });
  await prisma.registration.deleteMany({ where: { id: { in: registrationIds } } });
  await prisma.household.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.person.deleteMany({ where: { lastName: surname } });
  await prisma.person.deleteMany({ where: { normalizedEmail: { startsWith: `${P}-` } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.staff, ids.doomed] } } });
}

const definition = registrationFormDefinitionSchema.parse({
  title: "Guardian authority verification",
  description: "Temporary fictitious form used only by the guardian authority check.",
  confirmationMessage: "Received.",
  attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 8, attendeeLabel: "Attendee", addButtonLabel: "Add another attendee" },
  sections: [
    {
      id: `${P}_contact`, title: "Contact", description: "", fields: [
        { id: `${P}_f_first`, key: "primary_contact_first_name", label: "First name", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
        { id: `${P}_f_last`, key: "primary_contact_last_name", label: "Last name", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
        { id: `${P}_f_email`, key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
      ],
    },
    {
      id: `${P}_attendees`, title: "Attendees", description: "", fields: [
        { id: `${P}_a_first`, key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: `${P}_a_last`, key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: `${P}_a_age`, key: "attendee_age", label: "Age", helpText: "", type: "NUMBER", scope: "ATTENDEE", required: false, options: [] },
        { id: `${P}_a_dob`, key: "date_of_birth", label: "Date of birth", helpText: "", type: "DATE", scope: "ATTENDEE", required: false, options: [] },
      ],
    },
  ],
});

type Attendee = { clientId: string; first: string; age?: number; dob?: string };
let submissions = 0;
/** A real public submission, through the same transaction the form uses. */
async function submit(attendees: Attendee[], responsibleAdults?: Record<string, string>, eventId = ids.eventA) {
  submissions += 1;
  const result = await submitPublicRegistration(slugOf(eventId), formSlug, {
    versionId: ids.formVersion,
    idempotencyKey: randomUUID(),
    responses: { primary_contact_first_name: "Gv", primary_contact_last_name: `Holder${submissions}`, email: `${P}-registrant-${submissions}@example.test` },
    attendees: attendees.map((attendee) => ({
      clientId: attendee.clientId,
      responses: {
        first_name: attendee.first,
        last_name: surname,
        ...(attendee.age !== undefined ? { attendee_age: String(attendee.age) } : {}),
        ...(attendee.dob ? { date_of_birth: attendee.dob } : {}),
      },
    })),
    ...(responsibleAdults ? { responsibleAdults } : {}),
    website: "",
  });
  const registration = await prisma.registration.findFirstOrThrow({
    where: { confirmationCode: result.confirmationCode, eventId },
    select: { id: true, accountHolderPersonId: true, attendees: { select: { id: true, personId: true, profileSnapshot: true } } },
  });
  const byName = (first: string) => {
    const attendee = registration.attendees.find((row) => (row.profileSnapshot as { firstName?: string }).firstName === first);
    assert(attendee, `attendee ${first} saved`);
    return attendee;
  };
  return { registration, byName };
}

async function main() {
  await cleanup();
  await prisma.user.create({ data: { id: ids.staff, email: `${P}-staff@example.test`, displayName: "Guardian Check Staff", globalRole: "SYSTEM_ADMIN" } });
  await prisma.user.create({ data: { id: ids.doomed, email: `${P}-doomed@example.test`, displayName: "Guardian Check Doomed" } });
  const year = new Date().getUTCFullYear() + 1;
  const startsAt = new Date(Date.UTC(year, 2, 5, 15, 0, 0));
  const endsAt = new Date(Date.UTC(year, 2, 7, 15, 0, 0));
  for (const id of [ids.eventA, ids.eventB]) {
    await prisma.event.create({ data: { id, slug: slugOf(id), name: `Guardian Check ${id}`, startsAt, endsAt, timezone: "America/Chicago", isPublished: true, audience: "GENERAL", billingMode: "ATTENDEE_PAY" } });
  }
  assert((await prisma.event.findUniqueOrThrow({ where: { id: ids.eventA } })).ageOfMajority === 18, "age of majority defaults to 18");
  await prisma.registrationForm.create({
    data: {
      id: ids.form, eventId: ids.eventA, createdByUserId: ids.staff, name: definition.title, slug: formSlug, status: RegistrationFormStatus.PUBLISHED,
      versions: { create: { id: ids.formVersion, createdByUserId: ids.staff, versionNumber: 1, status: RegistrationFormStatus.PUBLISHED, publishedAt: new Date(), definition } },
    },
  });
  await prisma.registrationForm.create({
    data: {
      id: `${ids.form}_b`, eventId: ids.eventB, createdByUserId: ids.staff, name: definition.title, slug: formSlug, status: RegistrationFormStatus.PUBLISHED,
      versions: { create: { id: `${ids.formVersion}_b`, createdByUserId: ids.staff, versionNumber: 1, status: RegistrationFormStatus.PUBLISHED, publishedAt: new Date(), definition } },
    },
  });

  const activeFor = (eventId: string, minorPersonId: string) => prisma.guardianAuthority.findMany({ where: { eventId, minorPersonId, state: "ACTIVE" } });

  // ---- The registrant's declaration, through the real submit ----
  const first = await submit(
    [{ clientId: "a-dad", first: "Dan", age: 44 }, { clientId: "a-son", first: "Sam", age: 12 }, { clientId: "a-uncle", first: "Ulf", age: 40 }],
    { "a-son": "a-dad" },
  );
  const dan = first.byName("Dan");
  const sam = first.byName("Sam");
  const declared = await activeFor(ids.eventA, sam.personId);
  assert(declared.length === 1, "one ACTIVE declaration for the minor");
  assert(declared[0]!.adultPersonId === dan.personId && declared[0]!.source === "REGISTRATION_FORM" && declared[0]!.registrationId === first.registration.id && declared[0]!.eventId === ids.eventA, "the declaration names the adult, the registration, the event and the form");
  assert(declared[0]!.actorPersonId === first.registration.accountHolderPersonId && declared[0]!.declaredAt instanceof Date && declared[0]!.state === "ACTIVE", "who and when are recorded");
  assert(await prisma.guardianAuthority.count({ where: { eventId: ids.eventA, minorPersonId: { in: [dan.personId, first.byName("Ulf").personId] } } }) === 0, "no row exists for an adult");

  // ---- Refusals leave nothing behind ----
  const registrationsBefore = await prisma.registration.count({ where: { eventId: ids.eventA } });
  const refusedSubmissions: Array<[string, Attendee[], Record<string, string> | undefined]> = [
    ["no choice", [{ clientId: "a-dad", first: "Dee", age: 40 }, { clientId: "a-son", first: "Sue", age: 9 }], undefined],
    ["a blank choice", [{ clientId: "a-dad", first: "Dee", age: 40 }, { clientId: "a-son", first: "Sue", age: 9 }], { "a-son": "" } as never],
    ["an adult who is not on the registration", [{ clientId: "a-dad", first: "Dee", age: 40 }, { clientId: "a-son", first: "Sue", age: 9 }], { "a-son": "a-elsewhere" }],
    ["another minor as the adult", [{ clientId: "a-dad", first: "Dee", age: 40 }, { clientId: "a-son", first: "Sue", age: 9 }, { clientId: "a-teen", first: "Tia", age: 15 }], { "a-son": "a-teen", "a-teen": "a-dad" }],
    ["a person of unknown age as the adult", [{ clientId: "a-dad", first: "Dee" }, { clientId: "a-son", first: "Sue", age: 9 }], { "a-son": "a-dad" }],
  ];
  for (const [label, attendees, choices] of refusedSubmissions) {
    let error: unknown = null;
    try {
      await submit(attendees, choices);
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof PublicRegistrationError && error.code === "INVALID_SUBMISSION", `${label}: refused as an invalid submission`);
  }
  assert(await prisma.registration.count({ where: { eventId: ids.eventA } }) === registrationsBefore, "a refused submit leaves no registration behind");
  assert(await prisma.guardianAuthority.count({ where: { eventId: ids.eventA } }) === 1, "a refused submit leaves no declaration behind");

  // ---- Nothing is inferred ----
  // A household where everyone can manage everyone, a shared surname and a shared email, and an account holder who is
  // the only adult: registered without a declaration (as before this feature existed).
  const legacyHolder = await prisma.person.create({ data: { id: `${P}_legacy_dad`, firstName: "Larry", lastName: surname, normalizedEmail: `${P}-family@example.test` } });
  const legacyKid = await prisma.person.create({ data: { id: `${P}_legacy_kid`, firstName: "Leo", lastName: surname } });
  const legacyUncle = await prisma.person.create({ data: { id: `${P}_legacy_uncle`, firstName: "Lou", lastName: surname } });
  const household = await prisma.household.create({ data: { name: `${P}_household` } });
  await prisma.householdMember.createMany({ data: [legacyHolder, legacyKid, legacyUncle].map((person) => ({ householdId: household.id, personId: person.id, canManage: true, relationship: "family" })) });
  const legacy = await prisma.registration.create({
    data: {
      eventId: ids.eventA, accountHolderPersonId: legacyHolder.id, householdId: household.id, confirmationCode: `${P}-LEGACY`, status: "SUBMITTED", totalAmount: 0,
      attendees: {
        create: [
          { eventId: ids.eventA, personId: legacyHolder.id, attendeeType: "ATTENDEE", position: 0, profileSnapshot: { firstName: "Larry", lastName: surname, email: `${P}-family@example.test` }, formResponses: { attendee_age: "45" } },
          { eventId: ids.eventA, personId: legacyKid.id, attendeeType: "ATTENDEE", position: 1, profileSnapshot: { firstName: "Leo", lastName: surname, email: `${P}-family@example.test` }, formResponses: { attendee_age: "10" } },
        ],
      },
    },
    select: { id: true, attendees: { select: { id: true, personId: true } } },
  });
  assert(await prisma.guardianAuthority.count({ where: { minorPersonId: legacyKid.id } }) === 0, "household, canManage, surname, email and account holder create no declaration");
  let review = await getGuardianReview(ids.eventA);
  const leo = review.minors.find((minor) => minor.personId === legacyKid.id);
  assert(leo && leo.responsibleAdult === null && leo.kinds.length === 1 && leo.kinds[0] === "NOT_DECLARED", "the minor is listed for staff as having no responsible adult recorded");
  assert(!review.adults.some((adult) => adult.personId === legacyUncle.id), "a household member who is not registered is not an adult of the event");
  assert((await getRegistrationResponsibleAdultView(legacy.id))?.minors[0]?.choice === null, "the private page shows no choice recorded");
  await expectCode(prisma.$transaction((tx) => declareResponsibleAdultsForRegistration(tx, { registrationId: legacy.id, choices: {} })), "CHOICES_INVALID", "the server does not fill in a missing choice");
  assert(await prisma.guardianAuthority.count({ where: { minorPersonId: legacyKid.id } }) === 0, "a save with no choice still creates nothing");

  // ---- None of us goes to staff; a minor with no adult goes to staff ----
  const none = await submit([{ clientId: "a-dad", first: "Nate", age: 41 }, { clientId: "a-son", first: "Nia", age: 8 }], { "a-son": "NONE" });
  assert((await activeFor(ids.eventA, none.byName("Nia").personId))[0]?.adultPersonId === null, "None of us is recorded explicitly");
  const alone = await submit([{ clientId: "a-son", first: "Abe", age: 14 }], { "a-son": "NONE" });
  const unknown = await submit([{ clientId: "a-dad", first: "Una" }, { clientId: "a-adult", first: "Ada", age: 33 }]);
  review = await getGuardianReview(ids.eventA);
  const kindsOf = (personId: string) => review.items.find((item) => item.personId === personId)?.kinds ?? [];
  assert(kindsOf(none.byName("Nia").personId).join() === "NONE_OF_US", "None of us is listed");
  assert(kindsOf(alone.byName("Abe").personId).includes("NO_ADULT_ON_REGISTRATION") && kindsOf(alone.byName("Abe").personId).includes("NONE_OF_US"), "a minor on a registration with no adult is listed");
  assert(kindsOf(unknown.byName("Una").personId).join() === "UNKNOWN_AGE", "an unknown age is not an adult and is listed for staff");
  assert(!review.adults.some((adult) => adult.personId === unknown.byName("Una").personId), "an unknown age is not offered as an adult");

  // ---- Minor status at the event start date ----
  const dayTwo = new Date(Date.UTC(year - 18, 2, 6));
  const dayBefore = new Date(Date.UTC(year - 18, 2, 4));
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const birthdays = await submit(
    [{ clientId: "a-dad", first: "Bea", age: 45 }, { clientId: "a-day2", first: "Bo", dob: iso(dayTwo) }, { clientId: "a-before", first: "Bri", dob: iso(dayBefore) }],
    { "a-day2": "a-dad" },
  );
  assert(await prisma.guardianAuthority.count({ where: { minorPersonId: birthdays.byName("Bo").personId } }) === 1, "turning 18 on day two is still a minor at the start date");
  assert(await prisma.guardianAuthority.count({ where: { minorPersonId: birthdays.byName("Bri").personId } }) === 0, "turned 18 the day before the start is an adult: no responsible adult asked or recorded");
  await prisma.event.update({ where: { id: ids.eventA }, data: { ageOfMajority: 19 } });
  assert((await getGuardianReview(ids.eventA)).minors.some((minor) => minor.personId === birthdays.byName("Bri").personId), "a higher age of majority makes them a minor");
  await prisma.event.update({ where: { id: ids.eventA }, data: { ageOfMajority: 18 } });
  assert(await rejects(prisma.event.update({ where: { id: ids.eventA }, data: { ageOfMajority: 5 } }), /Event_ageOfMajority_range|check constraint/i), "the database refuses an implausible age of majority");

  // ---- Database guarantees ----
  assert(await rejects(prisma.guardianAuthority.create({ data: { eventId: ids.eventA, registrationId: first.registration.id, minorPersonId: sam.personId, adultPersonId: dan.personId, source: "REGISTRATION_FORM" } }), /unique|one_active/i), "a second ACTIVE declaration for the same minor is refused");
  assert(await rejects(prisma.guardianAuthority.update({ where: { id: declared[0]!.id }, data: { adultPersonId: first.byName("Ulf").personId } }), /not rewritten/), "a declaration is not edited");
  assert(await rejects(prisma.guardianAuthority.update({ where: { id: declared[0]!.id }, data: { declaredAt: new Date(0) } }), /not rewritten/), "its time is not edited");
  assert(await rejects(prisma.guardianAuthority.delete({ where: { id: declared[0]!.id } }), /never deleted/), "a declaration is not deleted");
  assert(await rejects(prisma.guardianAuthority.deleteMany({ where: { eventId: ids.eventA } }), /never deleted/), "a bulk delete is refused too");
  assert(await rejects(prisma.guardianAuthority.update({ where: { id: declared[0]!.id }, data: { state: "REVOKED", revokedAt: new Date(), revocationReason: "  " } }), /check|violat|not rewritten/i), "a revocation needs a reason");
  assert(await rejects(prisma.guardianAuthority.create({ data: { eventId: ids.eventA, registrationId: first.registration.id, minorPersonId: first.byName("Ulf").personId, adultPersonId: sam.personId, source: "REGISTRATION_FORM", state: "REVOKED", revokedAt: new Date(), revocationReason: "x" } }), /starts active/), "a declaration is created ACTIVE");
  const stranger = await prisma.person.create({ data: { id: `${P}_stranger`, firstName: "Stan", lastName: surname } });
  assert(await rejects(prisma.guardianAuthority.create({ data: { eventId: ids.eventA, registrationId: none.registration.id, minorPersonId: none.byName("Nate").personId, adultPersonId: stranger.id, source: "REGISTRATION_FORM" } }), /not on that registration/), "an adult who is not on the registration is refused by the database");
  assert(await rejects(prisma.guardianAuthority.create({ data: { eventId: ids.eventA, registrationId: none.registration.id, minorPersonId: stranger.id, adultPersonId: null, source: "REGISTRATION_FORM" } }), /minor is not on that registration/), "a minor who is not on the registration is refused");
  assert(await rejects(prisma.guardianAuthority.create({ data: { eventId: ids.eventB, registrationId: none.registration.id, minorPersonId: none.byName("Nia").personId, adultPersonId: null, source: "REGISTRATION_FORM" } }), /not on this event/), "a registration of another event is refused");
  assert(await rejects(prisma.guardianAuthority.create({ data: { eventId: ids.eventA, registrationId: none.registration.id, minorPersonId: none.byName("Nate").personId, adultPersonId: none.byName("Nia").personId, source: "STAFF" } }), /check|violat/i), "a staff declaration needs a reason");
  assert(await rejects(prisma.guardianAuthority.create({ data: { eventId: ids.eventB, registrationId: none.registration.id, minorPersonId: none.byName("Nia").personId, adultPersonId: stranger.id, source: "STAFF", declarationReason: "x" } }), /not on this event/), "a staff declaration cannot reach into another event");

  // ---- Parallel declarations from one registration settle to exactly one ACTIVE ----
  const parallel = await submit([{ clientId: "a-a", first: "Pam", age: 40 }, { clientId: "a-b", first: "Pat", age: 41 }, { clientId: "a-kid", first: "Pip", age: 7 }], { "a-kid": "a-a" });
  const pip = parallel.byName("Pip");
  const pam = parallel.byName("Pam");
  const pat = parallel.byName("Pat");
  await Promise.all([pam, pat, pam, pat, pam, pat].map((adult) => prisma.$transaction((tx) => recordRegistrationDeclarations(tx, {
    eventId: ids.eventA, registrationId: parallel.registration.id, actorPersonId: parallel.registration.accountHolderPersonId,
    declarations: [{ minorPersonId: pip.personId, adultPersonId: adult.personId }],
  }))));
  const parallelRows = await prisma.guardianAuthority.findMany({ where: { eventId: ids.eventA, minorPersonId: pip.personId } });
  assert(parallelRows.filter((row) => row.state === "ACTIVE").length === 1, "parallel declarations leave exactly one ACTIVE row");
  assert(parallelRows.filter((row) => row.state === "SUPERSEDED").every((row) => row.supersededById && parallelRows.some((other) => other.id === row.supersededById)), "every superseded row points at its successor");

  // ---- Two adults claiming one minor ----
  const mum = await submit([{ clientId: "a-mum", first: "Mia", age: 41 }, { clientId: "a-kid", first: "Pip2", age: 7 }], { "a-kid": "a-mum" });
  // The same child on a second registration (a split family): add the existing person to a different registration.
  await prisma.registrationAttendee.create({ data: { eventId: ids.eventA, registrationId: mum.registration.id, personId: pip.personId, attendeeType: "ATTENDEE", position: 2, profileSnapshot: { firstName: "Pip", lastName: surname }, formResponses: { attendee_age: "7" } } });
  const mumPerson = mum.byName("Mia");
  const before = (await activeFor(ids.eventA, pip.personId))[0]!;
  const claimed = await prisma.$transaction((tx) => recordRegistrationDeclarations(tx, { eventId: ids.eventA, registrationId: mum.registration.id, actorPersonId: mum.registration.accountHolderPersonId, declarations: [{ minorPersonId: pip.personId, adultPersonId: mumPerson.personId }] }));
  assert(claimed.conflicts === 1 && claimed.created === 0 && claimed.superseded === 0, "a second adult's claim is a review item, not a replacement");
  const after = await activeFor(ids.eventA, pip.personId);
  assert(after.length === 1 && after[0]!.id === before.id, "the first declaration stands untouched");
  await prisma.$transaction((tx) => recordRegistrationDeclarations(tx, { eventId: ids.eventA, registrationId: mum.registration.id, actorPersonId: mum.registration.accountHolderPersonId, declarations: [{ minorPersonId: pip.personId, adultPersonId: mumPerson.personId }] }));
  const conflicts = await prisma.guardianAuthorityConflict.findMany({ where: { eventId: ids.eventA, minorPersonId: pip.personId } });
  assert(conflicts.length === 1 && conflicts[0]!.state === "OPEN" && conflicts[0]!.existingAuthorityId === before.id, "one OPEN review item, not duplicated by a resubmission");
  review = await getGuardianReview(ids.eventA);
  assert(review.items.some((item) => item.personId === pip.personId && item.kinds.includes("CONFLICT") && item.conflicts[0]?.claimedAdultPersonId === mumPerson.personId), "the staff review lists the conflict");
  assert(await rejects(prisma.guardianAuthorityConflict.create({ data: { eventId: ids.eventA, registrationId: mum.registration.id, minorPersonId: pip.personId, claimedAdultPersonId: mumPerson.personId, existingAuthorityId: before.id } }), /unique|one_open/i), "a duplicate OPEN claim is refused by the database");
  assert(await rejects(prisma.guardianAuthorityConflict.update({ where: { id: conflicts[0]!.id }, data: { claimedAdultPersonId: pam.personId } }), /not rewritten/), "a conflict is not edited");
  assert(await rejects(prisma.guardianAuthorityConflict.delete({ where: { id: conflicts[0]!.id } }), /never deleted/), "a conflict is not deleted");

  // Staff: closing the claim keeps the adult; naming the other adult resolves and supersedes.
  const pipAttendeeOnMum = (await prisma.registrationAttendee.findFirstOrThrow({ where: { registrationId: mum.registration.id, personId: pip.personId } })).id;
  await expectCode(dismissConflict({ eventId: ids.eventB, conflictId: conflicts[0]!.id, reason: REASON, actorUserId: ids.staff }), "CONFLICT_NOT_FOUND", "another event's review item is not found");
  await expectCode(setResponsibleAdult({ eventId: ids.eventB, attendeeId: pipAttendeeOnMum, adultPersonId: mumPerson.personId, reason: REASON, actorUserId: ids.staff }), "ATTENDEE_NOT_FOUND", "another event's person is not found");
  await expectCode(setResponsibleAdult({ eventId: ids.eventA, attendeeId: pipAttendeeOnMum, adultPersonId: stranger.id, reason: REASON, actorUserId: ids.staff }), "ADULT_INVALID", "an adult not registered for the event is refused");
  await expectCode(setResponsibleAdult({ eventId: ids.eventA, attendeeId: pipAttendeeOnMum, adultPersonId: mumPerson.personId, reason: " ", actorUserId: ids.staff }), "REASON_REQUIRED", "a reason is required");
  const set = await setResponsibleAdult({ eventId: ids.eventA, attendeeId: pipAttendeeOnMum, adultPersonId: mumPerson.personId, reason: REASON, actorUserId: ids.staff });
  assert(set.supersededAuthorityId === before.id && set.resolvedConflictIds.length === 1, "staff naming the other adult supersedes and resolves the claim");
  const staffRow = (await activeFor(ids.eventA, pip.personId))[0]!;
  assert(staffRow.adultPersonId === mumPerson.personId && staffRow.source === "STAFF" && staffRow.actorUserId === ids.staff && staffRow.declarationReason === REASON, "the staff declaration names who, why and which adult");
  assert((await prisma.guardianAuthorityConflict.findUniqueOrThrow({ where: { id: conflicts[0]!.id } })).state === "RESOLVED", "the review item is resolved");
  assert(await rejects(prisma.guardianAuthorityConflict.update({ where: { id: conflicts[0]!.id }, data: { state: "OPEN", resolvedAt: null, resolvedByUserId: null, resolutionReason: null } }), /not rewritten|check|violat/i), "a resolved item is not reopened");
  const previous = await prisma.guardianAuthority.findUniqueOrThrow({ where: { id: before.id } });
  assert(previous.state === "SUPERSEDED" && previous.supersededById === staffRow.id && previous.adultPersonId === before.adultPersonId, "the earlier declaration is kept as history");

  // The registrant cannot undo a staff decision from the private page.
  await prisma.$transaction((tx) => declareResponsibleAdultsForRegistration(tx, { registrationId: parallel.registration.id, choices: {} }));
  assert((await activeFor(ids.eventA, pip.personId))[0]!.id === staffRow.id, "a registrant's save leaves a staff decision alone");
  const viewAfterStaff = await getRegistrationResponsibleAdultView(parallel.registration.id);
  assert(viewAfterStaff?.minors.find((minor) => minor.attendeeId === parallel.byName("Pip").id)?.lockedByStaff === true, "the private page shows a staff decision as locked");

  // The registrant's own change supersedes their earlier choice (and keeps it).
  const own = await submit([{ clientId: "a-a", first: "Ora", age: 40 }, { clientId: "a-b", first: "Orb", age: 41 }, { clientId: "a-kid", first: "Ori", age: 6 }], { "a-kid": "a-a" });
  await prisma.$transaction((tx) => declareResponsibleAdultsForRegistration(tx, { registrationId: own.registration.id, choices: { [own.byName("Ori").id]: own.byName("Orb").id } }));
  const ownRows = await prisma.guardianAuthority.findMany({ where: { minorPersonId: own.byName("Ori").personId }, orderBy: { declaredAt: "asc" } });
  assert(ownRows.length === 2 && ownRows[0]!.state === "SUPERSEDED" && ownRows[1]!.state === "ACTIVE" && ownRows[1]!.adultPersonId === own.byName("Orb").personId, "the registrant's change supersedes and keeps the earlier choice");
  await expectCode(prisma.$transaction((tx) => declareResponsibleAdultsForRegistration(tx, { registrationId: own.registration.id, choices: { [own.byName("Ori").id]: parallel.byName("Pam").id } })), "CHOICES_INVALID", "an adult from another registration cannot be chosen");

  // ---- Revocation: immediate, history kept ----
  const revokeTarget = (await prisma.registrationAttendee.findFirstOrThrow({ where: { registrationId: first.registration.id, personId: sam.personId } })).id;
  await expectCode(revokeResponsibleAdult({ eventId: ids.eventB, attendeeId: revokeTarget, reason: REASON, actorUserId: ids.staff }), "ATTENDEE_NOT_FOUND", "another event cannot revoke");
  await expectCode(revokeResponsibleAdult({ eventId: ids.eventA, attendeeId: revokeTarget, reason: "", actorUserId: ids.staff }), "REASON_REQUIRED", "a reason is required to revoke");
  await revokeResponsibleAdult({ eventId: ids.eventA, attendeeId: revokeTarget, reason: REASON, actorUserId: ids.staff });
  assert((await activeFor(ids.eventA, sam.personId)).length === 0, "after a revocation nothing is ACTIVE for the minor");
  const revokedRow = await prisma.guardianAuthority.findUniqueOrThrow({ where: { id: declared[0]!.id } });
  assert(revokedRow.state === "REVOKED" && revokedRow.revocationReason === REASON && revokedRow.revokedByUserId === ids.staff && revokedRow.revokedAt !== null && revokedRow.adultPersonId === dan.personId, "the revoked declaration is kept with who, when and why");
  review = await getGuardianReview(ids.eventA);
  const samAfter = review.minors.find((minor) => minor.personId === sam.personId)!;
  assert(samAfter.responsibleAdult === null && samAfter.kinds.includes("NOT_DECLARED"), "the review shows no responsible adult at once");
  assert(await rejects(prisma.guardianAuthority.update({ where: { id: declared[0]!.id }, data: { state: "ACTIVE", revokedAt: null, revocationReason: null, revokedByUserId: null } }), /not rewritten|check|violat/i), "a revoked declaration is not reinstated");
  await expectCode(revokeResponsibleAdult({ eventId: ids.eventA, attendeeId: revokeTarget, reason: REASON, actorUserId: ids.staff }), "NO_ACTIVE_AUTHORITY", "nothing is left to revoke");
  // After a revocation the registrant's claim is a review item, never a quiet reinstatement.
  const reclaim = await prisma.$transaction((tx) => recordRegistrationDeclarations(tx, { eventId: ids.eventA, registrationId: first.registration.id, actorPersonId: first.registration.accountHolderPersonId, declarations: [{ minorPersonId: sam.personId, adultPersonId: dan.personId }] }));
  assert(reclaim.conflicts === 1 && (await activeFor(ids.eventA, sam.personId)).length === 0, "a registrant cannot undo a staff revocation");
  // Staff can set it again.
  await setResponsibleAdult({ eventId: ids.eventA, attendeeId: revokeTarget, adultPersonId: dan.personId, reason: REASON, actorUserId: ids.staff });
  assert((await activeFor(ids.eventA, sam.personId))[0]?.adultPersonId === dan.personId, "staff can set it again after a revocation");

  // ---- Audit rows: ids only ----
  const audits = await prisma.auditLog.findMany({ where: { eventId: ids.eventA, action: { startsWith: "GUARDIAN_AUTHORITY_" } } });
  assert(audits.length > 10, "declarations, staff changes and conflicts are audited");
  for (const entry of audits) {
    const text = JSON.stringify(entry);
    assert(!text.includes(REASON), "no audit row holds a reason");
    assert(!/Sam|Dan|Pip|Mia|Gv|Holder|Guardian Check/.test(JSON.stringify(entry.metadata) + entry.summary), `no audit row holds a person's name (${entry.action})`);
  }

  // ---- Foreign-key actions still work ----
  const abeAttendee = (await prisma.registrationAttendee.findFirstOrThrow({ where: { registrationId: alone.registration.id, personId: alone.byName("Abe").personId } })).id;
  const nateAsAdult = none.byName("Nate").personId;
  const doomedSet = await setResponsibleAdult({ eventId: ids.eventA, attendeeId: abeAttendee, adultPersonId: nateAsAdult, reason: REASON, actorUserId: ids.doomed });
  assert((await prisma.guardianAuthority.findUniqueOrThrow({ where: { id: doomedSet.authorityId } })).actorUserId === ids.doomed, "a staff row carries its actor");
  await prisma.user.delete({ where: { id: ids.doomed } });
  const cleared = await prisma.guardianAuthority.findUniqueOrThrow({ where: { id: doomedSet.authorityId } });
  assert(cleared.actorUserId === null && cleared.adultPersonId === nateAsAdult && cleared.state === "ACTIVE", "deleting a user clears the actor and changes nothing else");
  assert(await prisma.guardianAuthority.count({ where: { actorUserId: ids.staff } }) > 0, "staff rows keep the staff actor");

  assert(await prisma.guardianAuthority.count({ where: { eventId: ids.eventA } }) > 0, "there are rows to cascade");
  await prisma.messageOutbox.deleteMany({ where: { OR: [{ eventId: ids.eventA }, { eventId: ids.eventB }] } });
  await prisma.auditLog.deleteMany({ where: { eventId: ids.eventA } });
  await prisma.event.delete({ where: { id: ids.eventA } });
  assert(await prisma.guardianAuthority.count({ where: { eventId: ids.eventA } }) === 0, "deleting the event removes every declaration");
  assert(await prisma.guardianAuthorityConflict.count({ where: { eventId: ids.eventA } }) === 0, "and every review item");

  console.log("Guardian authority verification passed.");
}

main()
  .catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError) console.error(error.code, error.message);
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch((error: unknown) => console.error("cleanup failed", error));
    await prisma.$disconnect();
  });
