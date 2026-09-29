/**
 * Proves location waitlists (#599) against a real PostgreSQL database: a club
 * that picks a full location on a waitlist-enabled event is waitlisted at that
 * location in per-location first-come order (an event without a waitlist still
 * refuses with LOCATION_FULL); a freed seat (cancel, an amendment that removes
 * people, a raised capacity) promotes the next club at that location only and
 * never goes over capacity, including under races; a busy location is skipped
 * rather than failing the cancel; the director gets the waitlist emails naming
 * the location; and the daily digest reaches the location's active Area
 * Coordinator and event administrators once a day, never a revoked coordinator,
 * never on an empty day, never twice, and a failed send never undoes anything.
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:location-waitlist
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { PrismaClient, RegistrationFormStatus } from "@prisma/client";

loadEnvConfig(process.cwd());
// Synthetic keys for this run only; nothing here ever reaches a real provider.
process.env.SECRET_ENCRYPTION_KEY ||= "verify-location-waitlist-synthetic-key-not-a-secret";
process.env.ACCOUNT_EMAIL_SENDER_ADDRESS = "events@example.test";
process.env.RESEND_API_KEY = "synthetic-key-not-a-secret";

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
const P = "wl";
const staffUserId = `${P}_staff`;
const adminUserId = `${P}_admin`;
const readOnlyUserId = `${P}_readonly`;
const eventId = `${P}_event`;
const plainEventId = `${P}_plain_event`;
const formSlug = `${P}-club-form`;
const formVersionId = `${P}_formver_1`;
const plainFormVersionId = `${P}_formver_plain`;
const raceRounds = 4;
const raceKeys = Array.from({ length: raceRounds * 4 }, (_, index) => `r${index + 1}`);
const clubKeys = [...raceKeys, "a1", "a2", "a3", "a4", "b1", "b2", "b3", "c1", "c2", "c3", "c4", "c5", "d1", "d2", "e1", "e2", "e3", "f1", "f2", "g1", "g2", "h1", "p1", "p2"] as const;
const clubOf = (key: string) => `${P}_club_${key}`;
const actor = { userId: staffUserId, actAsId: `${P}_actas` };
const coordinatorAccountId = `${P}_coordinator`;
const revokedAccountId = `${P}_revoked_coordinator`;
const october = new Date("2026-10-05T15:00:00Z");
const eventIds = [eventId, plainEventId];

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
  // Events this run cloned are removed with the ones it made.
  const cloneIds = (await prisma.eventCloneRecord.findMany({ where: { actorUserId: staffUserId }, select: { resultEventId: true } })).map((row) => row.resultEventId);
  const allEventIds = [...eventIds, ...cloneIds];
  const registrationIds = (await prisma.registration.findMany({ where: { eventId: { in: allEventIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.messageOutbox.deleteMany({ where: { OR: [{ registrationId: { in: registrationIds } }, { eventId: { in: allEventIds } }, { recipientEmail: { startsWith: `${P}-`, endsWith: "@example.test" } }] } });
  await prisma.$transaction([
    prisma.$executeRawUnsafe('ALTER TABLE "RegistrationOperation" DISABLE TRIGGER "RegistrationOperation_immutable"'),
    prisma.registrationOperation.deleteMany({ where: { eventId: { in: allEventIds } } }),
    prisma.$executeRawUnsafe('ALTER TABLE "RegistrationOperation" ENABLE TRIGGER "RegistrationOperation_immutable"'),
  ]);
  await prisma.eventCloneRecord.deleteMany({ where: { actorUserId: staffUserId } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: allEventIds } }, { actorUserId: { in: [staffUserId, adminUserId, readOnlyUserId] } }] } });
  await prisma.clubRegistrationDraft.deleteMany({ where: { eventId: { in: allEventIds } } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId: { in: allEventIds } } });
  await prisma.registration.deleteMany({ where: { eventId: { in: allEventIds } } });
  await prisma.event.deleteMany({ where: { id: { in: allEventIds } } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: { startsWith: `${P}_` } } });
  await prisma.organization.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.person.deleteMany({ where: { firstName: { startsWith: "Wl" }, lastName: "Director" } });
  await prisma.attendeeAccount.deleteMany({ where: { id: { in: [coordinatorAccountId, revokedAccountId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [staffUserId, adminUserId, readOnlyUserId] } } });
}

const field = (id: string, key: string, label: string, type: string, scope: "ATTENDEE" | "REGISTRATION", required = false) => (
  { id: `${P}_${id}`, key, label, helpText: "", type, scope, required, options: [] }
);

async function main() {
  // Imported after the environment is set, so the server env sees it.
  const { registrationFormDefinitionSchema } = await import("../modules/forms/definition");
  const { sealBirthDate } = await import("../modules/club-rosters/birth-dates");
  const { clubAttendeeClientId } = await import("../modules/club-registrations/domain");
  const locations = await import("../modules/event-locations/repository");
  const { EventLocationError } = await import("../modules/event-locations/errors");
  const club = await import("../modules/club-registrations/repository");
  const { cancelRegistration } = await import("../modules/registrations/lifecycle-repository");
  const { listRegistrations } = await import("../modules/registrations/repository");
  const { processQueuedMessageIdsAfterCommit } = await import("../modules/communications/messaging-repository");
  const { processAccountEmailQueue } = await import("../modules/communications/email-delivery");
  const { sendDueLocationWaitlistDigests } = await import("../modules/event-locations/waitlist-digest");
  const { listWaitingClubsForCoordinator } = await import("../modules/event-locations/waitlist");
  const { previewEventClone, cloneEvent } = await import("../modules/event-clones/repository");

  await cleanup();
  await prisma.user.createMany({
    data: [
      { id: staffUserId, email: `${P}-staff@example.test`, displayName: "Waitlist Check Staff", globalRole: "SYSTEM_ADMIN" },
      { id: adminUserId, email: `${P}-admin@example.test`, displayName: "Waitlist Event Admin" },
      { id: readOnlyUserId, email: `${P}-readonly@example.test`, displayName: "Waitlist Read Only" },
    ],
  });
  await prisma.organization.createMany({
    data: clubKeys.map((key) => ({ id: clubOf(key), type: "CLUB" as const, name: `Wl Club ${key}`, normalizedName: `wl club ${key}` })),
  });
  const eventData = {
    startsAt: new Date("2026-12-05T15:00:00Z"), endsAt: new Date("2026-12-06T22:00:00Z"), timezone: "America/Chicago", isPublished: true,
    registrationOpensOn: "2026-10-01", registrationClosesOn: "2026-11-30", billingMode: "DEFERRED_ORGANIZATION_INVOICE" as const, audience: "CLUB" as const,
  };
  await prisma.event.create({ data: { id: eventId, slug: `${P}-event`, name: "Waitlist check weekend", waitlistEnabled: true, autoPromoteWaitlist: true, ...eventData } });
  await prisma.event.create({ data: { id: plainEventId, slug: `${P}-plain-event`, name: "Waitlist check no waitlist", ...eventData } });
  await prisma.eventMembership.createMany({
    data: [
      { eventId, userId: adminUserId, role: "EVENT_ADMIN" },
      { eventId, userId: readOnlyUserId, role: "READ_ONLY_STAFF" },
    ],
  });
  // Two synthetic Area Coordinators: one active, one whose grant was revoked.
  await prisma.attendeeAccount.createMany({
    data: [
      { id: coordinatorAccountId, email: `${P}-coordinator@example.test`, displayName: "Waitlist Coordinator", status: "ACTIVE" },
      { id: revokedAccountId, email: `${P}-revoked@example.test`, displayName: "Waitlist Former Coordinator", status: "ACTIVE" },
    ],
  });
  await prisma.areaCoordinatorGrant.create({ data: { attendeeAccountId: coordinatorAccountId, grantedByUserId: staffUserId } });
  await prisma.areaCoordinatorGrant.create({ data: { attendeeAccountId: revokedAccountId, grantedByUserId: staffUserId } });

  const sealed = sealBirthDate("2014-12-06");
  const memberIds = new Map<string, string[]>();
  for (const key of clubKeys) {
    const ids: string[] = [];
    for (const suffix of ["m1", "m2"]) {
      const person = await prisma.person.create({ data: { id: `${P}_${key}_${suffix}`, firstName: "Wl", lastName: `${key}${suffix}` } });
      const member = await prisma.clubRosterMember.create({
        data: { organizationId: clubOf(key), clubYear: "2026-27", personId: person.id, attendeeType: "YOUTH", role: "Pathfinder", sealedBirthDate: sealed, source: "DIRECTOR" },
      });
      ids.push(member.id);
    }
    memberIds.set(key, ids);
  }

  const definition = registrationFormDefinitionSchema.parse({
    title: "Waitlist check club registration",
    description: "Fictitious club form.",
    confirmationMessage: "Your club is registered.",
    attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Club member", addButtonLabel: "Add" },
    sections: [
      { id: `${P}_contact`, title: "Contact", description: "", fields: [
        field("c_first", "primary_contact_first_name", "First name", "TEXT", "REGISTRATION", true),
        field("c_last", "primary_contact_last_name", "Last name", "TEXT", "REGISTRATION", true),
        field("c_email", "email", "Email", "EMAIL", "REGISTRATION", true),
      ] },
      { id: `${P}_roster`, title: "Roster", description: "", fields: [
        field("a_first", "first_name", "First name", "TEXT", "ATTENDEE", true),
        field("a_last", "last_name", "Last name", "TEXT", "ATTENDEE", true),
        field("a_age", "attendee_age", "Age", "NUMBER", "ATTENDEE", true),
        field("a_fee", "registration_fee", "Registration fee", "CALCULATED", "ATTENDEE", false),
      ] },
    ],
  });
  for (const id of eventIds) {
    await prisma.registrationForm.create({
      data: {
        id: `${P}_form_${id}`, eventId: id, createdByUserId: staffUserId, name: definition.title, slug: formSlug, status: RegistrationFormStatus.PUBLISHED,
        versions: { create: { id: id === eventId ? formVersionId : plainFormVersionId, createdByUserId: staffUserId, versionNumber: 1, status: RegistrationFormStatus.PUBLISHED, publishedAt: new Date(), definition } },
      },
    });
  }

  async function submit(key: string, locationId: string | null, people = 1, targetEvent = eventId) {
    const ids = memberIds.get(key)!.slice(0, people);
    return club.submitClubRegistration(clubOf(key), targetEvent, actor, {
      versionId: targetEvent === eventId ? formVersionId : plainFormVersionId,
      idempotencyKey: randomUUID(),
      responses: { primary_contact_first_name: "Wl", primary_contact_last_name: "Director", email: `${P}-${key}@example.test` },
      attendees: ids.map((id) => ({ clientId: clubAttendeeClientId(id), responses: {} })),
      website: "",
    }, october, { locationId });
  }
  const regOf = (key: string, targetEvent = eventId) => prisma.registration.findFirstOrThrow({
    where: { eventId: targetEvent, clubRegistration: { organizationId: clubOf(key) } },
    select: { id: true, locationId: true, status: true, updatedAt: true, waitlistEntry: { select: { position: true, status: true, lastBlockedReason: true } } },
  });
  const statusOf = async (key: string) => (await regOf(key)).status;
  const seats = (locationId: string) => prisma.registrationAttendee.count({
    where: { registration: { locationId, status: { in: ["SUBMITTED", "CONFIRMED"] } } },
  });
  const cancel = (key: string, reason = "Synthetic cancellation.") => regOf(key).then((registration) => cancelRegistration(eventId, registration.id, staffUserId, reason, october));
  const messagesFor = (key: string) => regOf(key).then((registration) => prisma.messageOutbox.findMany({
    where: { registrationId: registration.id }, orderBy: { createdAt: "asc" },
  }));
  const editInput = (key: string, extra: Record<string, unknown> = {}) => ({
    clientRequestId: randomUUID(),
    expectedUpdatedAt: "",
    selectedMemberIds: memberIds.get(key)!.slice(0, 1),
    keptGuestIds: [] as string[],
    keptOffRosterAttendeeIds: [] as string[],
    newGuests: [] as never[],
    attendeeResponses: {},
    ...extra,
  });

  // Locations. The coordinator of A is active; the coordinator of B is revoked after being chosen.
  await expectCode(
    locations.createEventLocation(eventId, staffUserId, { name: "Bad Coordinator", coordinatorAccountId: staffUserId }),
    "LOCATION_COORDINATOR_INVALID",
    "a coordinator must be an attendee account with an active grant",
  );
  const locA = await locations.createEventLocation(eventId, staffUserId, { name: "Camp Heritage 1", capacity: 2, coordinatorAccountId: coordinatorAccountId });
  const locB = await locations.createEventLocation(eventId, staffUserId, { name: "Des Moines", capacity: 2, coordinatorAccountId: revokedAccountId });
  await prisma.areaCoordinatorGrant.update({ where: { attendeeAccountId: revokedAccountId }, data: { revokedAt: new Date() } });
  await expectCode(
    locations.createEventLocation(eventId, staffUserId, { name: "Bad Coordinator", coordinatorAccountId: revokedAccountId }),
    "LOCATION_COORDINATOR_INVALID",
    "a revoked coordinator can't be chosen",
  );
  const locC = await locations.createEventLocation(eventId, staffUserId, { name: "Kansas City", capacity: 2 });
  const locD = await locations.createEventLocation(eventId, staffUserId, { name: "Camp Two", capacity: 2 });
  const locE = await locations.createEventLocation(eventId, staffUserId, { name: "Camp Three", capacity: 1 });
  const locF = await locations.createEventLocation(eventId, staffUserId, { name: "Busy Site", capacity: 1 });
  const locG = await locations.createEventLocation(eventId, staffUserId, { name: "Other Busy Site", capacity: 1 });
  const listed = await locations.listEventLocations(eventId);
  const listedA = listed.find((row) => row.id === locA.id)!;
  const listedB = listed.find((row) => row.id === locB.id)!;
  assert(listedA.coordinatorActive && listedA.coordinator?.name === "Waitlist Coordinator", "an active coordinator is shown");
  assert(!listedB.coordinatorActive, "a revoked coordinator shows as no active coordinator");
  const plainLocation = await locations.createEventLocation(plainEventId, staffUserId, { name: "Only Site", capacity: 1 });
  console.log("ok  setup: coordinator must hold an active grant; a revoked one shows as inactive");

  // 1. A full location on a waitlist-enabled event waitlists the club there, in per-location order.
  await submit("a1", locA.id, 2);
  assert(await seats(locA.id) === 2, "a1 fills Camp Heritage 1");
  const a2 = await submit("a2", locA.id, 2);
  assert(a2.registrationStatus === "WAITLISTED" && a2.waitlistPosition === 1, `a2 is waitlisted at place 1, got ${a2.registrationStatus} ${String(a2.waitlistPosition)}`);
  await submit("b1", locB.id, 1);
  const b2 = await submit("b2", locB.id, 2);
  assert(b2.registrationStatus === "WAITLISTED" && b2.waitlistPosition === 1, "b2 is first in line at Des Moines, though it joined after a2");
  const a3 = await submit("a3", locA.id, 1);
  assert(a3.registrationStatus === "WAITLISTED" && a3.waitlistPosition === 2, `a3 is second in line at Camp Heritage 1, got ${String(a3.waitlistPosition)}`);
  const a2Row = await regOf("a2");
  const b2Row = await regOf("b2");
  const a3Row = await regOf("a3");
  assert(a2Row.locationId === locA.id && a2Row.status === "WAITLISTED", "the waitlisted club keeps its location");
  assert(a2Row.waitlistEntry!.position < b2Row.waitlistEntry!.position && b2Row.waitlistEntry!.position < a3Row.waitlistEntry!.position, "event-wide positions stay unique and in join order");
  assert(await seats(locA.id) === 2, "a waitlisted club takes no seats");
  const staffList = await listRegistrations(eventId, { locationId: locA.id });
  assert(staffList.find((row) => row.id === a3Row.id)?.locationWaitlistPlace === 2, "the staff list carries the place in line at the location");
  assert(staffList.find((row) => row.id === a2Row.id)?.locationWaitlistPlace === 1, "the first club at the location is #1");
  console.log("ok  a full location waitlists the club there, in per-location order (event-wide positions stay unique)");

  // 2. An event without a waitlist still refuses with LOCATION_FULL.
  await submit("p1", plainLocation.id, 1, plainEventId);
  await expectCode(submit("p2", plainLocation.id, 1, plainEventId), "LOCATION_FULL", "an event without a waitlist refuses a full location");
  assert(await prisma.registration.count({ where: { eventId: plainEventId } }) === 1, "the refused club created nothing");
  console.log("ok  an event without a waitlist still refuses with LOCATION_FULL");

  // 3. The director's emails name the location; a change row is recorded for each join.
  const a2Messages = await messagesFor("a2");
  const joined = a2Messages.find((message) => message.templateKey === "WAITLIST_JOINED");
  assert(joined && joined.recipientKind === "REGISTRANT" && joined.recipientEmail === `${P}-a2@example.test`, "the director gets the waitlist-joined email");
  assert(joined.bodyTextSnapshot.includes("Camp Heritage 1"), "the waitlist email names the location");
  const changes = await prisma.locationWaitlistChange.findMany({ where: { eventId }, orderBy: { occurredAt: "asc" } });
  assert(changes.filter((change) => change.kind === "JOINED").length === 3, `three joins recorded, got ${changes.length}`);
  assert(changes.find((change) => change.registrationId === a3Row.id)?.place === 2 && changes.find((change) => change.registrationId === a3Row.id)?.attendeeCount === 1, "a join records the club's place and people");
  console.log("ok  the director's waitlist email names the location, and each join is recorded");

  // 4. A freed seat promotes the next club at that location only, in order, and never over capacity.
  const cancelled = await cancel("a1");
  assert(cancelled.autoPromotedRegistration?.confirmationCode === (await prisma.registration.findUniqueOrThrow({ where: { id: a2Row.id } })).confirmationCode, "the first club in line at the location was promoted");
  assert(await statusOf("a2") === "SUBMITTED" && await statusOf("a3") === "WAITLISTED", "only the next club at that location moved up");
  assert(await statusOf("b2") === "WAITLISTED", "a club waiting at another location was not promoted by this seat");
  assert(await seats(locA.id) === 2, "the location is exactly full again");
  const a3AfterPromotion = (await listRegistrations(eventId, { locationId: locA.id })).find((row) => row.id === a3Row.id);
  assert(a3AfterPromotion?.locationWaitlistPlace === 1, "the next club moves up to #1 at its location");
  const promoted = (await messagesFor("a2")).find((message) => message.templateKey === "WAITLIST_PROMOTED");
  assert(promoted && promoted.bodyTextSnapshot.includes("Camp Heritage 1"), "the promotion email names the location");
  const removedNotice = await cancel("a3", "Changed plans.");
  assert(removedNotice.registration.status === "CANCELLED", "a waitlisted club can leave the waitlist");
  const removedMail = (await messagesFor("a3")).find((message) => message.templateKey === "WAITLIST_REMOVED");
  assert(removedMail && removedMail.bodyTextSnapshot.includes("Camp Heritage 1"), "the removal email names the location");
  const kinds = (await prisma.locationWaitlistChange.findMany({ where: { locationId: locA.id } })).map((change) => change.kind).sort();
  assert(kinds.join() === "JOINED,JOINED,PROMOTED,REMOVED", `the location's changes are all recorded, got ${kinds.join()}`);
  console.log("ok  a cancel promotes the next club at that location only; joined, promoted and removed are recorded");

  // 5. Races. Two seats open at once (two cancels together), three clubs waiting one seat each: exactly the first two are promoted, in order.
  await submit("c1", locC.id, 1);
  await submit("c2", locC.id, 1);
  for (const key of ["c3", "c4", "c5"]) {
    const result = await submit(key, locC.id, 1);
    assert(result.registrationStatus === "WAITLISTED", `${key} waits at Kansas City`);
  }
  const raceCancels = await Promise.allSettled([cancel("c1"), cancel("c2")]);
  assert(raceCancels.every((result) => result.status === "fulfilled"), `both cancels succeed, got ${raceCancels.map((result) => (result.status === "rejected" ? String(result.reason) : "ok")).join()}`);
  assert(await statusOf("c3") === "SUBMITTED" && await statusOf("c4") === "SUBMITTED", "the first two waiting clubs were promoted");
  assert(await statusOf("c5") === "WAITLISTED", "the third stays waiting");
  assert(await seats(locC.id) === 2, `Kansas City holds exactly its capacity, got ${await seats(locC.id)}`);
  // A new club racing a cancel for the one seat: the waiting club is never leapfrogged, and capacity holds.
  const raceNew = await Promise.allSettled([cancel("c3"), submit("d1", locC.id, 1)]);
  assert(raceNew[0].status === "fulfilled", `the cancel succeeds against a racing submit, got ${raceNew[0].status === "rejected" ? String(raceNew[0].reason) : "ok"}`);
  assert(raceNew[1].status === "fulfilled", `the racing submit is answered, got ${raceNew[1].status === "rejected" ? String(raceNew[1].reason) : "ok"}`);
  assert(await seats(locC.id) === 2, `never over capacity under a cancel/submit race, got ${await seats(locC.id)}`);
  assert(await statusOf("c5") === "SUBMITTED", "the club that was waiting got the freed seat");
  assert(await statusOf("d1") === "WAITLISTED", "the racing new club waits behind it instead of leapfrogging");
  console.log("ok  races: two cancels promote the first two in order; a cancel racing a submit never overfills the location");

  // 6. An amendment that removes people opens seats for the next club at that location.
  await submit("d2", locD.id, 2);
  const d2Wait = await submit("e1", locD.id, 1);
  assert(d2Wait.registrationStatus === "WAITLISTED", "e1 waits at Camp Two");
  const d2 = await regOf("d2");
  await club.amendClubRegistration(clubOf("d2"), eventId, actor, { ...editInput("d2"), expectedUpdatedAt: d2.updatedAt.toISOString() }, october);
  assert(await statusOf("e1") === "SUBMITTED", "removing a person from the holding club promoted the waiting club");
  assert(await seats(locD.id) === 2, "Camp Two is exactly full after the amendment");
  console.log("ok  an amendment that removes people promotes the next club at that location");

  // 7. A raised capacity promotes everyone who now fits, in order, and returns the emails to send after commit.
  await submit("e2", locE.id, 1);
  await submit("e3", locE.id, 1);
  await submit("f1", locE.id, 1);
  assert(await statusOf("e3") === "WAITLISTED" && await statusOf("f1") === "WAITLISTED", "two clubs wait at Camp Three");
  const raised = await locations.updateEventLocation(eventId, locE.id, staffUserId, { capacity: 3 });
  assert(await statusOf("e3") === "SUBMITTED" && await statusOf("f1") === "SUBMITTED", "a raised capacity promoted both waiting clubs");
  assert(raised.occupied === 3 && raised.pendingMessageIds.length === 2, `the update reports the seats and the emails to send, got ${raised.occupied} ${raised.pendingMessageIds.length}`);
  console.log("ok  a raised capacity promotes the waiting clubs in order");

  // 8. A busy location is skipped, not fatal: the cancel succeeds and the next club that fits is promoted.
  await submit("f2", locF.id, 1); // holds Busy Site
  await submit("g1", locG.id, 1); // holds Other Busy Site
  const busyWaiter = await submit("g2", locG.id, 1); // waits at Other Busy Site
  assert(busyWaiter.registrationStatus === "WAITLISTED", "g2 waits at Other Busy Site");
  const spare = await submit("h1", locF.id, 1); // waits at Busy Site
  assert(spare.registrationStatus === "WAITLISTED", "h1 waits at Busy Site");
  // Room opens at Busy Site without promoting (a direct edit), so h1 fits there but has not been offered it.
  await prisma.eventLocation.update({ where: { id: locF.id }, data: { capacity: 2 } });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "EventLocation" WHERE "id" = ${locG.id} FOR UPDATE`;
    await held;
  }, { timeout: 60_000, maxWait: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const busyCancel = await caught(cancel("g1"));
  release();
  await holder;
  assert(busyCancel === null, `the cancel succeeds while a waiting club's location is busy, got ${String(busyCancel)}`);
  assert(await statusOf("g1") === "CANCELLED", "the cancellation stands");
  const g2After = await regOf("g2");
  assert(g2After.status === "WAITLISTED" && /busy/i.test(g2After.waitlistEntry?.lastBlockedReason ?? ""), `the busy club is skipped and told why, got ${String(g2After.waitlistEntry?.lastBlockedReason)}`);
  assert(await statusOf("h1") === "SUBMITTED", "the next club that fits was promoted instead");
  console.log("ok  a busy location is skipped rather than failing the cancel");

  // 9. The daily digest: nothing before the morning; then one email per person per day.
  const before = new Date("2026-10-06T11:00:00Z"); // 6:00 AM Central: not due yet
  const after = new Date("2026-10-06T13:30:00Z"); // 8:30 AM Central
  const delivered: string[] = [];
  const configuration = { apiKey: "synthetic-key-not-a-secret", apiUrl: "https://email.invalid" };
  const okSend = async (input: { toEmail: string; subject: string; bodyText: string }) => {
    delivered.push(input.toEmail);
    return { providerMessageId: `synthetic-${randomUUID()}` };
  };
  const deliverOk = (ids: string[]) => processAccountEmailQueue({ messageIds: ids, dependencies: { sendEmail: okSend as never, configuration } });
  const notDue = await sendDueLocationWaitlistDigests(before, { deliver: deliverOk });
  assert(notDue.status === "NOT_DUE" && notDue.messageIds.length === 0, "nothing is sent before the morning send time");
  const digestKeyPrefix = "location-waitlist-digest:2026-10-06:";
  assert(await prisma.messageOutbox.count({ where: { idempotencyKey: { startsWith: digestKeyPrefix } } }) === 0, "no digest message exists yet");
  // The changes were all made "now" (real time); the digest's window is the synthetic morning, so move them into it.
  await prisma.locationWaitlistChange.updateMany({ where: { eventId }, data: { occurredAt: new Date("2026-10-05T20:00:00Z") } });
  // The email failure path: delivery throws, yet the digest is queued, the changes are stamped, and the registrations are untouched.
  const failing = async () => { throw new TypeError("synthetic network outage"); };
  const failedRun = await sendDueLocationWaitlistDigests(after, {
    deliver: (ids) => processAccountEmailQueue({ messageIds: ids, dependencies: { sendEmail: failing as never, configuration } }),
  });
  assert(failedRun.status === "QUEUED" && failedRun.messageIds.length > 0 && failedRun.delivered === 0, "a failed send still queues the digest");
  const queuedDigests = await prisma.messageOutbox.findMany({ where: { idempotencyKey: { startsWith: digestKeyPrefix } } });
  assert(queuedDigests.every((message) => message.status === "PENDING" && message.attemptCount >= 1 && Boolean(message.lastError)), "each failed digest keeps its status, attempt and error for the sweep to retry");
  assert(await prisma.locationWaitlistChange.count({ where: { eventId, digestedAt: null } }) === 0, "the changes are stamped in the same transaction that queued the digest");
  assert(await statusOf("a2") === "SUBMITTED" && await statusOf("h1") === "SUBMITTED", "an email failure changed no registration");
  const byRecipient = new Map(queuedDigests.map((message) => [message.recipientEmail, message]));
  const coordinatorMail = byRecipient.get(`${P}-coordinator@example.test`);
  const adminMail = byRecipient.get(`${P}-admin@example.test`);
  assert(coordinatorMail && adminMail, "the active coordinator and the event administrator each get a digest");
  assert(!byRecipient.has(`${P}-revoked@example.test`), "a revoked coordinator gets none");
  assert(!byRecipient.has(`${P}-readonly@example.test`), "read-only staff get none");
  assert(coordinatorMail.bodyTextSnapshot.includes("Camp Heritage 1") && !coordinatorMail.bodyTextSnapshot.includes("Des Moines") && !coordinatorMail.bodyTextSnapshot.includes("Kansas City"),
    "the coordinator's digest covers only their own location");
  assert(coordinatorMail.bodyTextSnapshot.includes("Joined the waitlist: Wl Club a2 (2 people, place #1 in line)")
    && coordinatorMail.bodyTextSnapshot.includes("Promoted to a registration: Wl Club a2 (2 people, was place #1 in line)")
    && coordinatorMail.bodyTextSnapshot.includes("Removed from the waitlist: Wl Club a3"),
    "the digest lists who joined (with place), who was promoted, and who was removed");
  assert(["Camp Heritage 1", "Des Moines", "Kansas City", "Camp Two", "Camp Three", "Busy Site"].every((name) => adminMail.bodyTextSnapshot.includes(name)), "the event administrator's digest covers every location of the event, in one email");
  assert(coordinatorMail.eventId === null && coordinatorMail.templateKey === "LOCATION_WAITLIST_DIGEST" && coordinatorMail.recipientKind === "INTERNAL", "the digest is a one-off internal notice, not tied to an event");
  assert(queuedDigests.length === 2, `exactly one digest per recipient, got ${queuedDigests.length}`);
  console.log("ok  the digest is queued once per recipient; a failed send changes nothing; a revoked coordinator and read-only staff get none");

  // The sweep's retry delivers the queued digests (a fresh run of the account queue).
  const retry = await processAccountEmailQueue({ dependencies: { sendEmail: okSend as never, configuration, now: () => new Date(Date.now() + 2 * 60 * 60 * 1000) } });
  assert(retry.sentIds.length === 2 && delivered.includes(`${P}-coordinator@example.test`) && delivered.includes(`${P}-admin@example.test`), `the retry delivered both, got ${retry.sentIds.length}`);
  assert((await prisma.messageOutbox.findMany({ where: { idempotencyKey: { startsWith: digestKeyPrefix } } })).every((message) => message.status === "SENT"), "delivery status is recorded as sent");

  // Idempotent: a repeat run the same day sends nothing more, even with a new change after the morning cutoff.
  const repeat = await sendDueLocationWaitlistDigests(after, { deliver: deliverOk });
  assert(repeat.status === "NO_CHANGES" && repeat.messageIds.length === 0, "a repeat run the same day sends nothing");
  // Cancelling h1 opens Busy Site's seat, which promotes g2 at Other Busy Site (its room opened earlier): a new change.
  await cancel("h1", "Late change.");
  assert(await statusOf("g2") === "SUBMITTED", "g2 was promoted once its location had room");
  await prisma.locationWaitlistChange.updateMany({ where: { eventId, digestedAt: null }, data: { occurredAt: new Date("2026-10-06T20:00:00Z") } });
  const lateRun = await sendDueLocationWaitlistDigests(new Date("2026-10-06T22:00:00Z"), { deliver: deliverOk });
  assert(lateRun.messageIds.length === 0, "a change after the morning waits for the next day's digest");
  assert(await prisma.messageOutbox.count({ where: { idempotencyKey: { startsWith: digestKeyPrefix } } }) === 2, "still exactly one digest per recipient for the day");
  console.log("ok  the digest is idempotent per recipient per day, and later changes wait for the next morning");

  // The next morning carries the late change, and only to the people responsible for it.
  const nextMorning = new Date("2026-10-07T13:00:00Z");
  const next = await sendDueLocationWaitlistDigests(nextMorning, { deliver: deliverOk });
  assert(next.status === "QUEUED", `the next morning sends the late change, got ${next.status}`);
  const nextMails = await prisma.messageOutbox.findMany({ where: { idempotencyKey: { startsWith: "location-waitlist-digest:2026-10-07:" } } });
  assert(nextMails.length === 1 && nextMails[0]!.recipientEmail === `${P}-admin@example.test`, "the late change (at a location with no coordinator) went only to the event administrator");
  assert(nextMails[0]!.bodyTextSnapshot.includes("Promoted to a registration: Wl Club g2") && !nextMails[0]!.bodyTextSnapshot.includes("Camp Heritage 1"), "it lists just what changed since the last digest");
  // An empty day sends nothing.
  const emptyDay = await sendDueLocationWaitlistDigests(new Date("2026-10-08T14:00:00Z"), { deliver: deliverOk });
  assert(emptyDay.status === "NO_CHANGES" && emptyDay.messageIds.length === 0, "a day with no changes sends no email");
  console.log("ok  the next morning carries only what changed since, and an empty day sends nothing");

  // 8b. Opposite triggers at once: a capacity raise at X (which locks X, then offers seats to clubs waiting at Y)
  // and an amendment removing people at Y (which locks Y, then offers seats to clubs waiting at X) take the
  // two location locks in opposite orders. A deadlock must not fail either change: both commit, and neither
  // location is ever over capacity. Repeated, since the collision depends on timing.
  for (let round = 0; round < raceRounds; round += 1) {
    const [holderX, holderY, waiterX, waiterY] = raceKeys.slice(round * 4, round * 4 + 4) as [string, string, string, string];
    const siteX = await locations.createEventLocation(eventId, staffUserId, { name: `Race X ${round}`, capacity: 1 });
    const siteY = await locations.createEventLocation(eventId, staffUserId, { name: `Race Y ${round}`, capacity: 2 });
    await submit(holderX, siteX.id, 1);
    await submit(holderY, siteY.id, 2);
    assert((await submit(waiterX, siteX.id, 1)).registrationStatus === "WAITLISTED", `round ${round}: a waiter at X`);
    assert((await submit(waiterY, siteY.id, 1)).registrationStatus === "WAITLISTED", `round ${round}: a waiter at Y`);
    const holderYRow = await regOf(holderY);
    const outcomes = await Promise.allSettled([
      locations.updateEventLocation(eventId, siteX.id, staffUserId, { capacity: 2 }),
      club.amendClubRegistration(clubOf(holderY), eventId, actor, { ...editInput(holderY), expectedUpdatedAt: holderYRow.updatedAt.toISOString() }, october),
    ]);
    assert(outcomes.every((outcome) => outcome.status === "fulfilled"), `round ${round}: both opposite triggers commit, got ${outcomes.map((outcome) => (outcome.status === "rejected" ? String(outcome.reason) : "ok")).join(" | ")}`);
    assert(await statusOf(waiterX) === "SUBMITTED" && await statusOf(waiterY) === "SUBMITTED", `round ${round}: each location's waiting club got its seat`);
    assert(await seats(siteX.id) === 2 && await seats(siteY.id) === 2, `round ${round}: neither location is over capacity, got ${await seats(siteX.id)} and ${await seats(siteY.id)}`);
  }
  console.log("ok  opposite triggers (a capacity raise and an amendment at two locations) both commit and never overfill");

  // 10. The coordinator portal lists the clubs waiting at the locations they coordinate, and a revoked coordinator sees none.
  const portalWaiter = await submit("a4", locA.id, 2);
  assert(portalWaiter.registrationStatus === "WAITLISTED", "a4 waits at Camp Heritage 1");
  const portal = await listWaitingClubsForCoordinator(prisma, coordinatorAccountId);
  assert(portal.length === 1 && portal[0]!.locationName === "Camp Heritage 1", "the coordinator sees their own location");
  assert(portal[0]!.clubs.length === 1 && portal[0]!.clubs[0]!.clubName === "Wl Club a4" && portal[0]!.clubs[0]!.place === 1 && portal[0]!.clubs[0]!.attendeeCount === 2, "and the club waiting there, with its place in line");
  assert((await listWaitingClubsForCoordinator(prisma, revokedAccountId)).length === 0, "a revoked coordinator sees nothing");
  console.log("ok  the coordinator portal lists their location's waiting clubs; a revoked coordinator sees none");

  // 10b. The director's own emails: a delivery failure after the commit never blocks or undoes the registration change.
  await prisma.eventMessageSettings.create({ data: { eventId, deliveryMode: "EXTERNAL_EMAIL", senderName: "IMSDA Events", senderEmail: "events@example.test" } });
  const cancelledWithOutage = await cancel("a2", "Synthetic cancellation during an outage.");
  assert(cancelledWithOutage.autoPromotedRegistration !== null && cancelledWithOutage.pendingMessageIds.length >= 2, "the cancel promoted the waiting club and queued both emails");
  const outage = await processQueuedMessageIdsAfterCommit(cancelledWithOutage.pendingMessageIds, { sendEmail: failing as never, configuration });
  assert(outage.rescheduledIds.length === cancelledWithOutage.pendingMessageIds.length && outage.sentIds.length === 0, `each email is rescheduled after a failed send, got ${JSON.stringify(outage)}`);
  assert(await statusOf("a2") === "CANCELLED" && await statusOf("a4") === "SUBMITTED", "the cancellation and the promotion stand after the send failed");
  const promotionMail = (await messagesFor("a4")).find((message) => message.templateKey === "WAITLIST_PROMOTED");
  assert(promotionMail && promotionMail.status === "PENDING" && promotionMail.attemptCount === 1 && Boolean(promotionMail.lastError), "the failed email keeps a recorded status, attempt and error for the sweep to retry");
  console.log("ok  a director email that fails to send is recorded and retried; the registration change stands");

  // 11. Cloning carries a location's coordinator only if that coordinator is still active.
  const plan = await previewEventClone(staffUserId, { sourceEventId: eventId });
  const none = { value: null, none: true } as const;
  const cloned = await cloneEvent(staffUserId, {
    sourceEventId: eventId,
    expectedFingerprint: plan.fingerprint,
    requestKey: `${P}-clone-key-0001`,
    name: "Waitlist check weekend 2027",
    slug: `${P}-clone-2027`,
    startsOn: "2027-12-04",
    endsOn: "2027-12-05",
    capacity: none,
    registrationOpensOn: none,
    registrationClosesOn: none,
    include: Object.fromEntries(plan.domains.map((domain) => [domain.key, domain.key === "locations"])),
    formLatePricingDates: [],
    formChoiceLimits: [],
    promoCodeWindows: [],
    honorOfferingCapacities: [],
  });
  const clonedLocations = await prisma.eventLocation.findMany({ where: { eventId: cloned.event.id } });
  const coordinatorOf = (name: string) => clonedLocations.find((row) => row.name === name)?.coordinatorAccountId ?? null;
  assert(coordinatorOf("Camp Heritage 1") === coordinatorAccountId, "an active coordinator is carried to the copy");
  assert(coordinatorOf("Des Moines") === null, "a revoked coordinator is not carried to the copy");
  assert(clonedLocations.length === 7 + raceRounds * 2, `every location is copied, got ${clonedLocations.length}`);
  console.log("ok  cloning carries an active coordinator and drops a revoked one");

  // Location errors still carry their codes.
  assert(new EventLocationError("LOCATION_FULL", "x").code === "LOCATION_FULL", "location errors keep their codes");
  console.log("Location waitlist verification passed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error("Cleanup failed", error));
    await prisma.$disconnect();
  });
