/**
 * Proves lodging preferences, roommate requests, household rules and the staff review (#199, slice 2) against a
 * real PostgreSQL database, where unit tests cannot:
 *
 * - a request is a versioned preference: every change is a new immutable row, an unchanged save adds nothing,
 *   partial stays are kept, and the database refuses rewriting or deleting a version;
 * - the registrant deadline closes edits (and roommate requests), a staff change after it is flagged, and an
 *   extended deadline reopens them;
 * - a full category is refused at selection, partial stays on other nights still fit, and five registrants racing
 *   for the last place produce exactly one winner (the unit-row lock);
 * - roommate requests are directional: one-sided until the other side asks or staff approve; every lookup miss
 *   gives the same answer; nobody sees who asked for them; no email or phone appears in any response;
 * - accessibility is two yes/no flags: no free-text column exists, staff without VIEW_SENSITIVE_DATA neither see
 *   nor set them, and the audit log never holds their values;
 * - household rules (responsible adult, split, join, keep apart) keep history, reasons and actors, follow a person
 *   who moves to another registration, and are ended, never deleted;
 * - the review queue lists one-sided, conflicting, impossible, late and over-capacity requests, and an
 *   acknowledged item returns when it changes;
 * - the database refuses cross-event rows, and every new row goes with its event.
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:lodging-preferences
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { PrismaClient, RegistrationFormStatus } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { getPublicRegistrationExperience, PublicRegistrationError, submitPublicRegistration } from "@/modules/forms/public-repository";
import type { PublicRegistrationInput } from "@/modules/forms/public-domain";
import { getPublicLodgingOffer } from "@/modules/lodging/registration-form";
import { LodgingError } from "@/modules/lodging/errors";
import { lodgingRequestsCsv } from "@/modules/lodging/export";
import {
  acknowledgeReviewItem,
  changeRegistrantRoommates,
  createLodgingRule,
  decideRoommateRequest,
  endLodgingRule,
  getLodgingRequestExportRows,
  getRegistrantLodgingView,
  getStaffLodgingRequestsView,
  saveLodgingRequest,
  updateLodgingSettings,
  type Actor,
} from "@/modules/lodging/preferences-service";
import { selectEventProperty, setEventRate, updateEventUnit, getLodgingView } from "@/modules/lodging/service";
import { syncLodgingTemplates } from "@/modules/lodging/sync";

loadEnvConfig(process.cwd());
// Local-only, before any connection exists.
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-lodging-preferences-synthetic-key-not-a-secret");

const prisma = new PrismaClient();
const P = `lodg199_${randomUUID().slice(0, 8)}`;
const userId = `${P}_user`;
const eventId = `${P}_ev`;
const otherEventId = `${P}_ev_other`;
const bareEventId = `${P}_ev_bare`;
const verifyEventId = `${P}_ev_verify`;
const surname = `Subm${P}`;
const formSlug = `${P}-form`;
const ids = { form: `${P}_form`, formVersion: `${P}_form_v1` };
const slugOf = (id: string) => `${id}-slug`;
const before = new Date("2027-05-20T12:00:00Z");
const after = new Date("2027-06-05T12:00:00Z");

const staff: Actor = { kind: "STAFF", userId, canSeeSensitive: true };
const staffBlind: Actor = { kind: "STAFF", userId, canSeeSensitive: false };
const link = (name: string): Actor => ({ kind: "REGISTRANT", accessTokenId: `${P}_tok_${name}` });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function caught(promise: Promise<unknown>) {
  return promise.then(() => null, (error: unknown) => error);
}

async function expectLodgingError(promise: Promise<unknown>, code: string, message: string) {
  const error = await caught(promise);
  assert(error instanceof LodgingError && error.code === code, `${message}: expected ${code}, got ${String(error)}`);
  return error;
}

async function expectDatabaseRefusal(promise: Promise<unknown>, message: string) {
  const error = await caught(promise);
  assert(error, `${message}: the database accepted it`);
}

async function cleanup() {
  const registrationIds = (await prisma.registration.findMany({ where: { eventId: { startsWith: `${P}_` } }, select: { id: true } })).map((row) => row.id);
  await prisma.messageOutbox.deleteMany({ where: { registrationId: { in: registrationIds } } });
  await prisma.event.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.person.deleteMany({ where: { lastName: surname } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: userId }, { eventId: { startsWith: `${P}_` } }] } });
  await prisma.person.deleteMany({ where: { normalizedEmail: { startsWith: `${P}.` } } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

async function createEvent(id: string, extra: Record<string, unknown> = {}) {
  await prisma.event.create({
    data: {
      id, slug: `${id}-slug`, name: `Lodging preferences check ${id}`,
      startsAt: new Date("2027-06-15T15:00:00Z"), endsAt: new Date("2027-06-19T15:00:00Z"), timezone: "America/Chicago",
      registrationClosesOn: "2027-06-01", attendeeEditPolicy: "TIERED", isPublished: true, ...extra,
    },
  });
}

type Reg = { id: string; code: string; people: Array<{ id: string; first: string; last: string; email: string; phone: string }>; token: Actor };
let counter = 0;

async function makeRegistration(forEvent: string, tag: string, peopleCount = 1, status: "CONFIRMED" | "CANCELLED" | "WAITLISTED" = "CONFIRMED"): Promise<Reg> {
  const people: Reg["people"] = [];
  for (let index = 0; index < peopleCount; index += 1) {
    counter += 1;
    const person = await prisma.person.create({
      data: { firstName: `Alder${tag}${index}`, lastName: `Tester${counter}`, normalizedEmail: `${P}.${tag}${index}.${counter}@lodging.example.test`, phone: `555-01${String(counter).padStart(2, "0")}` },
    });
    people.push({ id: person.id, first: person.firstName, last: person.lastName, email: person.normalizedEmail!, phone: person.phone! });
  }
  const code = `REG-${P.slice(-8).toUpperCase()}${tag.toUpperCase()}`;
  const registration = await prisma.registration.create({
    data: { eventId: forEvent, accountHolderPersonId: people[0]!.id, confirmationCode: code, status, totalAmount: 0, submittedAt: before },
  });
  for (const [position, person] of people.entries()) {
    await prisma.registrationAttendee.create({
      data: { eventId: forEvent, registrationId: registration.id, personId: person.id, attendeeType: "adult", position, profileSnapshot: { firstName: person.first, lastName: person.last } },
    });
  }
  return { id: registration.id, code, people, token: link(tag) };
}

const fullName = (reg: Reg, index = 0) => `${reg.people[index]!.first} ${reg.people[index]!.last}`;
const saveAny = (reg: Reg, raw: unknown, actor: Actor = reg.token, now = before, forEvent = eventId) => saveLodgingRequest({ eventId: forEvent, registrationId: reg.id, actor, raw, now }, prisma);
/** A save that applies (not one the edit policy held for staff). */
const save = async (reg: Reg, raw: unknown, actor: Actor = reg.token, now = before) => {
  const result = await saveAny(reg, raw, actor, now);
  if (result.changeRequested) throw new Error("FAILED: the change was held for staff when it should have applied");
  return result;
};
const view = (reg: Reg, now = before) => getRegistrantLodgingView({ eventId, registrationId: reg.id, now }, prisma);
const addByCode = (from: Reg, target: Reg, name = fullName(target), code = target.code, now = before) =>
  changeRegistrantRoommates({ eventId, registrationId: from.id, accessTokenId: `${P}_tok_${from.code}`, raw: { action: "add_by_code", name, confirmationCode: code }, now }, prisma);
const staffView = (canSeeSensitive = true) => getStaffLodgingRequestsView(eventId, { canSeeSensitive, now: before }, prisma);
const queueKinds = async (canSeeSensitive = true) => (await staffView(canSeeSensitive)).queue.filter((item) => !item.acknowledged).map((item) => item.kind).sort();

const formDefinition = registrationFormDefinitionSchema.parse({
  title: "Lodging verification",
  description: "Temporary fictitious form used only by the lodging preferences check.",
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
      ],
    },
  ],
});

let submissions = 0;
function formInput(versionId: string, people: number, lodging?: unknown): PublicRegistrationInput {
  submissions += 1;
  const n = submissions;
  return {
    versionId,
    idempotencyKey: randomUUID(),
    responses: { primary_contact_first_name: "Lo", primary_contact_last_name: `Holder${n}`, email: `${P}.sub${n}@lodging.example.test` },
    attendees: Array.from({ length: people }, (_, index) => ({ clientId: `p${index}`, responses: { first_name: `Guest${n}x${index}`, last_name: surname } })),
    ...(lodging !== undefined ? { lodging } : {}),
    website: "",
  } as PublicRegistrationInput;
}

/** A real public submission through the same transaction the form uses (the registration, its pricing and its lodging). */
async function submitForm(options: { people: number; lodging?: unknown }) {
  const result = await submitPublicRegistration(slugOf(eventId), formSlug, formInput(ids.formVersion, options.people, options.lodging), before);
  const registration = await prisma.registration.findFirstOrThrow({
    where: { eventId, confirmationCode: result.confirmationCode },
    include: { attendees: { include: { person: true }, orderBy: { position: "asc" } } },
  });
  const submission = await prisma.publicRegistrationSubmission.findFirstOrThrow({ where: { registrationId: registration.id } });
  const reg: Reg = {
    id: registration.id,
    code: registration.confirmationCode,
    people: registration.attendees.map((attendee) => ({ id: attendee.personId, first: attendee.person.firstName, last: attendee.person.lastName, email: "", phone: "" })),
    token: link(`s${submissions}`),
  };
  return { result, registration, reg, snapshot: submission.pricingSnapshot as Record<string, unknown> };
}

async function main() {
  await cleanup();
  await prisma.user.create({ data: { id: userId, email: `${P}@lodging.example.test`, displayName: "Lodging verifier" } });
  await syncLodgingTemplates(prisma);
  await createEvent(eventId);
  await createEvent(otherEventId);
  await createEvent(bareEventId);
  await selectEventProperty(eventId, userId, { propertyKey: "sunnydale-academy" }, prisma);
  await selectEventProperty(otherEventId, userId, { propertyKey: "sunnydale-academy" }, prisma);
  await prisma.registrationForm.create({
    data: {
      id: ids.form, eventId, createdByUserId: userId, name: formDefinition.title, slug: formSlug, status: RegistrationFormStatus.PUBLISHED,
      versions: { create: { id: ids.formVersion, createdByUserId: userId, versionNumber: 1, status: RegistrationFormStatus.PUBLISHED, publishedAt: new Date(), definition: formDefinition } },
    },
  });
  await prisma.registrationForm.create({
    data: {
      id: `${ids.form}_o`, eventId: otherEventId, createdByUserId: userId, name: formDefinition.title, slug: formSlug, status: RegistrationFormStatus.PUBLISHED,
      versions: { create: { id: `${ids.formVersion}_o`, createdByUserId: userId, versionNumber: 1, status: RegistrationFormStatus.PUBLISHED, publishedAt: new Date(), definition: formDefinition } },
    },
  });

  // ---- Settings -------------------------------------------------------------
  const registrationA = await makeRegistration(eventId, "a", 2);
  await expectLodgingError(save(registrationA, { category: "TENT" }), "PREFERENCES_NOT_COLLECTED", "an event that does not collect preferences");
  assert(!(await view(registrationA)).enabled, "a registrant sees no lodging section when the event does not collect it");
  assert(!(await getRegistrantLodgingView({ eventId: bareEventId, registrationId: registrationA.id }, prisma)).enabled, "an event with no lodging property shows no lodging section and does not fail");
  const settings = await updateLodgingSettings(eventId, userId, { collectsPreferences: true, fullBehavior: "WAITLIST" }, prisma);
  assert(settings.collectsPreferences && settings.fullBehavior === "WAITLIST" && settings.preferencesDeadline === null, "settings saved");
  assert((await staffView()).settings.effectiveDeadline === "2027-06-01", "the deadline defaults to the registration close date");
  assert(await prisma.auditLog.count({ where: { eventId, action: "LODGING_SETTINGS_CHANGED" } }) === 1, "a settings change is audited");
  assert(await caught(updateLodgingSettings(eventId, userId, { fullBehavior: "NOPE" }, prisma)), "an unknown full behavior is refused");

  // ---- Versioned requests ---------------------------------------------------
  const first = await save(registrationA, { category: "DORM_ROOM", partySize: 2, privateRoomRequested: true, groundFloorNeeded: true });
  assert(first.changed && first.version === 1, "the first save is version 1");
  const same = await save(registrationA, { category: "DORM_ROOM", partySize: 2, privateRoomRequested: true });
  assert(!same.changed && same.version === 1, "an unchanged save adds no version");
  const second = await save(registrationA, { category: "CONFERENCE_CENTER_ROOM", partySize: 2, firstNight: "2027-06-16", lastNight: "2027-06-17" });
  assert(second.changed && second.version === 2, "a change is version 2");
  const versions = await prisma.eventLodgingRequestVersion.findMany({ where: { eventId }, orderBy: { version: "asc" } });
  assert(versions.length === 2 && versions[0]!.category === "DORM_ROOM" && versions[0]!.firstNight === null && versions[0]!.privateRoomRequested, "the earlier version is kept exactly as it was");
  assert(versions[1]!.firstNight?.toISOString().slice(0, 10) === "2027-06-16" && versions[1]!.lastNight?.toISOString().slice(0, 10) === "2027-06-17", "a partial stay is kept");
  assert(versions[1]!.source === "REGISTRANT" && versions[1]!.accessTokenId === `${P}_tok_a` && versions[1]!.actorUserId === null, "a version keeps its source and the link it came through");
  const current = await prisma.eventLodgingRequest.findFirstOrThrow({ where: { eventId } });
  assert(current.currentVersion === 2, "the request points at its latest version");
  await expectDatabaseRefusal(prisma.eventLodgingRequestVersion.update({ where: { id: versions[0]!.id }, data: { category: "TENT" } }), "rewriting a version");
  await expectDatabaseRefusal(prisma.eventLodgingRequestVersion.delete({ where: { id: versions[0]!.id } }), "deleting a version");
  await expectDatabaseRefusal(prisma.eventLodgingRequest.delete({ where: { id: current.id } }), "deleting a request");
  const asRegistrant = await view(registrationA);
  assert(asRegistrant.request?.version === 2 && asRegistrant.earlierVersions === 1, "the registrant sees the latest version and that an earlier one is kept");
  assert(asRegistrant.offered.some((entry) => entry.category === "DORM_ROOM") && asRegistrant.canEdit, "the registrant sees the offered types and can edit");

  // The service refuses what the form could never send.
  assert(await caught(save(registrationA, { category: "TENT", medicalReason: "knee surgery" })), "free text is refused by the strict schema");
  assert(await caught(save(registrationA, { category: "TENT", groundFloorNeeded: "first-floor request for medical reasons" })), "a flag is a boolean, never text");
  await expectLodgingError(save(registrationA, { category: "TENT", firstNight: "2027-06-14", lastNight: "2027-06-16" }), "DATES_OUTSIDE_EVENT", "nights before the event");
  await expectLodgingError(save(registrationA, { category: "TENT", partySize: 3 }), "PARTY_TOO_LARGE", "a party larger than the registration");
  const columns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string; data_type: string }>>`
    SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('EventLodgingRequest', 'EventLodgingRequestVersion', 'EventLodgingRoommateRequest') AND data_type IN ('text', 'character varying', 'jsonb', 'json')`;
  const textColumns = columns.map((column) => `${column.table_name}.${column.column_name}`).sort();
  assert(!textColumns.some((name) => /medical|note|comment|accessib|disab|health/i.test(name)), `no medical or free-text column exists: ${textColumns.join()}`);
  assert(!columns.some((column) => column.data_type === "jsonb" || column.data_type === "json"), "no JSON blob can smuggle free text into a request");

  // ---- Deadline -------------------------------------------------------------
  await expectLodgingError(save(registrationA, { category: "TENT" }, registrationA.token, after), "DEADLINE_PASSED", "a registrant after the deadline");
  const closed = await view(registrationA, after);
  assert(!closed.canEdit && closed.closedReason === "DEADLINE_PASSED", "the registrant view reports the closed deadline");
  const lateBlind = await caught(save(registrationA, { category: "TENT", groundFloorNeeded: true, reason: "Phoned" }, staffBlind, after));
  assert(lateBlind instanceof LodgingError && lateBlind.code === "SENSITIVE_DATA_FORBIDDEN", "staff without VIEW_SENSITIVE_DATA cannot set accessibility flags");
  assert(await caught(save(registrationA, { category: "TENT" }, staff, after)), "a staff change needs a reason");
  const late = await save(registrationA, { category: "DORM_ROOM", reason: "Guest phoned the office" }, staffBlind, after);
  assert(late.changed && late.afterDeadline && late.version === 3, "a staff change after the deadline is flagged and keeps history");
  const lateRow = await prisma.eventLodgingRequestVersion.findFirstOrThrow({ where: { eventId, version: 3 } });
  assert(lateRow.source === "STAFF" && lateRow.actorUserId === userId && lateRow.changeReason === "Guest phoned the office" && lateRow.groundFloorNeeded, "the staff version keeps actor and reason and carries the existing flags forward");
  assert((await queueKinds()).includes("PAST_DEADLINE"), "the review queue lists a change after the deadline");
  await updateLodgingSettings(eventId, userId, { preferencesDeadline: "2027-06-10" }, prisma);
  assert((await save(registrationA, { category: "TENT_WITH_POWER", partySize: 2 }, registrationA.token, after)).version === 4, "an extended deadline reopens editing");
  await updateLodgingSettings(eventId, userId, { preferencesDeadline: null }, prisma);

  // The audit log says that a flag changed, never what it was.
  const audits = await prisma.auditLog.findMany({ where: { eventId, action: "LODGING_REQUEST_SAVED" } });
  assert(audits.length === 4 && audits.every((row) => !JSON.stringify(row.metadata).includes("groundFloorNeeded") && !JSON.stringify(row.metadata).includes("accessibleRoomNeeded")), "audit entries never carry accessibility values");
  const createAudit = audits.find((row) => (row.metadata as { version?: number }).version === 1)!;
  assert(!JSON.stringify(createAudit.metadata).includes("accessibilityChanged"), "creating a request does not record whether its flags were set");
  await save(registrationA, { category: "TENT_WITH_POWER", partySize: 2, accessibleRoomNeeded: true, reason: "Guest phoned the office" }, staff);
  const flipAudit = await prisma.auditLog.findFirstOrThrow({ where: { eventId, action: "LODGING_REQUEST_SAVED" }, orderBy: { createdAt: "desc" } });
  assert(JSON.stringify(flipAudit.metadata).includes('"accessibilityChanged":true') && !JSON.stringify(flipAudit.metadata).includes("accessibleRoomNeeded"), "a later change says that accessibility changed, never to what");

  // ---- Capacity, partial stays and the race --------------------------------
  const tentRow = (await getLodgingView(eventId, prisma)).buildings.flatMap((building) => building.units).find((unit) => unit.key === "tents-with-power")!;
  await updateEventUnit(eventId, tentRow.eventUnitId, userId, { capacityOverride: 3 }, prisma);
  const b = await makeRegistration(eventId, "b", 2);
  const c = await makeRegistration(eventId, "c", 2);
  const d = await makeRegistration(eventId, "d", 1);
  // A holds 2 people in tents with power for every night (version 4 above); capacity is 3.
  await expectLodgingError(save(b, { category: "TENT_WITH_POWER", partySize: 2 }), "CATEGORY_FULL", "a full category");
  const fullView = await view(b);
  assert(fullView.offered.find((entry) => entry.category === "TENT_WITH_POWER")?.full === true && fullView.fullBehavior === "WAITLIST", "the registrant sees the type as full and the event's setting");
  const fullError = await caught(save(b, { category: "TENT_WITH_POWER", partySize: 2 }));
  assert(fullError instanceof LodgingError && /full/i.test(fullError.message), "the refusal says Full");
  assert((await save(b, { category: "TENT_WITH_POWER", partySize: 1 })).changed, "one more person still fits");
  // A partial stay on nights nobody asked for fits.
  await save(registrationA, { category: "TENT_WITH_POWER", partySize: 2, firstNight: "2027-06-15", lastNight: "2027-06-16" });
  assert((await save(c, { category: "TENT_WITH_POWER", partySize: 2, firstNight: "2027-06-17", lastNight: "2027-06-18" })).changed, "a partial stay on other nights fits");
  await expectLodgingError(save(c, { category: "TENT_WITH_POWER", partySize: 2, firstNight: "2027-06-16", lastNight: "2027-06-17" }), "CATEGORY_FULL", "a partial stay that overlaps a full night");
  // Staff are not stopped by "full"; the queue then shows the category as over capacity.
  await save(d, { category: "TENT_WITH_POWER", partySize: 1, reason: "Board member, approved by the director" }, staff);
  assert((await queueKinds()).includes("OVER_CAPACITY"), "a category over capacity is listed for review");
  await updateEventUnit(eventId, tentRow.eventUnitId, userId, { capacityOverride: 12 }, prisma);
  assert(!(await queueKinds()).includes("OVER_CAPACITY"), "raising capacity clears it");

  // Five registrants race for the last place in a category with room for one more.
  const raceCount = 5;
  const racers: Reg[] = [];
  for (let index = 0; index < raceCount; index += 1) racers.push(await makeRegistration(eventId, `r${index}`, 1));
  // Tents with power now ask for at most 4 people on any night; room for exactly one more.
  await updateEventUnit(eventId, tentRow.eventUnitId, userId, { capacityOverride: 5 }, prisma);
  const raced = await Promise.all(racers.map((racer) => caught(save(racer, { category: "TENT_WITH_POWER", partySize: 1 }))));
  assert(raced.filter((result) => result === null).length === 1, `exactly one of ${raceCount} racing registrants gets the last place, got ${raced.filter((result) => result === null).length}`);
  assert(raced.filter((result) => result instanceof LodgingError && result.code === "CATEGORY_FULL").length === raceCount - 1, "the others are told the type is full");
  await updateEventUnit(eventId, tentRow.eventUnitId, userId, { capacityOverride: 100 }, prisma);

  // A category with nothing in service cannot be chosen.
  const conferenceRows = (await getLodgingView(eventId, prisma)).buildings.flatMap((building) => building.units).filter((unit) => unit.category === "CONFERENCE_CENTER_ROOM");
  for (const unit of conferenceRows) await updateEventUnit(eventId, unit.eventUnitId, userId, { unavailable: true }, prisma);
  await expectLodgingError(save(c, { category: "CONFERENCE_CENTER_ROOM", partySize: 1 }), "CATEGORY_NOT_OFFERED", "a type with nothing in service");
  assert(!(await view(c)).offered.some((entry) => entry.category === "CONFERENCE_CENTER_ROOM"), "an unavailable type is not offered");
  for (const unit of conferenceRows) await updateEventUnit(eventId, unit.eventUnitId, userId, { unavailable: false }, prisma);

  // ---- Edit policy, payments, minimum nights, eligibility ------------------
  // The main event is TIERED. The accessibility needs may be set by the first saved version only.
  await expectLodgingError(save(registrationA, { category: "TENT", groundFloorNeeded: false }), "FLAGS_STAFF_ONLY", "a registrant changing the flags after the first version");
  const flagsUnchanged = await save(registrationA, { category: "TENT", groundFloorNeeded: true, partySize: 2 });
  assert(flagsUnchanged.changed, "re-sending the flags unchanged is not a flag change");
  const lockedView = await view(registrationA);
  assert(lockedView.flagsLocked && lockedView.canEdit, "the registrant view says the flags are locked after the first save");

  // A registrant cannot choose fewer nights than a rate's minimum; staff may make the exception.
  await setEventRate(eventId, userId, { category: "DORM_ROOM", rate: { amountCents: 2000, basis: "PER_UNIT_NIGHT", minimumNights: 2 } }, prisma);
  const shortStay = await makeRegistration(eventId, "s", 1);
  await expectLodgingError(save(shortStay, { category: "DORM_ROOM", firstNight: "2027-06-15", lastNight: "2027-06-15" }), "BELOW_MINIMUM_NIGHTS", "fewer nights than the rate's minimum");
  assert((await save(shortStay, { category: "DORM_ROOM", firstNight: "2027-06-15", lastNight: "2027-06-16" })).changed, "the minimum number of nights is accepted");
  assert((await save(shortStay, { category: "DORM_ROOM", firstNight: "2027-06-15", lastNight: "2027-06-15", reason: "Day visit, approved" }, staff)).changed, "staff may make an exception to the minimum");

  // Once money is on the registration, a registrant's move to a priced type goes to staff instead of applying.
  const paidSubmission = await submitForm({ people: 1, lodging: { category: "TENT", partySize: 1 } });
  const paid = paidSubmission.reg;
  await prisma.payment.create({ data: { eventId, registrationId: paid.id, amount: 10, status: "SUCCEEDED", method: "CARD_REFERENCE", receivedAt: before } });
  const held = await saveAny(paid, { category: "DORM_ROOM", partySize: 1 });
  assert(held.changeRequested === true, "a change to a priced type with a payment on the registration is held for staff");
  const stillTent = await prisma.eventLodgingRequest.findFirstOrThrow({ where: { registrationId: paid.id } });
  assert(stillTent.currentVersion === 1 && (await prisma.eventLodgingChangeRequest.count({ where: { registrationId: paid.id, resolvedAt: null } })) === 1, "nothing was applied and one change request is open");
  assert((await queueKinds()).includes("CHANGE_REQUESTED") && (await view(paid)).changeRequested && (await view(paid)).pricedChangeNeedsStaff, "the queue and the registrant view show the open change request");
  assert((await save(paid, { category: "TENT_WITH_POWER", partySize: 1 })).changed, "a type with no price still applies with a payment on file");
  await expectDatabaseRefusal(prisma.eventLodgingChangeRequest.delete({ where: { id: held.changeRequested ? held.changeRequestId : "" } }), "deleting a change request");
  const staffMoved = await saveAny(paid, { category: "DORM_ROOM", partySize: 1, reason: "Moved to a dorm room after the guest phoned" }, staff);
  assert(!staffMoved.changeRequested && staffMoved.priceNeedsReview === true && Number((await prisma.registration.findUniqueOrThrow({ where: { id: paid.id } })).totalAmount) === 0, "staff can move a paid registration; its total is left for Payments, not changed by itself");
  assert((await prisma.eventLodgingChangeRequest.count({ where: { registrationId: paid.id, resolvedAt: null } })) === 0 && !(await queueKinds()).includes("CHANGE_REQUESTED"), "a staff change resolves the open change request");
  await setEventRate(eventId, userId, { category: "DORM_ROOM", rate: null }, prisma);

  // Only the places a request asks for more of need checking again.
  const shrink = await makeRegistration(eventId, "t", 2);
  await updateEventUnit(eventId, tentRow.eventUnitId, userId, { capacityOverride: 100 }, prisma);
  await save(shrink, { category: "TENT_WITH_POWER", partySize: 2 });
  const tentDemand = (await staffView()).offered.find((entry) => entry.category === "TENT_WITH_POWER")!.requested;
  await updateEventUnit(eventId, tentRow.eventUnitId, userId, { capacityOverride: 1 }, prisma);
  assert(tentDemand > 1, "the tents are now over-subscribed");
  assert((await save(shrink, { category: "TENT_WITH_POWER", partySize: 2, privateRoomRequested: true })).changed, "a change that asks for no more places is not stopped by a full type");
  assert((await save(shrink, { category: "TENT_WITH_POWER", partySize: 1 })).changed, "asking for fewer people is not stopped either");
  await expectLodgingError(save(shrink, { category: "TENT_WITH_POWER", partySize: 2 }), "CATEGORY_FULL", "asking for more people than before");
  await updateEventUnit(eventId, tentRow.eventUnitId, userId, { capacityOverride: 100 }, prisma);

  // Club and group registrations are not for guests to choose lodging.
  const groupReg = await makeRegistration(eventId, "gr", 1);
  await prisma.groupEventRegistration.create({ data: { eventId, registrationId: groupReg.id, billingPersonId: groupReg.people[0]!.id } });
  await expectLodgingError(saveAny(groupReg, { category: "TENT" }), "REGISTRATION_NOT_ELIGIBLE", "a group registration, by its registrant");
  await expectLodgingError(saveAny(groupReg, { category: "TENT", reason: "Staff" }, staff), "REGISTRATION_NOT_ELIGIBLE", "a group registration, by staff");
  assert(!(await view(groupReg)).enabled, "a group registration sees no lodging section");
  const target = await makeRegistration(eventId, "gt", 1);
  await expectLodgingError(addByCode(target, groupReg), "ROOMMATE_NOT_FOUND", "asking to room with a group registration");
  assert(!(await staffView()).people.some((person) => person.registration.includes(groupReg.code)), "group registrations are not listed in the lodging screens");

  // An event that verifies every edit keeps the private link read-only.
  await createEvent(verifyEventId, { attendeeEditPolicy: "VERIFY_EVERY_EDIT" });
  await selectEventProperty(verifyEventId, userId, { propertyKey: "sunnydale-academy" }, prisma);
  await updateLodgingSettings(verifyEventId, userId, { collectsPreferences: true }, prisma);
  const verified = await makeRegistration(verifyEventId, "v", 1);
  const verifiedOther = await makeRegistration(verifyEventId, "u", 1);
  await expectLodgingError(saveAny(verified, { category: "TENT" }, verified.token, before, verifyEventId), "EDIT_POLICY_REQUIRES_VERIFICATION", "a registrant on a verify-every-edit event");
  await expectLodgingError(changeRegistrantRoommates({ eventId: verifyEventId, registrationId: verified.id, accessTokenId: `${P}_tok_v`, raw: { action: "add_by_code", name: fullName(verifiedOther), confirmationCode: verifiedOther.code }, now: before }, prisma), "EDIT_POLICY_REQUIRES_VERIFICATION", "a roommate request on a verify-every-edit event");
  const verifyView = await getRegistrantLodgingView({ eventId: verifyEventId, registrationId: verified.id, now: before }, prisma);
  assert(verifyView.enabled && !verifyView.canEdit && verifyView.closedReason === "VERIFICATION_REQUIRED", "the section is read-only on a verify-every-edit event");
  assert((await saveAny(verified, { category: "TENT", reason: "Verified by phone" }, staff, before, verifyEventId)).changeRequested !== true, "staff can still record the request");

  // ---- The registration form: the lodging step and the charge ----------------
  const registrationsBefore = await prisma.registration.count({ where: { eventId } });
  await setEventRate(eventId, userId, { category: "DORM_ROOM", rate: { amountCents: 2000, basis: "PER_UNIT_NIGHT", minimumNights: 2 } }, prisma);
  await setEventRate(eventId, userId, { category: "RV_SITE", rate: { amountCents: 15000, basis: "PER_UNIT_PER_EVENT", minimumNights: null } }, prisma);
  await setEventRate(eventId, userId, { category: "TENT", rate: { amountCents: 4000, basis: "PER_PERSON_PER_EVENT", minimumNights: null } }, prisma);
  const lodgingLineOf = (snapshot: Record<string, unknown> | null) => ((snapshot?.lineItems as Array<{ key: string; label: string; amountCents: number }> | undefined) ?? []).find((line) => line.key === "lodging");

  // The form offers the step only where the event collects lodging, with what is full and what it costs.
  const offer = await getPublicLodgingOffer(eventId, prisma);
  assert(offer && offer.categories.some((entry) => entry.category === "DORM_ROOM" && entry.rate?.basis === "PER_UNIT_NIGHT") && offer.categories.some((entry) => entry.category === "RV_SITE" && entry.rate?.basis === "PER_UNIT_PER_EVENT"), "the form's offer carries the types, their rates and bases");
  assert((await getPublicLodgingOffer(bareEventId, prisma)) === null && (await getPublicLodgingOffer(otherEventId, prisma)) === null, "an event that does not collect lodging offers no step");
  const experience = await getPublicRegistrationExperience(slugOf(eventId), formSlug);
  assert(experience?.lodging?.categories.length === offer.categories.length, "the public form's experience carries the lodging step");

  // Per room per night: charged with the registration, in its own line.
  const dorm = await submitForm({ people: 2, lodging: { category: "DORM_ROOM", firstNight: "2027-06-15", lastNight: "2027-06-17", partySize: 2, groundFloorNeeded: true } });
  const dormLine = lodgingLineOf(dorm.snapshot);
  assert(dormLine?.amountCents === 6000 && dormLine.label === "Lodging: Dorm room", `a dorm room is charged per room per night, got ${JSON.stringify(dormLine)}`);
  assert(dorm.snapshot.totalCents === 6000 && dorm.snapshot.subtotalCents === 6000 && Number(dorm.registration.totalAmount) === 60, "the lodging line is the registration's total");
  assert(lodgingLineOf({ lineItems: dorm.result.lineItems })?.amountCents === 6000 && dorm.result.totalCents === 6000, "the confirmation shows the lodging line and the total");
  const dormVersion = await prisma.eventLodgingRequestVersion.findFirstOrThrow({ where: { request: { registrationId: dorm.reg.id } } });
  assert(dormVersion.version === 1 && dormVersion.source === "REGISTRATION_FORM" && dormVersion.sourceFormVersionId === ids.formVersion && dormVersion.groundFloorNeeded && dormVersion.partySize === 2 && dormVersion.category === "DORM_ROOM", "the submission wrote the first version, from the form, with its version");
  assert(dormVersion.firstNight?.toISOString().slice(0, 10) === "2027-06-15" && dormVersion.lastNight?.toISOString().slice(0, 10) === "2027-06-17", "its partial stay is kept");
  assert(await prisma.auditLog.count({ where: { eventId, action: "LODGING_REQUEST_SAVED", entityId: dormVersion.requestId } }) === 1, "the first version is audited");

  // Flat for the event: per room or site, and per person. A night count does not change them.
  const rv = await submitForm({ people: 2, lodging: { category: "RV_SITE", partySize: 2, firstNight: "2027-06-16", lastNight: "2027-06-16" } });
  assert(lodgingLineOf(rv.snapshot)?.amountCents === 15000 && rv.snapshot.totalCents === 15000, "a per-site-per-event rate is flat");
  const rvAllNights = await submitForm({ people: 1, lodging: { category: "RV_SITE", partySize: 1 } });
  assert(lodgingLineOf(rvAllNights.snapshot)?.amountCents === 15000, "and does not grow with the nights");
  const tent = await submitForm({ people: 2, lodging: { category: "TENT", partySize: 2 } });
  assert(lodgingLineOf(tent.snapshot)?.amountCents === 8000, "a per-person-per-event rate is charged for each person staying");
  const tentOne = await submitForm({ people: 2, lodging: { category: "TENT", partySize: 1 } });
  assert(lodgingLineOf(tentOne.snapshot)?.amountCents === 4000, "for the party that is staying, not the registration");
  const tentPower = await submitForm({ people: 1, lodging: { category: "TENT_WITH_POWER", partySize: 1 } });
  assert(lodgingLineOf(tentPower.snapshot)?.amountCents === 4000, "a tent with power uses the tent rate");

  // No rate means no line.
  const noRate = await submitForm({ people: 1, lodging: { category: "CONFERENCE_CENTER_ROOM", partySize: 1 } });
  assert(!lodgingLineOf(noRate.snapshot) && noRate.snapshot.totalCents === 0 && Number(noRate.registration.totalAmount) === 0, "a type with no rate adds nothing");
  assert(await prisma.eventLodgingRequest.count({ where: { registrationId: noRate.reg.id } }) === 1, "but the request is still recorded");
  const noChoice = await submitForm({ people: 1, lodging: { category: null } });
  assert(!lodgingLineOf(noChoice.snapshot) && noChoice.snapshot.totalCents === 0, "no preference adds nothing");
  const noStep = await submitForm({ people: 1 });
  assert(await prisma.eventLodgingRequest.count({ where: { registrationId: noStep.reg.id } }) === 0 && !lodgingLineOf(noStep.snapshot), "a submission without the step records no request");

  // Roommates asked for in the form: by name and code, and within the registration.
  const withRoommates = await submitForm({
    people: 2,
    lodging: { category: "TENT", partySize: 2, roommates: [{ name: fullName(noRate.reg), confirmationCode: noRate.reg.code }], roommatesWithin: [{ fromClientId: "p0", targetClientId: "p1" }] },
  });
  assert(await prisma.eventLodgingRoommateRequest.count({ where: { fromRegistrationId: withRoommates.reg.id, source: "REGISTRATION_FORM" } }) === 2, "the form's roommate requests are recorded, from the form");
  assert((await view(withRoommates.reg)).roommates.some((row) => row.status === "WAITING" && row.who === fullName(noRate.reg)), "and wait for the other side");
  const missedRegistrations = await prisma.registration.count({ where: { eventId } });
  const missedRoommate = await caught(submitForm({ people: 1, lodging: { category: "TENT", partySize: 1, roommates: [{ name: "Nobody Atall", confirmationCode: "REG-NOSUCHCODE" }] } }));
  assert(missedRoommate instanceof PublicRegistrationError && missedRoommate.issues[0]?.key === "lodging" && /Lodging step/.test(missedRoommate.message), "a roommate who cannot be found is a field error on the lodging step");
  assert(await prisma.registration.count({ where: { eventId } }) === missedRegistrations, "and leaves no registration behind");

  // Refusals name the step and leave nothing behind.
  const below = await caught(submitForm({ people: 1, lodging: { category: "DORM_ROOM", firstNight: "2027-06-15", lastNight: "2027-06-15", partySize: 1 } }));
  assert(below instanceof PublicRegistrationError && below.issues[0]?.key === "lodging" && /Lodging step: .*at least 2 nights/.test(below.message), "fewer nights than the rate's minimum is refused on the lodging step");
  const tooMany = await caught(submitForm({ people: 1, lodging: { category: "TENT", partySize: 2 } }));
  assert(tooMany instanceof PublicRegistrationError && tooMany.issues[0]?.key === "lodging", "a party larger than the registration is refused");
  const outside = await caught(submitForm({ people: 1, lodging: { category: "TENT", firstNight: "2027-06-10", lastNight: "2027-06-12" } }));
  assert(outside instanceof PublicRegistrationError && outside.issues[0]?.key === "lodging", "nights outside the event are refused");
  const strangerBefore = await prisma.registration.count({ where: { eventId: otherEventId } });
  const stranger = await caught(submitPublicRegistration(slugOf(otherEventId), formSlug, formInput(`${ids.formVersion}_o`, 1, { category: "TENT" }), before));
  assert(stranger instanceof PublicRegistrationError && stranger.issues[0]?.key === "lodging" && await prisma.registration.count({ where: { eventId: otherEventId } }) === strangerBefore, "an event that does not collect lodging refuses it and leaves nothing behind");

  // A full type is refused at submit, and five racing for the last place leave exactly one winner.
  const ccRows = (await getLodgingView(eventId, prisma)).buildings.flatMap((building) => building.units).filter((unit) => unit.category === "CONFERENCE_CENTER_ROOM");
  for (const [index, unit] of ccRows.entries()) await updateEventUnit(eventId, unit.eventUnitId, userId, { capacityOverride: index === 0 ? 2 : 0 }, prisma);
  // The conference center now takes 2 people a night; one is already there (the no-rate registration).
  const cc2 = await submitForm({ people: 1, lodging: { category: "CONFERENCE_CENTER_ROOM", partySize: 1 } });
  assert(cc2.snapshot.totalCents === 0, "the last place is taken at submit");
  const full = await caught(submitForm({ people: 1, lodging: { category: "CONFERENCE_CENTER_ROOM", partySize: 1 } }));
  assert(full instanceof PublicRegistrationError && full.issues[0]?.key === "lodging" && /Lodging step: .*full/.test(full.message), "a full type is refused at submit with a field error naming the step");
  // Raise to exactly one place left, then race.
  await updateEventUnit(eventId, ccRows[0]!.eventUnitId, userId, { capacityOverride: 3 }, prisma);
  const racersBefore = await prisma.registration.count({ where: { eventId } });
  const racedSubmits = await Promise.all([1, 2, 3, 4, 5].map(() => caught(submitForm({ people: 1, lodging: { category: "CONFERENCE_CENTER_ROOM", partySize: 1 } }))));
  const winners = racedSubmits.filter((outcome) => !(outcome instanceof Error));
  assert(winners.length === 1, `exactly one of five racing submissions gets the last place, got ${winners.length}: ${racedSubmits.map((outcome) => (outcome instanceof Error ? outcome.message.slice(0, 60) : "ok")).join(" | ")}`);
  assert(racedSubmits.filter((outcome) => outcome instanceof PublicRegistrationError && outcome.issues[0]?.key === "lodging").length === 4, "the other four are told the lodging step is full");
  assert(await prisma.registration.count({ where: { eventId } }) === racersBefore + 1, "and only the winner has a registration");
  for (const unit of ccRows) await updateEventUnit(eventId, unit.eventUnitId, userId, { capacityOverride: null }, prisma);

  // After submission: the charge follows the request while nothing else rides on the registration.
  const grown = await save(dorm.reg, { category: "DORM_ROOM", firstNight: "2027-06-15", lastNight: "2027-06-18", partySize: 2 });
  assert(grown.changed && grown.repriced === true, "a change that alters the charge is repriced when nothing else rides on the registration");
  const grownSubmission = await prisma.publicRegistrationSubmission.findFirstOrThrow({ where: { registrationId: dorm.reg.id } });
  const grownSnapshot = grownSubmission.pricingSnapshot as Record<string, unknown>;
  assert(lodgingLineOf(grownSnapshot)?.amountCents === 8000 && grownSnapshot.totalCents === 8000 && Number((await prisma.registration.findUniqueOrThrow({ where: { id: dorm.reg.id } })).totalAmount) === 80, "the stored pricing and the registration total follow");
  assert(await prisma.auditLog.count({ where: { eventId, action: "LODGING_CHARGE_CHANGED", entityId: dorm.reg.id } }) === 1, "the new charge is audited");
  const free = await save(dorm.reg, { category: "CONFERENCE_CENTER_ROOM", partySize: 2 });
  assert(free.repriced === true && Number((await prisma.registration.findUniqueOrThrow({ where: { id: dorm.reg.id } })).totalAmount) === 0, "moving to a type with no rate removes the line");

  // Money on the registration: the registrant's change goes to staff; nothing is charged or refunded by itself.
  await prisma.payment.create({ data: { eventId, registrationId: rv.reg.id, amount: 150, status: "SUCCEEDED", method: "CARD_REFERENCE", receivedAt: before } });
  const paymentsBefore = await prisma.payment.count({ where: { eventId } });
  const refundsBefore = await prisma.refund.count({ where: { payment: { eventId } } });
  const heldRv = await saveAny(rv.reg, { category: "TENT", partySize: 2 });
  assert(heldRv.changeRequested === true, "a change after payment becomes a change request");
  assert(Number((await prisma.registration.findUniqueOrThrow({ where: { id: rv.reg.id } })).totalAmount) === 150, "the total is untouched");
  assert(await prisma.payment.count({ where: { eventId } }) === paymentsBefore && await prisma.refund.count({ where: { payment: { eventId } } }) === refundsBefore, "no payment or refund is created");
  const staffMove = await saveAny(rv.reg, { category: "TENT", partySize: 2, reason: "Approved by the director" }, staff);
  assert(!staffMove.changeRequested && staffMove.priceNeedsReview === true && Number((await prisma.registration.findUniqueOrThrow({ where: { id: rv.reg.id } })).totalAmount) === 150, "staff can change the request, and the total is left for Payments");
  assert((await queueKinds()).includes("PRICE_DIFFERS"), "the queue lists a lodging charge that differs from the request");

  // A rate that changes later does not rewrite what was charged; the queue shows the difference.
  await setEventRate(eventId, userId, { category: "TENT", rate: { amountCents: 4500, basis: "PER_PERSON_PER_EVENT", minimumNights: null } }, prisma);
  assert(Number((await prisma.registration.findUniqueOrThrow({ where: { id: tent.reg.id } })).totalAmount) === 80, "a changed rate does not change an existing total");
  assert((await staffView()).queue.some((item) => item.kind === "PRICE_DIFFERS" && item.registrationIds.includes(tent.reg.id)), "but the difference is listed");
  await setEventRate(eventId, userId, { category: "TENT", rate: null }, prisma);
  await setEventRate(eventId, userId, { category: "RV_SITE", rate: null }, prisma);
  await setEventRate(eventId, userId, { category: "DORM_ROOM", rate: null }, prisma);
  // The form's roommate requests are done with: staff withdraw them so the queue checks below see only their own pairs.
  for (const row of await prisma.eventLodgingRoommateRequest.findMany({ where: { fromRegistrationId: withRoommates.reg.id, withdrawnAt: null } })) {
    if (row.fromRegistrationId !== row.targetRegistrationId) await decideRoommateRequest(eventId, userId, { action: "withdraw", requestId: row.id, reason: "Done with the form check" }, prisma);
  }
  void registrationsBefore;

  // ---- Roommate requests ----------------------------------------------------
  const e = await makeRegistration(eventId, "e", 1);
  const f = await makeRegistration(eventId, "f", 1);
  await expectLodgingError(addByCode(e, f, fullName(f), "REG-NOSUCHCODE"), "ROOMMATE_NOT_FOUND", "a wrong code");
  const wrongName = await expectLodgingError(addByCode(e, f, "Nobody Atall"), "ROOMMATE_NOT_FOUND", "a wrong name");
  const wrongCode = await expectLodgingError(addByCode(e, f, fullName(f), "REG-NOSUCHCODE"), "ROOMMATE_NOT_FOUND", "a wrong code again");
  assert((wrongName as LodgingError).message === (wrongCode as LodgingError).message, "a wrong name and a wrong code get the same answer");
  const missAudits = await prisma.auditLog.findMany({ where: { eventId, action: "LODGING_ROOMMATE_LOOKUP_MISSED" } });
  assert(missAudits.length >= 3, "each lookup miss is audited");
  const missText = JSON.stringify(missAudits.map((row) => [row.summary, row.metadata]));
  assert(!missText.includes("Nobody Atall") && !missText.includes("NOSUCHCODE") && missText.includes("missesInTheLastHour") && missText.includes(e.id), "a miss records ids and a count, never the typed name or code");
  await expectLodgingError(addByCode(e, e), "ROOMMATE_INVALID", "asking for your own registration by code");
  const cancelled = await makeRegistration(eventId, "x", 1, "CANCELLED");
  await expectLodgingError(addByCode(e, cancelled), "ROOMMATE_NOT_FOUND", "a cancelled registration");

  const asked = await addByCode(e, f);
  assert("id" in asked && asked.created, "a roommate request is recorded");
  const askedAgain = await addByCode(e, f, ` ${fullName(f).toUpperCase()} `, ` ${f.code.toLowerCase()} `);
  assert("id" in askedAgain && !askedAgain.created && askedAgain.id === asked.id, "asking twice is the same request, however the name and code are typed");
  const eView = await view(e);
  assert(eView.roommates.length === 1 && eView.roommates[0]!.status === "WAITING" && eView.roommates[0]!.who === fullName(f), "the asker sees the request as waiting");
  const fView = await view(f);
  assert(fView.roommates.length === 0, "the person asked for sees nothing: no one learns who asked for them");
  assert((await queueKinds()).includes("ONE_SIDED_ROOMMATE"), "a one-sided request is in the review queue");

  const everything = JSON.stringify([eView, fView, await staffView(), await getLodgingRequestExportRows(eventId, prisma)]);
  for (const reg of [e, f, registrationA]) for (const person of reg.people) {
    assert(!everything.includes(person.email) && !everything.includes(person.phone), "no email or phone appears in any lodging view or export");
  }
  assert(!JSON.stringify(fView).includes(e.code) && !JSON.stringify(fView).includes(fullName(e)), "the other side's code and name never reach the registrant it names");

  const back = await changeRegistrantRoommates({ eventId, registrationId: f.id, accessTokenId: `${P}_tok_f`, raw: { action: "add_by_code", name: fullName(e), confirmationCode: e.code }, now: before }, prisma);
  assert("id" in back && back.created, "the other side asks back");
  assert((await view(e)).roommates[0]!.status === "MATCHED" && (await view(f)).roommates[0]!.status === "MATCHED", "both sides ask: the request is mutual");
  assert(!(await queueKinds()).includes("ONE_SIDED_ROOMMATE"), "a mutual request leaves the queue");
  const mutual = (await staffView()).requests;
  assert(mutual.length > 0, "staff see requests");
  // Withdrawing one side makes the other one-sided again, and a registrant cannot withdraw someone else's request.
  await expectLodgingError(changeRegistrantRoommates({ eventId, registrationId: f.id, accessTokenId: `${P}_tok_f`, raw: { action: "withdraw", requestId: asked.id }, now: before }, prisma), "ROOMMATE_NOT_FOUND", "withdrawing another registration's request");
  await changeRegistrantRoommates({ eventId, registrationId: e.id, accessTokenId: `${P}_tok_e`, raw: { action: "withdraw", requestId: asked.id }, now: before }, prisma);
  assert((await view(e)).roommates.length === 0 && (await view(f)).roommates[0]!.status === "WAITING", "withdrawing one side leaves the other one-sided");
  assert(await prisma.eventLodgingRoommateRequest.count({ where: { eventId, id: asked.id, withdrawnAt: { not: null } } }) === 1, "a withdrawn request is kept, not deleted");
  const reAsked = await addByCode(e, f);
  assert("id" in reAsked && reAsked.created && reAsked.id !== asked.id, "after a withdrawal the same pair can ask again as a new request");

  // Staff decide a one-sided request; a decision is final.
  const g = await makeRegistration(eventId, "g", 1);
  const h = await makeRegistration(eventId, "h", 1);
  const gh = await addByCode(g, h);
  assert("id" in gh, "g asks for h");
  assert(await caught(decideRoommateRequest(eventId, userId, { action: "approve", requestId: gh.id, reason: "" }, prisma)), "a decision needs a reason");
  await decideRoommateRequest(eventId, userId, { action: "approve", requestId: gh.id, reason: "Same church group, confirmed by phone" }, prisma);
  assert((await view(g)).roommates[0]!.status === "MATCHED", "staff approval makes a one-sided request mutual");
  await expectLodgingError(decideRoommateRequest(eventId, userId, { action: "decline", requestId: gh.id, reason: "Changed my mind" }, prisma), "ROOMMATE_DECIDED", "deciding twice");
  const approvedRow = await prisma.eventLodgingRoommateRequest.findUniqueOrThrow({ where: { id: gh.id } });
  assert(approvedRow.decision === "APPROVED" && approvedRow.decidedByUserId === userId && approvedRow.decisionReason === "Same church group, confirmed by phone", "a decision keeps actor and reason");
  const ig = await makeRegistration(eventId, "i", 1);
  const gi = await addByCode(ig, g);
  assert("id" in gi, "i asks for g");
  await decideRoommateRequest(eventId, userId, { action: "decline", requestId: gi.id, reason: "Not the same group" }, prisma);
  assert((await view(ig)).roommates[0]!.status === "NOT_MATCHED", "a declined request is not matched");
  assert(await prisma.auditLog.count({ where: { eventId, action: { in: ["LODGING_ROOMMATE_APPROVE", "LODGING_ROOMMATE_DECLINE", "LODGING_ROOMMATE_REQUESTED", "LODGING_ROOMMATE_WITHDRAWN"] } } }) >= 6, "roommate changes are audited");
  await expectLodgingError(decideRoommateRequest(otherEventId, userId, { action: "approve", requestId: gh.id, reason: "Cross-event" }, prisma), "ROOMMATE_NOT_FOUND", "deciding a request of another event");

  // Two people on one registration.
  const sameReg = await makeRegistration(eventId, "j", 2);
  const inside = await changeRegistrantRoommates({ eventId, registrationId: sameReg.id, accessTokenId: `${P}_tok_j`, raw: { action: "add_in_registration", fromPersonId: sameReg.people[0]!.id, targetPersonId: sameReg.people[1]!.id }, now: before }, prisma);
  assert("id" in inside && inside.created && (await view(sameReg)).roommates[0]!.status === "MATCHED" && (await view(sameReg)).roommates[0]!.withinRegistration, "two people on one registration match at once");
  await expectLodgingError(changeRegistrantRoommates({ eventId, registrationId: sameReg.id, accessTokenId: `${P}_tok_j`, raw: { action: "add_in_registration", fromPersonId: sameReg.people[0]!.id, targetPersonId: registrationA.people[0]!.id }, now: before }, prisma), "ROOMMATE_INVALID", "naming a person from another registration");

  // After the deadline a registrant can neither add nor withdraw.
  await expectLodgingError(addByCode(e, h, fullName(h), h.code, after), "DEADLINE_PASSED", "a roommate request after the deadline");

  // The database holds the line too.
  const dupId = `${P}_dup`;
  await expectDatabaseRefusal(prisma.$executeRaw`INSERT INTO "EventLodgingRoommateRequest" ("id","eventId","fromRegistrationId","targetRegistrationId","fromPersonId","targetPersonId","source") VALUES (${dupId}, ${eventId}, ${sameReg.id}, ${sameReg.id}, ${sameReg.people[0]!.id}, ${sameReg.people[0]!.id}, 'REGISTRANT')`, "a request to oneself");
  await prisma.eventLodgingRoommateRequest.create({ data: { eventId, fromRegistrationId: e.id, targetRegistrationId: registrationA.id, source: "REGISTRANT" } });
  await expectDatabaseRefusal(prisma.eventLodgingRoommateRequest.create({ data: { eventId, fromRegistrationId: e.id, targetRegistrationId: registrationA.id, source: "REGISTRANT" } }), "two open requests for the same pair");
  const otherReg = await prisma.registration.create({ data: { eventId: otherEventId, accountHolderPersonId: e.people[0]!.id, confirmationCode: `${P}-other`, status: "CONFIRMED", totalAmount: 0 } });
  await expectDatabaseRefusal(prisma.eventLodgingRoommateRequest.create({ data: { eventId, fromRegistrationId: e.id, targetRegistrationId: otherReg.id, source: "REGISTRANT" } }), "a roommate request across events");
  await expectDatabaseRefusal(prisma.eventLodgingRoommateRequest.create({ data: { eventId, fromRegistrationId: e.id, targetRegistrationId: f.id, targetPersonId: registrationA.people[0]!.id, source: "REGISTRANT" } }), "a named person who is not on the target registration");
  await expectDatabaseRefusal(prisma.eventLodgingRoommateRequest.update({ where: { id: reAsked.id }, data: { targetRegistrationId: g.id } }), "changing who a request names");
  await expectDatabaseRefusal(prisma.eventLodgingRoommateRequest.update({ where: { id: reAsked.id }, data: { accessTokenId: "someone-elses-link" } }), "changing the link a request came through");
  await expectDatabaseRefusal(prisma.eventLodgingRoommateRequest.update({ where: { id: gh.id }, data: { decisionReason: "Rewritten" } }), "rewriting a staff decision");
  await expectDatabaseRefusal(prisma.eventLodgingRoommateRequest.update({ where: { id: gh.id }, data: { decision: "DECLINED" } }), "reversing a staff decision");
  const personKeys = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM pg_constraint WHERE contype = 'f' AND confrelid = '"Person"'::regclass
      AND conrelid IN ('"EventLodgingRoommateRequest"'::regclass, '"EventLodgingRule"'::regclass)`;
  assert(Number(personKeys[0]!.n) === 4, "person ids on roommate requests and rules are foreign keys");
  await expectDatabaseRefusal(prisma.eventLodgingRoommateRequest.delete({ where: { id: reAsked.id } }), "deleting a roommate request");
  await expectDatabaseRefusal(prisma.eventLodgingRoommateRequest.update({ where: { id: asked.id }, data: { withdrawalReason: "Rewritten" } }), "rewriting a withdrawal");
  await expectDatabaseRefusal(prisma.eventLodgingRequest.create({ data: { eventId: otherEventId, registrationId: e.id, currentVersion: 1 } }), "a request whose registration is on another event");
  await expectLodgingError(saveLodgingRequest({ eventId: otherEventId, registrationId: e.id, actor: staff, raw: { category: "TENT", reason: "Wrong event" }, now: before }, prisma), "REGISTRATION_NOT_FOUND", "saving for a registration of another event");

  // ---- Conflicts and impossible requests -----------------------------------
  const k = await makeRegistration(eventId, "k", 1);
  const l = await makeRegistration(eventId, "l", 1);
  await save(k, { category: "RV_SITE", partySize: 1, firstNight: "2027-06-15", lastNight: "2027-06-16" });
  await save(l, { category: "TENT", partySize: 1, firstNight: "2027-06-17", lastNight: "2027-06-18" });
  await addByCode(k, l);
  await addByCode(l, k);
  const conflictKinds = await queueKinds();
  assert(conflictKinds.includes("CONFLICT_CATEGORY") && conflictKinds.includes("IMPOSSIBLE_DATES"), `mutual roommates who want different lodging on different nights are both listed, got ${conflictKinds.join()}`);

  // ---- Household rules ------------------------------------------------------
  // The declaration must be made on the minor's own registration, with an adult on it (the guardian-authority rule).
  const adultReg = await makeRegistration(eventId, "m", 2);
  const adult = adultReg.people[0]!;
  const teen = adultReg.people[1]!;
  const declared = await prisma.guardianAuthority.create({
    data: { eventId, registrationId: adultReg.id, minorPersonId: teen.id, adultPersonId: adult.id, source: "REGISTRATION_FORM" },
  });
  const withGuardian = await staffView();
  assert(withGuardian.derivedGroups.some((group) => group.minor === `${teen.first} ${teen.last}` && group.adult === `${adult.first} ${adult.last}`), "a minor is kept with the declared responsible adult by a system rule");
  assert(!(await queueKinds()).includes("CONFLICT_SEPARATION"), "no separation conflict yet");
  const apart = await createLodgingRule(eventId, userId, { kind: "SEPARATE", personAId: teen.id, personBId: adult.id, reason: "Staff decision for the test" }, prisma);
  assert((await queueKinds()).includes("CONFLICT_SEPARATION"), "a keep-apart rule that contradicts the household and responsible adult is a conflict");
  await expectLodgingError(createLodgingRule(eventId, userId, { kind: "SEPARATE", personAId: adult.id, personBId: teen.id, reason: "Same pair, other order" }, prisma), "RULE_INVALID", "the same pair entered the other way round");
  const ruleRow = await prisma.eventLodgingRule.findUniqueOrThrow({ where: { id: apart.id } });
  assert(ruleRow.personAId < ruleRow.personBId!, "a pair is stored in id order");
  assert(ruleRow.actorUserId === userId && ruleRow.reason === "Staff decision for the test" && ruleRow.endedAt === null, "a rule keeps its actor and reason");
  await expectLodgingError(createLodgingRule(eventId, userId, { kind: "KEEP_TOGETHER", personAId: adult.id, personBId: cancelled.people[0]!.id, reason: "Cancelled" }, prisma), "PERSON_NOT_ON_EVENT", "a person on a cancelled registration");
  await expectDatabaseRefusal(prisma.eventLodgingRule.delete({ where: { id: apart.id } }), "deleting a rule");
  await expectDatabaseRefusal(prisma.eventLodgingRule.update({ where: { id: apart.id }, data: { reason: "Rewritten" } }), "rewriting a rule");
  await expectDatabaseRefusal(prisma.eventLodgingRule.create({ data: { eventId, kind: "SEPARATE", personAId: "zzz_not_a_person", personBId: "zzzz_not_a_person", reason: "x" } }), "a rule naming people who are not on the event");
  await expectDatabaseRefusal(prisma.eventLodgingRule.create({ data: { eventId, kind: "SEPARATE", personAId: ruleRow.personBId!, personBId: ruleRow.personAId, reason: "Wrong order" } }), "a pair stored out of order");
  await expectDatabaseRefusal(prisma.eventLodgingRule.create({ data: { eventId, kind: "SPLIT_HOUSEHOLD", personAId: ruleRow.personAId, personBId: ruleRow.personBId, reason: "A split names one person" } }), "a split naming two people");

  // Splitting the minor out of the household does not undo the responsible-adult rule; revoking the declaration does.
  const split = await createLodgingRule(eventId, userId, { kind: "SPLIT_HOUSEHOLD", personAId: teen.id, reason: "Teen rooms with the youth group", effectiveFrom: "2027-06-15", effectiveUntil: "2027-06-18" }, prisma);
  assert((await queueKinds()).includes("CONFLICT_SEPARATION"), "a split does not override the responsible-adult rule");
  await prisma.guardianAuthority.update({ where: { id: declared.id }, data: { state: "REVOKED", revokedAt: new Date(), revocationReason: "Test" } });
  assert(!(await queueKinds()).includes("CONFLICT_SEPARATION"), "with the declaration revoked, the split takes the minor out of the household");
  assert((await staffView()).derivedGroups.length === withGuardian.derivedGroups.length - 1, "a revoked declaration no longer keeps them together");
  await endLodgingRule(eventId, userId, split.id, "Back with the family", prisma);
  assert((await queueKinds()).includes("CONFLICT_SEPARATION"), "ending the split brings the household back");
  await endLodgingRule(eventId, userId, apart.id, "Resolved with the family", prisma);
  assert(!(await queueKinds()).includes("CONFLICT_SEPARATION"), "ending the rule clears the conflict");
  await expectLodgingError(endLodgingRule(eventId, userId, apart.id, "Again", prisma), "RULE_ENDED", "ending twice");
  const ended = await prisma.eventLodgingRule.findUniqueOrThrow({ where: { id: apart.id } });
  assert(ended.endedAt !== null && ended.endedByUserId === userId && ended.endReason === "Resolved with the family", "an ended rule keeps who ended it and why");
  assert((await staffView()).rules.some((rule) => rule.id === apart.id && rule.ended && rule.endReason === "Resolved with the family"), "ended rules stay in the history");
  await expectDatabaseRefusal(prisma.eventLodgingRule.update({ where: { id: apart.id }, data: { endReason: "Edited" } }), "editing an ended rule");

  // A registration that says its party can be split is not joined into one group.
  const flexReg = await makeRegistration(eventId, "fx", 2);
  const flexApart = await createLodgingRule(eventId, userId, { kind: "SEPARATE", personAId: flexReg.people[0]!.id, personBId: flexReg.people[1]!.id, reason: "Keep these two apart" }, prisma);
  await save(flexReg, { category: null, householdPreference: "TOGETHER" });
  assert((await queueKinds()).includes("CONFLICT_SEPARATION"), "a party that stays together conflicts with a keep-apart rule inside it");
  await save(flexReg, { category: null, householdPreference: "FLEXIBLE" });
  assert(!(await queueKinds()).includes("CONFLICT_SEPARATION"), "a flexible party is not joined for conflict detection");
  await endLodgingRule(eventId, userId, flexApart.id, "Done", prisma);

  // A household that changes: join two registrations, then move a person to another registration.
  const sep2 = await createLodgingRule(eventId, userId, { kind: "SEPARATE", personAId: teen.id, personBId: f.people[0]!.id, reason: "Keep these two apart" }, prisma);
  assert(!(await queueKinds()).includes("CONFLICT_SEPARATION"), "different registrations are not kept together");
  const join = await createLodgingRule(eventId, userId, { kind: "KEEP_TOGETHER", personAId: f.people[0]!.id, personBId: adult.id, reason: "Families are traveling together" }, prisma);
  assert((await queueKinds()).includes("CONFLICT_SEPARATION"), "a staff keep-together rule that joins two households is checked against keep-apart rules");
  await endLodgingRule(eventId, userId, join.id, "Plans changed", prisma);
  assert(!(await queueKinds()).includes("CONFLICT_SEPARATION"), "ending the join clears it");
  await prisma.registrationAttendee.updateMany({ where: { eventId, registrationId: adultReg.id, personId: teen.id }, data: { registrationId: f.id } });
  assert((await queueKinds()).includes("CONFLICT_SEPARATION"), "a person who moves to another registration is kept with that household");
  await prisma.registrationAttendee.updateMany({ where: { eventId, registrationId: f.id, personId: teen.id }, data: { registrationId: adultReg.id } });
  assert(!(await queueKinds()).includes("CONFLICT_SEPARATION"), "and moving back undoes it");
  await endLodgingRule(eventId, userId, sep2.id, "Done", prisma);

  // ---- Restricted accommodations -------------------------------------------
  const sensitiveView = await staffView(true);
  const blindView = await staffView(false);
  const flagged = sensitiveView.requests.find((request) => request.registrationId === registrationA.id)!;
  assert(flagged.groundFloorNeeded === true, "staff with VIEW_SENSITIVE_DATA see the flag");
  assert(blindView.requests.every((request) => !("groundFloorNeeded" in request) && !("accessibleRoomNeeded" in request)), "staff without it get no flag fields at all");
  assert(sensitiveView.queue.some((item) => item.kind === "ACCESSIBILITY_NEEDED"), "the flagged request is in the queue for staff who may see it");
  const sensitiveHistory = sensitiveView.requests.find((request) => request.registrationId === registrationA.id)!.history;
  const blindHistory = blindView.requests.find((request) => request.registrationId === registrationA.id)!.history;
  assert(sensitiveHistory.some((entry) => entry.reason === "Guest phoned the office"), "staff who may see the flags see the history reasons");
  assert(blindHistory.every((entry) => entry.reason === null) && blindHistory.length < sensitiveHistory.length, "staff who may not see them get no reasons and no version that changed only the flags");
  assert(blindView.requests.find((request) => request.registrationId === registrationA.id)!.version === blindHistory.length, "and the version number does not reveal the hidden one");
  assert(blindView.queue.every((item) => !item.sensitive) && !JSON.stringify(blindView).includes("ground floor"), "the queue never mentions accessibility to staff who may not see it");
  const exportRows = await getLodgingRequestExportRows(eventId, prisma);
  const plainCsv = lodgingRequestsCsv(exportRows, false);
  assert(!/ground floor|accessible/i.test(plainCsv) && plainCsv.includes(registrationA.code), "the general export has the approved fields and no accessibility columns");
  assert(/Ground floor needed/.test(lodgingRequestsCsv(exportRows, true)), "the accessibility columns appear for staff who may see them");
  assert(!plainCsv.includes(registrationA.people[0]!.last) && !plainCsv.includes(registrationA.people[0]!.email), "the export holds no names or contact details");

  // ---- Acknowledging review items ------------------------------------------
  await save(registrationA, { category: "DORM_ROOM", partySize: 1, reason: "Late staff change" }, staff, after);
  const ackSource = (await staffView()).queue.find((item) => item.kind === "PAST_DEADLINE");
  assert(ackSource, "a late-change item is available to acknowledge");
  await expectLodgingError(acknowledgeReviewItem(eventId, { userId, canSeeSensitive: true }, { action: "acknowledge", itemKey: ackSource.key, fingerprint: "stale", note: "Seen" }, prisma), "ITEM_NOT_FOUND", "a stale fingerprint");
  assert(await caught(acknowledgeReviewItem(eventId, { userId, canSeeSensitive: true }, { action: "acknowledge", itemKey: ackSource.key, fingerprint: ackSource.fingerprint, note: "" }, prisma)), "an acknowledgement needs a note");
  await acknowledgeReviewItem(eventId, { userId, canSeeSensitive: true }, { action: "acknowledge", itemKey: ackSource.key, fingerprint: ackSource.fingerprint, note: "Checked with the guest" }, prisma);
  const acked = await acknowledgeReviewItem(eventId, { userId, canSeeSensitive: true }, { action: "acknowledge", itemKey: ackSource.key, fingerprint: ackSource.fingerprint, note: "Checked with the guest" }, prisma);
  assert(acked.alreadyAcknowledged, "acknowledging twice is harmless");
  assert(!(await queueKinds()).includes("PAST_DEADLINE") && (await staffView()).queue.some((item) => item.key === ackSource.key && item.acknowledged), "an acknowledged item leaves the open queue but stays listed");
  await save(registrationA, { category: "DORM_ROOM", partySize: 2, reason: "Changed again after the deadline" }, staff, after);
  assert((await queueKinds()).includes("PAST_DEADLINE"), "an acknowledged item returns when the request changes");
  const sensitiveItem = (await staffView(true)).queue.find((item) => item.sensitive)!;
  await expectLodgingError(acknowledgeReviewItem(eventId, { userId, canSeeSensitive: false }, { action: "acknowledge", itemKey: sensitiveItem.key, fingerprint: sensitiveItem.fingerprint, note: "Seen" }, prisma), "ITEM_NOT_FOUND", "acknowledging a restricted item without access");
  await acknowledgeReviewItem(eventId, { userId, canSeeSensitive: true }, { action: "acknowledge", itemKey: sensitiveItem.key, fingerprint: sensitiveItem.fingerprint, note: "Needs a ramp near the entrance" }, prisma);
  const restrictedAck = await prisma.eventLodgingReviewAck.findFirstOrThrow({ where: { eventId, itemKey: sensitiveItem.key } });
  assert(restrictedAck.note === "Acknowledged (restricted item)", "a restricted item stores no typed note");
  const restrictedAudit = await prisma.auditLog.findFirstOrThrow({ where: { eventId, action: "LODGING_REVIEW_ACKNOWLEDGED", metadata: { path: ["restricted"], equals: true } } });
  assert(!JSON.stringify(restrictedAudit).includes("ramp") && !restrictedAudit.summary.toLowerCase().includes("accessib") && restrictedAudit.entityId === null, "its audit entry is generic");
  const ackRow = await prisma.eventLodgingReviewAck.findFirstOrThrow({ where: { eventId } });
  await expectDatabaseRefusal(prisma.eventLodgingReviewAck.update({ where: { id: ackRow.id }, data: { note: "Rewritten" } }), "rewriting an acknowledgement");
  await expectDatabaseRefusal(prisma.eventLodgingReviewAck.delete({ where: { id: ackRow.id } }), "deleting an acknowledgement");

  // ---- Registrations that are not active ------------------------------------
  const waitlisted = await makeRegistration(eventId, "w", 1, "WAITLISTED");
  await expectLodgingError(save(waitlisted, { category: "TENT" }), "REGISTRATION_NOT_ACTIVE", "a waitlisted registration");
  await save(b, { category: "TENT_WITH_POWER", partySize: 1 });
  await prisma.registration.update({ where: { id: b.id }, data: { status: "CANCELLED" } });
  assert(!(await getLodgingRequestExportRows(eventId, prisma)).some((row) => row.confirmationCode === b.code), "a cancelled registration drops out of the export");
  assert(!(await staffView()).requests.some((request) => request.registrationId === b.id), "and out of the request list");

  // ---- Rows go with their event, and the property inventory stays ----------
  const counts = async () => Promise.all([
    prisma.eventLodgingRequest.count({ where: { eventId } }),
    prisma.eventLodgingRequestVersion.count({ where: { eventId } }),
    prisma.eventLodgingRoommateRequest.count({ where: { eventId } }),
    prisma.eventLodgingRule.count({ where: { eventId } }),
    prisma.eventLodgingReviewAck.count({ where: { eventId } }),
  ]);
  assert((await counts()).every((count) => count > 0), `the event holds rows of every kind before deletion: ${(await counts()).join()}`);
  // A registration removed on its own takes its request, versions and roommate requests with it.
  const gone = await makeRegistration(eventId, "z", 1);
  await save(gone, { category: "TENT" });
  await addByCode(gone, h);
  await prisma.registration.delete({ where: { id: gone.id } });
  assert(await prisma.eventLodgingRequest.count({ where: { registrationId: gone.id } }) === 0 && await prisma.eventLodgingRoommateRequest.count({ where: { fromRegistrationId: gone.id } }) === 0, "deleting a registration removes its lodging rows");
  await prisma.event.delete({ where: { id: eventId } });
  const left = await counts();
  assert(left.every((count) => count === 0), `deleting an event removes its preference rows, left ${left.join()}`);
  assert(await prisma.lodgingUnit.count() > 0, "the property inventory survives");

  console.log("Lodging preferences verified.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await cleanup(); } catch (error) { console.error("Cleanup failed:", error instanceof Error ? error.message : error); process.exitCode = 1; }
    await prisma.$disconnect();
  });
