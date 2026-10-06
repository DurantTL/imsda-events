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
import { changeHold, createHold, selectEventProperty, setEventRate, updateEventUnit, getLodgingView } from "@/modules/lodging/service";
import { getPublicPromoCodeQuote } from "@/modules/promo-codes/repository";
import { syncLodgingTemplates } from "@/modules/lodging/sync";
import { CHURCH_SPONSOR_CONTACT_LEAD, CHURCH_SPONSOR_WARNING, chargeChangeSentence } from "@/modules/lodging/preferences-domain";
import { readFileSync } from "node:fs";

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
const churchEventId = `${P}_ev_church`;
const waitEventId = `${P}_ev_wait`;
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
  await prisma.lodgingUnit.updateMany({ where: { category: "CONFERENCE_CENTER_ROOM", linensProvided: { not: null } }, data: { linensProvided: null } });
  await prisma.lodgingUnit.updateMany({ where: { category: "CONFERENCE_CENTER_ROOM", kind: { not: "ROOM" } }, data: { kind: "ROOM" } });
  const registrationIds = (await prisma.registration.findMany({ where: { eventId: { startsWith: `${P}_` } }, select: { id: true } })).map((row) => row.id);
  await prisma.messageOutbox.deleteMany({ where: { registrationId: { in: registrationIds } } });
  await prisma.event.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.person.deleteMany({ where: { lastName: surname } });
  await prisma.organization.deleteMany({ where: { id: `${P}_church` } });
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
        { id: `${P}_f_fee`, key: "registration_fee", label: "Registration fee", helpText: "", type: "CHECKBOX", scope: "REGISTRATION", required: false, options: [], priceCents: 5000 },
        { id: `${P}_f_promo`, key: "promo_code", label: "Promo code", helpText: "", type: "TEXT", scope: "REGISTRATION", required: false, options: [] },
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
function formInput(versionId: string, people: number, lodging?: unknown, extraResponses: Record<string, unknown> = {}): PublicRegistrationInput {
  submissions += 1;
  const n = submissions;
  return {
    versionId,
    idempotencyKey: randomUUID(),
    responses: { primary_contact_first_name: "Lo", primary_contact_last_name: `Holder${n}`, email: `${P}.sub${n}@lodging.example.test`, ...extraResponses },
    attendees: Array.from({ length: people }, (_, index) => ({ clientId: `p${index}`, responses: { first_name: `Guest${n}x${index}`, last_name: surname } })),
    ...(lodging !== undefined ? { lodging } : {}),
    website: "",
  } as PublicRegistrationInput;
}

type Target = { eventId: string; versionId: string };
const mainTarget: Target = { eventId, versionId: ids.formVersion };
const churchTarget: Target = { eventId: churchEventId, versionId: `${ids.formVersion}_c` };
const waitTarget: Target = { eventId: waitEventId, versionId: `${ids.formVersion}_w` };

/** A real public submission through the same transaction the form uses (the registration, its pricing and its lodging). */
async function submitTo(target: Target, options: { people: number; lodging?: unknown; responses?: Record<string, unknown> }) {
  const result = await submitPublicRegistration(slugOf(target.eventId), formSlug, formInput(target.versionId, options.people, options.lodging, options.responses), before);
  const registration = await prisma.registration.findFirstOrThrow({
    where: { eventId: target.eventId, confirmationCode: result.confirmationCode },
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
const submitForm = (options: { people: number; lodging?: unknown; responses?: Record<string, unknown> }) => submitTo(mainTarget, options);

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
  await createEvent(churchEventId, { billingMode: "DEFERRED_ORGANIZATION_INVOICE" });
  await createEvent(waitEventId, { capacity: 1, waitlistEnabled: true });
  for (const [id, suffix] of [[churchEventId, "c"], [waitEventId, "w"]] as const) {
    await selectEventProperty(id, userId, { propertyKey: "sunnydale-academy" }, prisma);
    await updateLodgingSettings(id, userId, { collectsPreferences: true }, prisma);
    await prisma.registrationForm.create({
      data: {
        id: `${ids.form}_${suffix}`, eventId: id, createdByUserId: userId, name: formDefinition.title, slug: formSlug, status: RegistrationFormStatus.PUBLISHED,
        versions: { create: { id: `${ids.formVersion}_${suffix}`, createdByUserId: userId, versionNumber: 1, status: RegistrationFormStatus.PUBLISHED, publishedAt: new Date(), definition: formDefinition } },
      },
    });
  }
  await setEventRate(churchEventId, userId, { category: "DORM_ROOM", rate: { amountCents: 2000, basis: "PER_UNIT_NIGHT", minimumNights: null } }, prisma);
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
  const second = await save(registrationA, { category: "CONFERENCE_CENTER_ROOM", partySize: 2, bringsExtraBedding: true, firstNight: "2027-06-16", lastNight: "2027-06-17" });
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
  assert((await saveAny(shortStay, { category: "DORM_ROOM", firstNight: "2027-06-15", lastNight: "2027-06-16" })).changeRequested === true, "the minimum number of nights is accepted, and a first priced choice after registering goes to the event team");
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

  // A room-type category is counted in ROOMS (#803). A full type is refused at submit, and five racing for the last ROOM
  // leave exactly one winner.
  const unitsOf = async (category: string) => (await getLodgingView(eventId, prisma)).buildings.flatMap((building) => building.units).filter((unit) => unit.category === category && unit.assignable && !unit.unavailable && !unit.retired);
  const ccRows = await unitsOf("CONFERENCE_CENTER_ROOM");
  const dormRows = await unitsOf("DORM_ROOM");
  /** Leaves exactly `free` rooms of a category free: only the rooms already asked for, plus `free`, stay in service. */
  const roomsLeft = async (category: "CONFERENCE_CENTER_ROOM" | "DORM_ROOM", free: number) => {
    const rows = category === "DORM_ROOM" ? dormRows : ccRows;
    const requested = (await staffView()).offered.find((entry) => entry.category === category)!.requested;
    assert(rows.length >= requested + free, `enough ${category} rooms to leave ${free} free (${requested} asked for, ${rows.length} exist)`);
    for (const [index, row] of rows.entries()) await updateEventUnit(eventId, row.eventUnitId, userId, { capacityOverride: index < requested + free ? 2 : 0 }, prisma);
  };
  const restoreRooms = async (rows: typeof ccRows) => { for (const row of rows) await updateEventUnit(eventId, row.eventUnitId, userId, { capacityOverride: null }, prisma); };
  await roomsLeft("CONFERENCE_CENTER_ROOM", 1);
  const cc2 = await submitForm({ people: 1, lodging: { category: "CONFERENCE_CENTER_ROOM", partySize: 1 } });
  assert(cc2.snapshot.totalCents === 0, "the last room is taken at submit");
  const full = await caught(submitForm({ people: 1, lodging: { category: "CONFERENCE_CENTER_ROOM", partySize: 1 } }));
  assert(full instanceof PublicRegistrationError && full.issues[0]?.key === "lodging" && /Lodging step: .*full/.test(full.message), "a full type is refused at submit with a field error naming the step");
  // Exactly one room left, then race.
  await roomsLeft("CONFERENCE_CENTER_ROOM", 1);
  const racersBefore = await prisma.registration.count({ where: { eventId } });
  const racedSubmits = await Promise.all([1, 2, 3, 4, 5].map(() => caught(submitForm({ people: 1, lodging: { category: "CONFERENCE_CENTER_ROOM", partySize: 1 } }))));
  const winners = racedSubmits.filter((outcome) => !(outcome instanceof Error));
  assert(winners.length === 1, `exactly one of five racing submissions gets the last room, got ${winners.length}: ${racedSubmits.map((outcome) => (outcome instanceof Error ? outcome.message.slice(0, 60) : "ok")).join(" | ")}`);
  assert(racedSubmits.filter((outcome) => outcome instanceof PublicRegistrationError && outcome.issues[0]?.key === "lodging").length === 4, "the other four are told the lodging step is full");
  assert(await prisma.registration.count({ where: { eventId } }) === racersBefore + 1, "and only the winner has a registration");
  await restoreRooms(ccRows);

  // Rooms, not people, are what runs out: a party of six in one room takes one room, so the last room still goes to one
  // winner when two parties race for it, however many people each brings. (A party needing two rooms with one left is refused.)
  await roomsLeft("DORM_ROOM", 1);
  const bigParty = (ack = true) => submitForm({ people: 6, lodging: { category: "DORM_ROOM", partySize: 6, roomCount: 1, ...(ack ? { bringsExtraBedding: true } : {}), firstNight: "2027-06-15", lastNight: "2027-06-16" } });
  const twoRooms = await caught(submitForm({ people: 4, lodging: { category: "DORM_ROOM", partySize: 4, roomCount: 2, firstNight: "2027-06-15", lastNight: "2027-06-16" } }));
  assert(twoRooms instanceof PublicRegistrationError && /Only 1 room is free/.test(twoRooms.message), `two rooms with one left is refused and says how many are free, got ${String(twoRooms instanceof Error ? twoRooms.message : twoRooms)}`);
  const raceOutcomes = await Promise.all([bigParty(), bigParty(), submitForm({ people: 1, lodging: { category: "DORM_ROOM", partySize: 1, firstNight: "2027-06-15", lastNight: "2027-06-16" } })].map((promise) => caught(promise)));
  assert(raceOutcomes.filter((outcome) => !(outcome instanceof Error)).length === 1, `exactly one of three parties gets the last dorm room, got ${raceOutcomes.filter((outcome) => !(outcome instanceof Error)).length}: ${raceOutcomes.map((outcome) => (outcome instanceof Error ? outcome.message.slice(0, 50) : "ok")).join(" | ")}`);
  await restoreRooms(dormRows);

  // After submission, a lodging edit never changes the registration's total or its pricing. The charge was set once, when
  // the registration was submitted; staff adjust it through Payments.
  const dormStored = async () => {
    const submission = await prisma.publicRegistrationSubmission.findFirstOrThrow({ where: { registrationId: dorm.reg.id } });
    return { snapshot: submission.pricingSnapshot as Record<string, unknown>, total: Number((await prisma.registration.findUniqueOrThrow({ where: { id: dorm.reg.id } })).totalAmount) };
  };
  const heldDorm = await saveAny(dorm.reg, { category: "DORM_ROOM", firstNight: "2027-06-15", lastNight: "2027-06-18", partySize: 2 });
  assert(heldDorm.changeRequested === true, "an unpaid registrant's change that alters the charge becomes a change request");
  assert((await dormStored()).total === 60 && lodgingLineOf((await dormStored()).snapshot)?.amountCents === 6000, "and the total and the stored pricing are unchanged");
  assert((await prisma.eventLodgingRequest.findFirstOrThrow({ where: { registrationId: dorm.reg.id } })).currentVersion === 1, "and nothing was applied to the request");
  const changeItem = (await staffView()).queue.find((item) => item.kind === "CHANGE_REQUESTED" && item.registrationIds.includes(dorm.reg.id));
  assert(changeItem && /lodging charge change requested \(list \+\$20\.00\)/.test(changeItem.title), `the queue shows the change and its amount, got ${changeItem?.title}`);
  // A change that leaves the charge alone still applies.
  assert((await save(dorm.reg, { category: "DORM_ROOM", firstNight: "2027-06-15", lastNight: "2027-06-17", partySize: 2, privateRoomRequested: true })).changed, "a change that does not alter the charge is applied");
  // A staff change is saved; the charge is theirs to adjust in Payments, and the answer says so.
  const staffGrew = await saveAny(dorm.reg, { category: "DORM_ROOM", firstNight: "2027-06-15", lastNight: "2027-06-18", partySize: 2, reason: "Guest phoned to add a night" }, staff);
  assert(!staffGrew.changeRequested && staffGrew.priceNeedsReview === true && staffGrew.chargeDeltaCents === 2000, "a staff change that alters the charge is saved and flagged with its amount");
  assert((await dormStored()).total === 60 && lodgingLineOf((await dormStored()).snapshot)?.amountCents === 6000, "the total is still untouched");
  assert(await prisma.eventLodgingChangeRequest.count({ where: { registrationId: dorm.reg.id, resolvedAt: null } }) === 0, "and the registrant's open request is handled");
  assert((await staffView()).queue.some((item) => item.kind === "PRICE_DIFFERS" && item.registrationIds.includes(dorm.reg.id)), "the queue lists the charge that differs from the request");
  // A rate change alone is not a charge change: a non-pricing edit still applies.
  await setEventRate(eventId, userId, { category: "DORM_ROOM", rate: { amountCents: 2500, basis: "PER_UNIT_NIGHT", minimumNights: 2 } }, prisma);
  assert((await save(dorm.reg, { category: "DORM_ROOM", firstNight: "2027-06-15", lastNight: "2027-06-18", partySize: 2, privateRoomRequested: false })).changed, "a rate change alone does not turn a non-pricing edit into a change request");
  await setEventRate(eventId, userId, { category: "DORM_ROOM", rate: { amountCents: 2000, basis: "PER_UNIT_NIGHT", minimumNights: 2 } }, prisma);

  // Rooms (#803): the registrant chooses how many; a per-room rate charges that many, never a party divided by a room size.
  const dormOffer = offer.categories.find((entry) => entry.category === "DORM_ROOM");
  assert(dormOffer?.unitCapacity === 2 && dormOffer.roomBased === true, `a dorm room sleeps 2 and the form asks how many rooms, got ${JSON.stringify(dormOffer)}`);
  assert(offer.categories.filter((entry) => entry.category === "RV_SITE" || entry.category === "TENT" || entry.category === "TENT_WITH_POWER").every((entry) => entry.roomBased === false), "a site or a tent is one unit: no room question");
  assert(dormOffer.roomBeds && Object.values(dormOffer.roomBeds).every((beds) => beds.length > 0 && beds.every((value, index) => index === 0 || beds[index - 1]! >= value)) && dormOffer.linens === "NONE", "the offer carries each night's beds, largest first, and linens, an unknown counting as not provided");
  // The bring-your-own-bedding note is data-driven: nothing when every unit of a type provides linens, "most rooms" when some do.
  const linensOf = async () => (await getPublicLodgingOffer(eventId, prisma))!.categories.find((entry) => entry.category === "CONFERENCE_CENTER_ROOM")!.linens;
  await prisma.lodgingUnit.updateMany({ where: { category: "CONFERENCE_CENTER_ROOM", key: "cc-01" }, data: { linensProvided: true } });
  assert(await linensOf() === "SOME", "one unit with linens makes it SOME");
  await prisma.lodgingUnit.updateMany({ where: { category: "CONFERENCE_CENTER_ROOM" }, data: { linensProvided: true } });
  assert(await linensOf() === "ALL" && (await view(registrationA)).offered.find((entry) => entry.category === "CONFERENCE_CENTER_ROOM")?.linens === "ALL", "every unit with linens makes it ALL, on the form and the private page");
  await prisma.lodgingUnit.updateMany({ where: { category: "CONFERENCE_CENTER_ROOM" }, data: { linensProvided: false } });
  assert(await linensOf() === "NONE", "a unit that says no counts as not provided, like an unknown one");
  await prisma.lodgingUnit.updateMany({ where: { category: "CONFERENCE_CENTER_ROOM" }, data: { linensProvided: null } });
  const dormNights = { firstNight: "2027-06-15", lastNight: "2027-06-16" };
  // The over-beds threshold is the best case: the largest rooms in service. Lower the three big special-use rooms (8 beds)
  // so the largest room is Boys 302 (4 beds) and two rooms hold 6.
  for (const row of dormRows.filter((unit) => /^boys-31[456]$/.test(unit.key))) await updateEventUnit(eventId, row.eventUnitId, userId, { capacityOverride: 2 }, prisma);
  const noAck = await caught(submitForm({ people: 6, lodging: { category: "DORM_ROOM", partySize: 6, roomCount: 1, ...dormNights } }));
  assert(noAck instanceof PublicRegistrationError && noAck.issues[0]?.key === "lodging" && /sleeping bags or air mattresses/.test(noAck.message) && !/more rooms/.test(noAck.message), `a party above even the biggest room needs the acknowledgement, without pushing more rooms: ${String(noAck instanceof Error ? noAck.message : noAck)}`);
  const four = await submitForm({ people: 4, lodging: { category: "DORM_ROOM", partySize: 4, roomCount: 1, ...dormNights } });
  assert((await prisma.eventLodgingRequestVersion.findFirstOrThrow({ where: { request: { registrationId: four.reg.id } } })).bringsExtraBedding === false, "a party of four fits the biggest room: no acknowledgement is asked, though most rooms sleep two");
  const six = await submitForm({ people: 6, lodging: { category: "DORM_ROOM", partySize: 6, roomCount: 1, bringsExtraBedding: true, ...dormNights } });
  const sixLine = lodgingLineOf(six.snapshot);
  assert(sixLine?.amountCents === 2000 * 2 * 1 && sixLine.label === "Lodging: Dorm room", `a party of 6 in one room pays for one room, got ${JSON.stringify(sixLine)}`);
  const sixVersion = await prisma.eventLodgingRequestVersion.findFirstOrThrow({ where: { request: { registrationId: six.reg.id } } });
  assert(sixVersion.roomCount === 1 && sixVersion.bringsExtraBedding === true && sixVersion.partySize === 6, "the room count and the extra-bedding acknowledgement are stored on the request version");
  const sixStaff = (await staffView()).requests.find((request) => request.registrationId === six.reg.id);
  assert(sixStaff?.roomCount === 1 && sixStaff.bringsExtraBedding === true, "and staff see them on the request");
  assert((await staffView()).queue.some((item) => item.kind === "EXTRA_BEDDING" && item.registrationIds.includes(six.reg.id) && /party of 6 in 1 room, bringing sleeping bags or air mattresses/.test(item.title)), "and in the review queue");
  assert((await getLodgingRequestExportRows(eventId, prisma)).find((row) => row.confirmationCode === six.reg.code)?.bringsExtraBedding === true, "and in the export");
  const threeRooms = await submitForm({ people: 6, lodging: { category: "DORM_ROOM", partySize: 6, roomCount: 3, ...dormNights } });
  const threeLine = lodgingLineOf(threeRooms.snapshot);
  assert(threeLine?.amountCents === 2000 * 2 * 3 && threeLine.label === "Lodging: Dorm room (3 rooms)", `three rooms are charged as three, got ${JSON.stringify(threeLine)}`);
  assert((await prisma.eventLodgingRequestVersion.findFirstOrThrow({ where: { request: { registrationId: threeRooms.reg.id } } })).bringsExtraBedding === false, "and a party that fits its rooms stores no extra-bedding flag");
  const tooManyRooms = await caught(submitForm({ people: 2, lodging: { category: "DORM_ROOM", partySize: 2, roomCount: 3, ...dormNights } }));
  assert(tooManyRooms instanceof PublicRegistrationError && tooManyRooms.issues[0]?.key === "lodging" && /between 1 and 2 rooms/.test(tooManyRooms.message), "more rooms than people is refused");
  const siteRooms = await submitForm({ people: 4, lodging: { category: "RV_SITE", partySize: 4, roomCount: 3 } });
  assert(lodgingLineOf(siteRooms.snapshot)?.amountCents === 15000 && lodgingLineOf(siteRooms.snapshot)?.label === "Lodging: RV site", "a party at an RV site is one site, whatever room count is sent");
  assert((await prisma.eventLodgingRequestVersion.findFirstOrThrow({ where: { request: { registrationId: siteRooms.reg.id } } })).roomCount === 1, "and stores one unit");
  // A registrant's later change of room count that alters the charge goes to staff like any other priced change.
  const moreRooms = await saveAny(six.reg, { category: "DORM_ROOM", ...dormNights, partySize: 6, roomCount: 2, bringsExtraBedding: true });
  assert(moreRooms.changeRequested === true, "asking for more rooms after submitting is a change request, never an automatic charge");
  assert((await prisma.eventLodgingChangeRequest.findFirstOrThrow({ where: { registrationId: six.reg.id, resolvedAt: null } })).roomCount === 2, "that carries the room count");
  // Staff see what was asked for: on the request, and in the queue item with the rooms and the bedding.
  const sixOpen = (await staffView()).requests.find((request) => request.registrationId === six.reg.id)?.openChange;
  assert(sixOpen?.roomCount === 2 && sixOpen.partySize === 6 && sixOpen.category === "DORM_ROOM", "the staff request shows the open change request's rooms");
  const sixChange = (await staffView()).queue.find((item) => item.kind === "CHANGE_REQUESTED" && item.registrationIds.includes(six.reg.id));
  assert(sixChange && /6 people, 2 rooms/.test(sixChange.title), `and the queue item says how many rooms were asked for, got ${sixChange?.title}`);

  // The acknowledgement is the registrant's own. A staff edit never records one, an edit that is not about rooms never
  // asks for one, and a registrant who changes the party is asked.
  const bedReg = await makeRegistration(eventId, "bd", 6);
  const latestVersion = async (registrationId: string) => prisma.eventLodgingRequestVersion.findFirstOrThrow({ where: { request: { registrationId } }, orderBy: { version: "desc" } });
  const staffBeds = await saveAny(bedReg, { category: "DORM_ROOM", partySize: 6, roomCount: 1, ...dormNights, bringsExtraBedding: true, reason: "Phoned the office" }, staff);
  assert(!staffBeds.changeRequested, "a staff edit of a party above the beds is not refused");
  const staffVersion = await prisma.eventLodgingRequestVersion.findFirstOrThrow({ where: { request: { registrationId: bedReg.id } }, orderBy: { version: "desc" } });
  assert(staffVersion.source === "STAFF" && staffVersion.bringsExtraBedding === false, "and records no acknowledgement (staff cannot give the registrant's), even when the staff request carried the flag");
  assert((await save(bedReg, { category: "DORM_ROOM", partySize: 6, ...dormNights, privateRoomRequested: true })).changed, "an unrelated registrant edit of that request is not refused for a missing acknowledgement");
  assert((await prisma.eventLodgingRequestVersion.findFirstOrThrow({ where: { request: { registrationId: bedReg.id } }, orderBy: { version: "desc" } })).bringsExtraBedding === false, "and still records none");
  await expectLodgingError(save(bedReg, { category: "DORM_ROOM", partySize: 5, ...dormNights }), "EXTRA_BEDDING_NOT_ACKNOWLEDGED", "a registrant who changes the party above the beds");
  assert((await save(bedReg, { category: "DORM_ROOM", partySize: 5, bringsExtraBedding: true, ...dormNights })).changed && (await prisma.eventLodgingRequestVersion.findFirstOrThrow({ where: { request: { registrationId: bedReg.id } }, orderBy: { version: "desc" } })).bringsExtraBedding === true, "and the acknowledgement is stored when they give it");
  await restoreRooms(dormRows);

  // A type that stops being counted in rooms keeps the room count it had: flip the conference center to person-based (a unit
  // that is not a numbered room joins it), make an unrelated edit, and the rooms are still two.
  const flipReg = await makeRegistration(eventId, "fl", 3);
  await saveAny(flipReg, { category: "CONFERENCE_CENTER_ROOM", partySize: 3, roomCount: 2, reason: "Phoned the office" }, staff);
  assert((await latestVersion(flipReg.id)).roomCount === 2, "the conference center counts rooms: two rooms are stored");
  const flipUnit = await prisma.lodgingUnit.findFirstOrThrow({ where: { category: "CONFERENCE_CENTER_ROOM", key: "cc-1a" }, select: { id: true, kind: true } });
  try {
    await prisma.lodgingUnit.update({ where: { id: flipUnit.id }, data: { kind: "TENT" } });
    assert((await getPublicLodgingOffer(eventId, prisma))!.categories.find((entry) => entry.category === "CONFERENCE_CENTER_ROOM")!.roomBased === false, "with a tent among its units the type counts people");
    assert((await save(flipReg, { category: "CONFERENCE_CENTER_ROOM", partySize: 3, privateRoomRequested: true })).changed, "an unrelated registrant edit still applies");
    assert((await latestVersion(flipReg.id)).roomCount === 2, "and keeps the two rooms, rather than resetting them to one");
  } finally {
    await prisma.lodgingUnit.update({ where: { id: flipUnit.id }, data: { kind: flipUnit.kind } });
  }
  assert((await save(flipReg, { category: "CONFERENCE_CENTER_ROOM", partySize: 3, privateRoomRequested: false })).changed && (await latestVersion(flipReg.id)).roomCount === 2, "and flipping back keeps them too");
  await prisma.registration.update({ where: { id: flipReg.id }, data: { status: "CANCELLED" } });
  // Tidy up: these registrations are done with, so the queue checks below see only their own items.
  await prisma.registration.updateMany({ where: { id: { in: [six.reg.id, threeRooms.reg.id, siteRooms.reg.id, four.reg.id, bedReg.id] } }, data: { status: "CANCELLED" } });

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
  await setEventRate(eventId, userId, { category: "TENT", rate: { amountCents: 4000, basis: "PER_PERSON_PER_EVENT", minimumNights: null } }, prisma);

  // Promo codes discount the lodging line (#803): a registration-level code (church-sponsored or not) covers the whole
  // subtotal, and the quote, the submission and an amendment agree. The processing fee follows the final subtotal.
  const sponsor = `${P}_church`;
  await prisma.organization.create({ data: { id: sponsor, type: "CHURCH", name: `Lodging Check Church ${P}`, normalizedName: `lodging check church ${P}` } });
  await prisma.promoCode.create({ data: { eventId, code: "HALFOFF", normalizedCode: "HALFOFF", discountType: "PERCENT_BPS", discountValue: 5000, sponsoringOrganizationId: sponsor } });
  await prisma.promoCode.create({ data: { eventId, code: "BIGFIXED", normalizedCode: "BIGFIXED", discountType: "FIXED_CENTS", discountValue: 100_000 } });
  await prisma.promoCode.create({ data: { eventId, code: "MINLODGE", normalizedCode: "MINLODGE", discountType: "PERCENT_BPS", discountValue: 1000, minimumSubtotalCents: 8000 } });
  const quote = await getPublicPromoCodeQuote(slugOf(eventId), formSlug, { versionId: ids.formVersion, code: "HALFOFF", responses: { registration_fee: true }, attendees: [{ clientId: "p0", responses: { first_name: "Quote", last_name: surname } }], lodging: { category: "TENT", partySize: 1 } }, before);
  const promoted = await submitForm({ people: 1, responses: { registration_fee: true, promo_code: "HALFOFF" }, lodging: { category: "TENT", partySize: 1 } });
  assert(promoted.snapshot.discountAmountCents === 4500 && lodgingLineOf(promoted.snapshot)?.amountCents === 4000 && promoted.snapshot.totalCents === 4500, `a church-sponsored 50% code covers lodging too: ${JSON.stringify({ d: promoted.snapshot.discountAmountCents, t: promoted.snapshot.totalCents })}`);
  assert(promoted.snapshot.preDiscountSubtotalCents === 9000 && promoted.snapshot.subtotalCents === 4500, "the pre-discount subtotal holds the lodging line too");
  const redemption = await prisma.promoCodeRedemption.findUniqueOrThrow({ where: { registrationId: promoted.reg.id } });
  assert(redemption.eligibleSubtotalCents === 9000 && redemption.discountAmountCents === 4500, "and the redemption records the discount on that subtotal");
  assert("totalCents" in quote && quote.totalCents === promoted.snapshot.totalCents && quote.discountAmountCents === promoted.snapshot.discountAmountCents && quote.subtotalCents === promoted.snapshot.subtotalCents && quote.lineItems.some((line) => line.key === "lodging" && line.amountCents === 4000), "the promo quote shows the same lines, discount and total as the submission");
  const capped = await submitForm({ people: 1, responses: { registration_fee: true, promo_code: "BIGFIXED" }, lodging: { category: "TENT", partySize: 1 } });
  assert(capped.snapshot.discountAmountCents === 9000 && capped.snapshot.totalCents === 0, "a large fixed code is capped at the whole subtotal, lodging included");
  // A code's minimum is checked on the subtotal including lodging: the $50 fee alone is under it.
  const minimum = await submitForm({ people: 1, responses: { registration_fee: true, promo_code: "MINLODGE" }, lodging: { category: "TENT", partySize: 1 } });
  assert(minimum.snapshot.discountAmountCents === 900 && minimum.snapshot.totalCents === 8100, "a code with a minimum counts the lodging line toward it");
  const minimumRefused = await caught(submitForm({ people: 1, responses: { registration_fee: true, promo_code: "MINLODGE" } }));
  assert(minimumRefused instanceof PublicRegistrationError, "and without the lodging line the same code's minimum is not met");
  // An amendment of the answers carries the stored lodging line and the stored code through to the same total.
  const { currentRegistrationAnswers, previewRegistrationAmendment } = await import("../modules/registrations/amendments-repository");
  const previewSame = async (submitted: Awaited<ReturnType<typeof submitForm>>) => {
    const answers = await currentRegistrationAnswers(eventId, submitted.reg.id);
    assert(answers, "the registration's answers load");
    const attendeeRow = submitted.registration.attendees[0]!;
    return previewRegistrationAmendment(eventId, submitted.reg.id, {
      clientRequestId: randomUUID(), expectedUpdatedAt: answers.updatedAt, reason: "Pricing check", responses: answers.responses, previewOnly: true,
      attendees: [{ attendeeId: attendeeRow.id, clientId: "amend-0", responses: { first_name: attendeeRow.person.firstName, last_name: attendeeRow.person.lastName } }],
    });
  };
  const amendmentPreview = await previewSame(promoted);
  assert(amendmentPreview.totalCents === promoted.snapshot.totalCents && amendmentPreview.deltaCents === 0 && amendmentPreview.lineItems.some((line) => line.key === "lodging" && line.amountCents === 4000), `an amendment keeps the lodging line and its discount: ${JSON.stringify({ t: amendmentPreview.totalCents, d: amendmentPreview.deltaCents })}`);

  assert((promoted.snapshot as { promoCoversLodging?: boolean }).promoCoversLodging === true, "a new submission records that its code covers lodging");

  // A registration submitted BEFORE codes covered lodging keeps the old math: simulate one (no marker, the code decided on the
  // form's own lines, lodging added after) and amend it without touching the price: its total does not move.
  const legacy = await submitForm({ people: 1, responses: { registration_fee: true, promo_code: "HALFOFF" }, lodging: { category: "TENT", partySize: 1 } });
  await prisma.$executeRaw`UPDATE "PublicRegistrationSubmission" SET "pricingSnapshot" = ("pricingSnapshot" - 'promoCoversLodging') || jsonb_build_object('discountAmountCents', 2500, 'subtotalCents', 6500, 'totalCents', 6500) WHERE "registrationId" = ${legacy.reg.id}`;
  await prisma.registration.update({ where: { id: legacy.reg.id }, data: { totalAmount: 65 } });
  await prisma.promoCodeRedemption.update({ where: { registrationId: legacy.reg.id }, data: { eligibleSubtotalCents: 5000, discountAmountCents: 2500 } });
  const legacyPreview = await previewSame(legacy);
  assert(legacyPreview.totalCents === 6500 && legacyPreview.deltaCents === 0 && legacyPreview.lineItems.some((line) => line.key === "lodging" && line.amountCents === 4000), `an older registration's amendment keeps the old math and never lowers its total: ${JSON.stringify({ t: legacyPreview.totalCents, d: legacyPreview.deltaCents })}`);
  assert((await previewSame(promoted)).totalCents === 4500, "while a new registration's amendment keeps the code on the whole subtotal");

  // What a lodging change really costs the registrant, after the saved code: staff are shown it beside the list figure.
  const toDorm = async (reg: Awaited<ReturnType<typeof submitForm>>) => {
    const result = await saveAny(reg.reg, { category: "DORM_ROOM", partySize: 1, reason: "Moved to a dorm room" }, staff);
    if (result.changeRequested) throw new Error("FAILED: a staff change was held for staff");
    return result;
  };
  const sponsored = await toDorm(promoted);
  assert(sponsored.priceNeedsReview === true && sponsored.chargeDeltaCents === 4000 && sponsored.registrantDeltaCents === 2000 && sponsored.sponsorDeltaCents === 2000 && sponsored.promo?.sponsored === true && sponsored.promo.coversLodging === true, `a church-sponsored 50% code: the list change is +$40, the registrant's +$20, the sponsor's +$20, got ${JSON.stringify(sponsored)}`);
  const priceItem = (await staffView()).queue.find((item) => item.kind === "PRICE_DIFFERS" && item.registrationIds.includes(promoted.reg.id));
  assert(priceItem && /After code HALFOFF the registrant's change is \+\$20\.00, and the sponsor's share \+\$20\.00/.test(priceItem.detail), `and the queue says so, got ${priceItem?.detail}`);
  assert(sponsored.churchSponsorReview === true && sponsored.belowMinimumAfter === false, "a sponsored code whose share moves is flagged for the finance office");
  assert(chargeChangeSentence(sponsored).includes(CHURCH_SPONSOR_WARNING) && !chargeChangeSentence(sponsored).includes("Adjust Payments by"), "and the sentence says so instead of telling staff what to adjust");
  assert(priceItem.flags?.includes("CHURCH_SPONSOR_REVIEW") && priceItem.detail.includes(CHURCH_SPONSOR_WARNING), "and the queue item carries the CHURCH_SPONSOR_REVIEW flag and the warning");
  await prisma.promoCode.create({ data: { eventId, code: "CHURCHFULL", normalizedCode: "CHURCHFULL", discountType: "PERCENT_BPS", discountValue: 10_000, sponsoringOrganizationId: sponsor } });
  const fullChurch = await submitForm({ people: 1, responses: { registration_fee: true, promo_code: "CHURCHFULL" }, lodging: { category: "TENT", partySize: 1 } });
  assert(fullChurch.snapshot.totalCents === 0, "a fully sponsored registration owes nothing");
  const fullDelta = await toDorm(fullChurch);
  assert(fullDelta.chargeDeltaCents === 4000 && fullDelta.registrantDeltaCents === 0 && fullDelta.sponsorDeltaCents === 4000, `a 100% church code: the registrant owes the same nothing and the sponsor carries the list change, got ${JSON.stringify(fullDelta)}`);
  const fixedDelta = await toDorm(capped);
  assert(fixedDelta.chargeDeltaCents === 4000 && fixedDelta.registrantDeltaCents === 0 && fixedDelta.promo?.sponsored === false, `a large fixed code covers the whole subtotal either way: the registrant's change is $0, got ${JSON.stringify(fixedDelta)}`);
  const legacyDelta = await toDorm(legacy);
  assert(legacyDelta.chargeDeltaCents === 4000 && legacyDelta.registrantDeltaCents === 4000 && legacyDelta.promo?.coversLodging === false, `an older registration's code never covered lodging: the registrant feels the list change, got ${JSON.stringify(legacyDelta)}`);
  assert(fixedDelta.churchSponsorReview === false, "a code that is not church-sponsored carries no sponsor warning");
  // A change that drops the subtotal under the code's minimum says the code would no longer apply (what an amendment would refuse).
  const underMinimum = await saveAny(minimum.reg, { category: "CONFERENCE_CENTER_ROOM", partySize: 1, reason: "Moved to an unpriced room" }, staff);
  if (underMinimum.changeRequested) throw new Error("FAILED: a staff change was held for staff");
  assert(underMinimum.belowMinimumAfter === true && /under code MINLODGE's minimum/.test(chargeChangeSentence(underMinimum)), `a change that would put the registration under the code's minimum says so, got ${JSON.stringify(underMinimum)}`);
  // The base is what was actually charged (the stored line), as in the queue: the figures staff are told match it.
  assert(underMinimum.chargeDeltaCents === -4000, `the list change is measured from the stored charge, got ${underMinimum.chargeDeltaCents}`);
  await prisma.registration.update({ where: { id: minimum.reg.id }, data: { status: "CANCELLED" } }); // it no longer holds a conference center room
  // A registrant's own change request carries the same figures into the queue.
  await saveAny(promoted.reg, { category: "TENT", partySize: 1, reason: "Back to a tent" }, staff);

  // The figure staff are told to record is THIS edit's change (previous to next at today's rates), never the running total
  // since submission (#803 round 3): two edits in a row report their own changes and a revert reports the reverse. Tents are
  // $40 a person, so the party size moves the line by $40 a step.
  const stepReg = await submitForm({ people: 3, responses: { registration_fee: true, promo_code: "HALFOFF" }, lodging: { category: "TENT", partySize: 1 } });
  const staffSaved = async (reg: Reg, raw: unknown) => { const result = await saveAny(reg, raw, staff); if (result.changeRequested) throw new Error("FAILED: a staff change was held for staff"); return result; };
  const stepTo = (party: number) => staffSaved(stepReg.reg, { category: "TENT", partySize: party, reason: `Party of ${party}` });
  const step1 = await stepTo(2);
  assert(step1.chargeDeltaCents === 4000 && step1.registrantDeltaCents === 2000 && step1.sponsorDeltaCents === 2000 && step1.originallyChargedCents === 4000 && step1.requestNowCostsCents === 8000 && step1.churchSponsorReview === true, `first edit (+$40, split 50/50): ${JSON.stringify(step1)}`);
  const step2 = await stepTo(3);
  assert(step2.chargeDeltaCents === 4000 && step2.registrantDeltaCents === 2000 && step2.sponsorDeltaCents === 2000 && step2.originallyChargedCents === 4000 && step2.requestNowCostsCents === 12000, `second edit reports its own +$40, not the +$80 since submission: ${JSON.stringify(step2)}`);
  const step3 = await stepTo(2);
  assert(step3.chargeDeltaCents === -4000 && step3.registrantDeltaCents === -2000 && step3.sponsorDeltaCents === -2000 && step3.requestNowCostsCents === 8000 && step3.churchSponsorReview === true, `a revert reports the reverse: ${JSON.stringify(step3)}`);
  const step4 = await stepTo(1);
  assert(step4.chargeDeltaCents === -4000 && step4.sponsorDeltaCents === -2000 && step4.requestNowCostsCents === 4000 && step4.churchSponsorReview === true, `a return to the original still moves the sponsor's share this edit, so it warns: ${JSON.stringify(step4)}`);
  assert(chargeChangeSentence(step4).startsWith(CHURCH_SPONSOR_CONTACT_LEAD) && !/adjust the charge in Payments/i.test(chargeChangeSentence(step4)), "and leads with the finance-office line");
  // A registrant's own change request records this request's list change in the audit trail (previous to next).
  const askReg = await submitForm({ people: 3, responses: { registration_fee: true, promo_code: "HALFOFF" }, lodging: { category: "TENT", partySize: 1 } });
  const askedChange = await saveAny(askReg.reg, { category: "TENT", partySize: 2 });
  assert(askedChange.changeRequested === true, "a registrant's priced change is held for staff");
  const askedAudit = await prisma.auditLog.findFirstOrThrow({ where: { action: "LODGING_CHANGE_REQUESTED", metadata: { path: ["registrationId"], equals: askReg.reg.id } } });
  assert((askedAudit.metadata as { deltaCents?: number }).deltaCents === 4000 && (askedAudit.metadata as { registrantDeltaCents?: number }).registrantDeltaCents === 2000, `the audit delta is this request's change: ${JSON.stringify(askedAudit.metadata)}`);
  // An edit that changes nothing about the price, after a change that moved the sponsor's share, still warns (cumulative differs).
  await stepTo(2);
  const quiet = await staffSaved(stepReg.reg, { category: "TENT", partySize: 2, privateRoomRequested: true, reason: "Wants privacy" });
  assert(quiet.priceNeedsReview !== true && quiet.churchSponsorReview === true && quiet.originallyChargedCents === 4000 && quiet.requestNowCostsCents === 8000 && chargeChangeSentence(quiet).startsWith(CHURCH_SPONSOR_CONTACT_LEAD), `an unrelated edit keeps the church warning while the cumulative share differs: ${JSON.stringify(quiet)}`);
  await stepTo(1);
  const plainReg = await submitForm({ people: 3, responses: { registration_fee: true }, lodging: { category: "TENT", partySize: 1 } });
  const plainTo = (party: number) => staffSaved(plainReg.reg, { category: "TENT", partySize: party, reason: `Party of ${party}` });
  const plain1 = await plainTo(2);
  const plain2 = await plainTo(3);
  const plain3 = await plainTo(2);
  assert(plain1.chargeDeltaCents === 4000 && plain2.chargeDeltaCents === 4000 && plain3.chargeDeltaCents === -4000 && [plain1, plain2, plain3].every((entry) => entry.churchSponsorReview === false && entry.promo === null), `with no code each edit is its own list change: ${JSON.stringify([plain1.chargeDeltaCents, plain2.chargeDeltaCents, plain3.chargeDeltaCents])}`);
  await prisma.registration.updateMany({ where: { id: { in: [stepReg.reg.id, plainReg.reg.id, askReg.reg.id] } }, data: { status: "CANCELLED" } });

  // A church-billed event: lodging is recorded and never charged, at submit and after a save.
  const billed = await submitTo(churchTarget, { people: 2, lodging: { category: "DORM_ROOM", partySize: 2 } });
  assert(!lodgingLineOf(billed.snapshot) && Number(billed.registration.totalAmount) === 0 && billed.snapshot.totalCents === 0, "a church-billed event adds no lodging line at submit");
  assert(await prisma.eventLodgingRequest.count({ where: { registrationId: billed.reg.id } }) === 1, "but the request is recorded");
  const billedOffer = await getPublicLodgingOffer(churchEventId, prisma);
  assert(billedOffer?.categories.every((entry) => entry.rate === null), "and the form shows no price");
  const billedView = await getRegistrantLodgingView({ eventId: churchEventId, registrationId: billed.reg.id, now: before }, prisma);
  assert(billedView.offered.every((entry) => entry.rate === null) && billedView.pricedChangeNeedsStaff === false, "nor does the private page");
  const billedSave = await saveAny(billed.reg, { category: "DORM_ROOM", partySize: 2, firstNight: "2027-06-15", lastNight: "2027-06-16" }, billed.reg.token, before, churchEventId);
  assert(!billedSave.changeRequested && billedSave.changed, "a save after submit is just a preference on a church-billed event: no change request");
  const billedStaff = await saveAny(billed.reg, { category: "DORM_ROOM", partySize: 2, reason: "Wants the whole stay" }, staff, before, churchEventId);
  assert(!billedStaff.changeRequested && billedStaff.priceNeedsReview !== true, "and no charge review for staff either");
  const billedQueue = await getStaffLodgingRequestsView(churchEventId, { canSeeSensitive: true, now: before }, prisma);
  assert(!billedQueue.queue.some((item) => item.kind === "PRICE_DIFFERS" || item.kind === "CHANGE_REQUESTED"), "the review queue never lists a lodging charge on a church-billed event");
  assert(Number((await prisma.registration.findUniqueOrThrow({ where: { id: billed.reg.id } })).totalAmount) === 0, "the total stays 0");

  // Waitlisted at submit: the choice is kept as an unpriced request, and the confirmation says so.
  const seated = await submitTo(waitTarget, { people: 1 });
  const waited = await submitTo(waitTarget, { people: 1, lodging: { category: "DORM_ROOM", partySize: 1 } });
  assert(waited.registration.status === "WAITLISTED" && waited.result.registrationStatus === "WAITLISTED", "the second registration for a one-seat event is waitlisted");
  const waitedVersion = await prisma.eventLodgingRequestVersion.findFirstOrThrow({ where: { request: { registrationId: waited.reg.id } } });
  assert(waitedVersion.source === "REGISTRATION_FORM" && waitedVersion.category === "DORM_ROOM" && waitedVersion.sourceFormVersionId === `${ids.formVersion}_w`, "its lodging choice is kept as a request from the form");
  assert(!lodgingLineOf(waited.snapshot) && Number(waited.registration.totalAmount) === 0, "unpriced");
  assert(/Your lodging choice is saved; the event team will confirm it if a place opens/.test(waited.result.message), `and the confirmation says so, got: ${waited.result.message}`);
  assert((await getStaffLodgingRequestsView(waitEventId, { canSeeSensitive: true, now: before }, prisma)).requests.every((request) => request.registrationId !== waited.reg.id), "a waitlisted registration is not in the staff's lodging requests until it is promotedWaiter");

  // Auto-promotion of a registration that holds a lodging request, into a type that is now full: the promotion goes
  // through, nothing is charged, the capacity version is bumped under the unit locks, and the queue lists the request.
  await prisma.eventLodgingUnit.updateMany({ where: { eventId: waitEventId }, data: { capacityOverride: 0 } });
  const waitVersionBefore = (await prisma.eventLodging.findUniqueOrThrow({ where: { eventId: waitEventId } })).capacityVersion;
  const { cancelRegistration } = await import("../modules/registrations/lifecycle-repository");
  await cancelRegistration(waitEventId, seated.registration.id, userId, "Synthetic cancellation frees the seat.", before);
  const promotedWaiter = await prisma.registration.findUniqueOrThrow({ where: { id: waited.reg.id }, include: { waitlistEntry: true } });
  assert(promotedWaiter.status !== "WAITLISTED" && promotedWaiter.waitlistEntry?.status === "PROMOTED", "the freed seat promotes the waitlisted registration automatically, whatever its lodging");
  assert((await prisma.eventLodging.findUniqueOrThrow({ where: { eventId: waitEventId } })).capacityVersion > waitVersionBefore, "the promotion bumps the capacity version under the unit locks");
  assert(Number(promotedWaiter.totalAmount) === 0 && (await prisma.payment.count({ where: { registrationId: waited.reg.id } })) === 0, "and charges nothing");
  const promotedQueue = (await getStaffLodgingRequestsView(waitEventId, { canSeeSensitive: true, now: before }, prisma)).queue;
  assert(promotedQueue.some((item) => item.kind === "PROMOTED_UNCONFIRMED" && item.registrationIds.includes(waited.reg.id)), "the queue lists it as promotedWaiter with an unconfirmed lodging request");
  assert((await prisma.eventLodgingRequestVersion.count({ where: { request: { registrationId: waited.reg.id } } })) === 1, "the request itself is untouched");

  // A request for more people than the registration now has is listed.
  const partyReg = await makeRegistration(eventId, "pp", 2);
  await save(partyReg, { category: "CONFERENCE_CENTER_ROOM", partySize: 2, bringsExtraBedding: true });
  await prisma.registrationAttendee.deleteMany({ where: { registrationId: partyReg.id, personId: partyReg.people[1]!.id } });
  assert((await staffView()).queue.some((item) => item.kind === "PARTY_EXCEEDS_ATTENDEES" && item.registrationIds.includes(partyReg.id)), "a party larger than the registration's attendees is listed for review");

  // The conference center has four rooms: the registrations that hold them are done with, so the version checks below
  // can take one.
  for (const request of await prisma.eventLodgingRequest.findMany({ where: { eventId }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } })) {
    if (request.versions[0]?.category === "CONFERENCE_CENTER_ROOM") await prisma.registration.update({ where: { id: request.registrationId }, data: { status: "CANCELLED" } });
  }

  // Every capacity writer bumps the capacity version, under the unit locks.
  const versionOf = async () => (await prisma.eventLodging.findUniqueOrThrow({ where: { eventId } })).capacityVersion;
  const versionStart = await versionOf();
  const someUnit = (await getLodgingView(eventId, prisma)).buildings.flatMap((building) => building.units).find((unit) => unit.key === "boys-105")!;
  await updateEventUnit(eventId, someUnit.eventUnitId, userId, { capacityOverride: 3 }, prisma);
  await updateEventUnit(eventId, someUnit.eventUnitId, userId, { capacityOverride: null }, prisma);
  const afterOverride = await versionOf();
  assert(afterOverride === versionStart + 2, "a capacity override bumps the capacity version");
  const holdMade = await createHold(eventId, someUnit.eventUnitId, userId, { kind: "STAFF", reason: "Version check", firstNight: "2027-06-15", lastNight: "2027-06-15" }, prisma);
  await changeHold(eventId, holdMade.id, userId, { action: "release", reason: "Version check done" }, prisma);
  assert(await versionOf() === afterOverride + 2, "a hold and its release bump it");
  const beforeSave = await versionOf();
  const makeVersionReg = await makeRegistration(eventId, "vr", 1);
  await save(makeVersionReg, { category: "CONFERENCE_CENTER_ROOM", partySize: 1 });
  assert(await versionOf() === beforeSave + 1, "a lodging request for a type bumps it");
  const beforeSubmit = await versionOf();
  await submitForm({ people: 1, lodging: { category: "CONFERENCE_CENTER_ROOM", partySize: 1 } });
  assert(await versionOf() === beforeSubmit + 1, "and so does a submission");

  // A public submission racing a private-page save for the last room: exactly one of them gets it. (Dorm rooms, with the
  // rate off so the private-page save is not held for staff as a priced change.)
  await setEventRate(eventId, userId, { category: "DORM_ROOM", rate: null }, prisma);
  for (const round of [1, 2, 3]) {
    await roomsLeft("DORM_ROOM", 1);
    const saver = await makeRegistration(eventId, `rc${round}`, 1);
    const [savedRace, submittedRace] = await Promise.all([
      caught(save(saver, { category: "DORM_ROOM", partySize: 1 })),
      caught(submitForm({ people: 1, lodging: { category: "DORM_ROOM", partySize: 1 } })),
    ]);
    const winnersInRound = [savedRace, submittedRace].filter((outcome) => !(outcome instanceof Error));
    assert(winnersInRound.length === 1, `round ${round}: exactly one of a public submission and a private-page save gets the last room, got ${winnersInRound.length}: ${[savedRace, submittedRace].map((outcome) => (outcome instanceof Error ? outcome.message.slice(0, 50) : "ok")).join(" | ")}`);
    const loser = [savedRace, submittedRace].find((outcome) => outcome instanceof Error);
    assert((loser instanceof LodgingError && loser.code === "CATEGORY_FULL") || (loser instanceof PublicRegistrationError && loser.issues[0]?.key === "lodging"), "and the other is told the type is full");
  }
  await restoreRooms(dormRows);

  // The rooms free are checked only when the request grows: an unchanged edit on an overbooked type is accepted, more rooms
  // are refused as full, and more rooms than are free say how many are.
  const overbooked = await makeRegistration(eventId, "ob", 4);
  await save(overbooked, { category: "DORM_ROOM", partySize: 4, roomCount: 2 });
  for (const [index, row] of dormRows.entries()) await updateEventUnit(eventId, row.eventUnitId, userId, { capacityOverride: index === 0 ? 2 : 0 }, prisma);
  assert((await save(overbooked, { category: "DORM_ROOM", partySize: 4, roomCount: 2, privateRoomRequested: true })).changed, "an unrelated edit on an overbooked type is accepted");
  await expectLodgingError(save(overbooked, { category: "DORM_ROOM", partySize: 4, roomCount: 3 }), "CATEGORY_FULL", "asking for more rooms when none are free");
  await restoreRooms(dormRows);
  await roomsLeft("DORM_ROOM", 1);
  const tooManyFree = await expectLodgingError(save(overbooked, { category: "DORM_ROOM", partySize: 4, roomCount: 4 }), "ROOM_COUNT_INVALID", "asking for more rooms than are free");
  assert(/Only 3 rooms are free/.test((tooManyFree as LodgingError).message), `and it says how many are free, got ${(tooManyFree as LodgingError).message}`);
  assert((await save(overbooked, { category: "DORM_ROOM", partySize: 4, roomCount: 3 })).changed, "one more room than it holds is allowed when one is free");
  await restoreRooms(dormRows);
  await prisma.registration.update({ where: { id: overbooked.id }, data: { status: "CANCELLED" } });
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

  // ---- The backfill of rows that existed before room counts (#803) -------------------------------------------
  // Runs the migration's own backfill SQL against rows of one event, set back to the one-room default first.
  const backfillEventId = `${P}_ev_backfill`;
  const backfillTarget: Target = { eventId: backfillEventId, versionId: `${ids.formVersion}_b` };
  await createEvent(backfillEventId);
  await selectEventProperty(backfillEventId, userId, { propertyKey: "sunnydale-academy" }, prisma);
  await updateLodgingSettings(backfillEventId, userId, { collectsPreferences: true, fullBehavior: "WAITLIST" }, prisma);
  await prisma.registrationForm.create({
    data: {
      id: `${ids.form}_b`, eventId: backfillEventId, createdByUserId: userId, name: formDefinition.title, slug: formSlug, status: RegistrationFormStatus.PUBLISHED,
      versions: { create: { id: `${ids.formVersion}_b`, createdByUserId: userId, versionNumber: 1, status: RegistrationFormStatus.PUBLISHED, publishedAt: new Date(), definition: formDefinition } },
    },
  });
  await setEventRate(backfillEventId, userId, { category: "DORM_ROOM", rate: { amountCents: 2000, basis: "PER_UNIT_NIGHT", minimumNights: null } }, prisma);
  const labelled = await submitTo(backfillTarget, { people: 6, lodging: { category: "DORM_ROOM", partySize: 6, roomCount: 2, firstNight: "2027-06-15", lastNight: "2027-06-16" } });
  assert(lodgingLineOf(labelled.snapshot)?.label === "Lodging: Dorm room (2 rooms)", "the stored line names the rooms it charged for");
  const unlabelled = await submitTo(backfillTarget, { people: 4, lodging: { category: "DORM_ROOM", partySize: 4, roomCount: 1, firstNight: "2027-06-15", lastNight: "2027-06-16" } });
  assert(lodgingLineOf(unlabelled.snapshot)?.label === "Lodging: Dorm room" && /per room or site/.test(String((lodgingLineOf(unlabelled.snapshot) as { pricingLabel?: string } | undefined)?.pricingLabel)), "a one-room per-room line names no count");
  const old = async (tag: string, people: number, category: "DORM_ROOM" | "CONFERENCE_CENTER_ROOM" | "TENT", party: number) => {
    const reg = await makeRegistration(backfillEventId, tag, people);
    const request = await prisma.eventLodgingRequest.create({ data: { eventId: backfillEventId, registrationId: reg.id, currentVersion: 1 } });
    await prisma.eventLodgingRequestVersion.create({ data: { eventId: backfillEventId, requestId: request.id, version: 1, category, partySize: party, source: "STAFF" } });
    return { reg, request };
  };
  const oldFive = await old("o5", 5, "DORM_ROOM", 5);
  const oldOne = await old("o1", 1, "DORM_ROOM", 1);
  const oldCc = await old("oc", 3, "CONFERENCE_CENTER_ROOM", 3);
  const oldTent = await old("ot", 4, "TENT", 4);
  const oldChange = await prisma.eventLodgingChangeRequest.create({ data: { eventId: backfillEventId, registrationId: oldFive.reg.id, category: "DORM_ROOM", partySize: 5 } });
  const oldWaiter = await makeRegistration(backfillEventId, "ow", 4);
  const oldEntry = await prisma.$transaction(async (tx) => {
    const entry = await tx.eventLodgingWaitlistEntry.create({ data: { eventId: backfillEventId, registrationId: oldWaiter.id, category: "DORM_ROOM", partySize: 4, createdVia: "STAFF" } });
    await tx.eventLodgingWaitlistHistory.create({ data: { eventId: backfillEventId, entryId: entry.id, status: "JOINED", offerNumber: 0 } });
    return entry;
  });
  const migrationSql = readFileSync("prisma/migrations/20261006300000_lodging_room_count/migration.sql", "utf8");
  const backfill = migrationSql.slice(migrationSql.indexOf("-- BACKFILL START"), migrationSql.indexOf("-- BACKFILL END"))
    .split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n")
    .split(/;\s*\n/).map((statement) => statement.trim()).filter(Boolean);
  assert(backfill.length >= 8, `the migration's backfill block was found (${backfill.length} statements)`);
  const runBackfill = () => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('imsda.backfill_event', ${backfillEventId}, true)`;
    for (const statement of backfill) await tx.$executeRawUnsafe(statement);
  });
  const resetToOne = () => prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE "EventLodgingRequestVersion" DISABLE TRIGGER "EventLodgingRequestVersion_append_only"');
    await tx.$executeRaw`UPDATE "EventLodgingRequestVersion" SET "roomCount" = 1 WHERE "eventId" = ${backfillEventId}`;
    await tx.$executeRawUnsafe('ALTER TABLE "EventLodgingRequestVersion" ENABLE TRIGGER "EventLodgingRequestVersion_append_only"');
  });
  await resetToOne();
  await runBackfill();
  const roomsOf = async (registrationId: string) => (await prisma.eventLodgingRequestVersion.findFirstOrThrow({ where: { request: { registrationId } }, orderBy: { version: "desc" } }));
  assert((await roomsOf(oldFive.reg.id)).roomCount === 3, "a party of 5 in 2-bed dorm rooms had paid for ceil(5/2) = 3 rooms");
  assert((await roomsOf(oldOne.reg.id)).roomCount === 1, "a party of one stays one room");
  assert((await roomsOf(oldCc.reg.id)).roomCount === 3, "the conference center's smallest room sleeps 1, so a party of 3 is 3 rooms");
  assert((await roomsOf(oldTent.reg.id)).roomCount === 1, "a tent area is one unit");
  assert((await roomsOf(labelled.reg.id)).roomCount === 2, "a priced registration takes the room count its stored line names (2), not the old rule's 3");
  assert((await roomsOf(unlabelled.reg.id)).roomCount === 1, "a per-room line that names no count was charged for one room (the old rule would say 2)");
  for (const registrationId of [oldFive.reg.id, oldOne.reg.id, oldCc.reg.id, oldTent.reg.id, labelled.reg.id]) assert((await roomsOf(registrationId)).bringsExtraBedding === false, "a backfilled row records no acknowledgement");
  assert((await prisma.eventLodgingChangeRequest.findUniqueOrThrow({ where: { id: oldChange.id } })).roomCount === 3, "an open change request is backfilled the same way");
  assert((await prisma.eventLodgingWaitlistEntry.findUniqueOrThrow({ where: { id: oldEntry.id } })).roomCount === 2, "and so is a waitlist entry");
  await runBackfill();
  assert((await roomsOf(oldFive.reg.id)).roomCount === 3 && (await roomsOf(labelled.reg.id)).roomCount === 2, "running it again changes nothing");
  assert(await prisma.eventLodgingRequestVersion.count({ where: { eventId: backfillEventId, version: { gt: 1 } } }) === 0, "and adds no version");
  await expectDatabaseRefusal(prisma.eventLodgingRequestVersion.update({ where: { id: (await roomsOf(oldFive.reg.id)).id }, data: { roomCount: 1 } }), "rewriting a version after the backfill");
  // A backfilled request is edited like any other: an unrelated edit is not refused and asks for nothing.
  const unrelated = await saveAny(oldFive.reg, { category: "DORM_ROOM", partySize: 5, privateRoomRequested: true }, oldFive.reg.token, before, backfillEventId);
  assert(!unrelated.changeRequested && unrelated.changed && (await roomsOf(oldFive.reg.id)).roomCount === 3, "an unrelated edit of a backfilled request keeps its rooms");

  console.log("Lodging preferences verified.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await cleanup(); } catch (error) { console.error("Cleanup failed:", error instanceof Error ? error.message : error); process.exitCode = 1; }
    await prisma.$disconnect();
  });
