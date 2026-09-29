/**
 * Proves locations inside one event (#413) against a real PostgreSQL database:
 * staff setup (unique names, reorder, deactivate, delete refused while used,
 * capacity never cut below the people registered), the required pick on a real
 * club submit, per-location capacity under the location row lock (two clubs
 * racing for the last seats, exactly one wins; three racing for two seats, two
 * win), per-location closing dates and last days (other locations stay open,
 * a location may run later than the event), changing location on a director
 * edit, the location filters and CSV columns staff use, cloning with shifted
 * dates, and that an event with no locations behaves exactly as before.
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:event-locations
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { PrismaClient, RegistrationFormStatus } from "@prisma/client";

loadEnvConfig(process.cwd());
// A synthetic key for this run's own sealed birth dates, when none is configured.
process.env.SECRET_ENCRYPTION_KEY ||= "verify-event-locations-synthetic-key-not-a-secret";

const prisma = new PrismaClient();
const P = "loc";
const staffUserId = `${P}_staff`;
const eventId = `${P}_event`;
const otherEventId = `${P}_other_event`;
const plainEventId = `${P}_plain_event`;
const formSlug = `${P}-club-form`;
const formVersionId = `${P}_formver_1`;
const clubKeys = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"] as const;
const clubOf = (key: string) => `${P}_club_${key}`;
const actor = { userId: staffUserId, actAsId: `${P}_actas` };
const october = new Date("2026-10-05T15:00:00Z");
const midOctober = new Date("2026-10-15T15:00:00Z");
const afterEvent = new Date("2026-12-10T15:00:00Z");
const afterLate = new Date("2026-12-21T15:00:00Z");

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
  const registrationIds = (await prisma.registration.findMany({ where: { eventId: { startsWith: `${P}_` } }, select: { id: true } })).map((row) => row.id);
  const cloneIds = (await prisma.eventCloneRecord.findMany({ where: { actorUserId: staffUserId }, select: { resultEventId: true } })).map((row) => row.resultEventId);
  const eventIds = [eventId, otherEventId, plainEventId, ...cloneIds];
  await prisma.messageOutbox.deleteMany({ where: { registrationId: { in: registrationIds } } });
  // Amendment records are immutable by trigger; this script's own synthetic rows are removed with the
  // trigger off for that one transaction, and it is back on before anything else can write.
  await prisma.$transaction([
    prisma.$executeRawUnsafe('ALTER TABLE "RegistrationOperation" DISABLE TRIGGER "RegistrationOperation_immutable"'),
    prisma.registrationOperation.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.$executeRawUnsafe('ALTER TABLE "RegistrationOperation" ENABLE TRIGGER "RegistrationOperation_immutable"'),
  ]);
  await prisma.eventCloneRecord.deleteMany({ where: { actorUserId: staffUserId } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: eventIds } }, { actorUserId: staffUserId }] } });
  await prisma.clubRegistrationDraft.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.registration.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: { startsWith: `${P}_` } } });
  await prisma.organization.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.person.deleteMany({ where: { firstName: { startsWith: "Loc" }, lastName: "Director" } });
  await prisma.user.deleteMany({ where: { id: staffUserId } });
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
  const { listRegistrations } = await import("../modules/registrations/repository");
  const { getClubEventRecords } = await import("../modules/reporting/club-event-reports-repository");
  const { buildCampingReport, campingReportCsv } = await import("../modules/reporting/club-event-reports");
  const { churchAmountsOwedCsvRows } = await import("../modules/club-registrations/church-owed");
  const { previewEventClone, cloneEvent } = await import("../modules/event-clones/repository");
  const { getClubPacketData } = await import("../modules/reporting/club-packet-repository");

  await cleanup();
  await prisma.user.create({ data: { id: staffUserId, email: `${P}-staff@example.test`, displayName: "Locations Check Staff", globalRole: "SYSTEM_ADMIN" } });
  await prisma.organization.createMany({
    data: clubKeys.map((key) => ({ id: clubOf(key), type: "CLUB" as const, name: `Loc Club ${key}`, normalizedName: `loc club ${key}` })),
  });
  const eventData = {
    startsAt: new Date("2026-12-05T15:00:00Z"), endsAt: new Date("2026-12-06T22:00:00Z"), timezone: "America/Chicago", isPublished: true,
    registrationOpensOn: "2026-10-01", registrationClosesOn: "2026-11-30", billingMode: "DEFERRED_ORGANIZATION_INVOICE" as const, audience: "CLUB" as const,
  };
  await prisma.event.create({ data: { id: eventId, slug: `${P}-event`, name: "Locations check weekend", ...eventData } });
  await prisma.event.create({ data: { id: otherEventId, slug: `${P}-other-event`, name: "Locations check other", ...eventData } });
  await prisma.event.create({ data: { id: plainEventId, slug: `${P}-plain-event`, name: "Locations check plain", ...eventData } });

  const sealed = sealBirthDate("2014-12-06");
  const memberIds = new Map<string, string[]>();
  for (const key of clubKeys) {
    const ids: string[] = [];
    for (const suffix of ["m1", "m2"]) {
      const person = await prisma.person.create({ data: { id: `${P}_${key}_${suffix}`, firstName: "Loc", lastName: `${key}${suffix}` } });
      const member = await prisma.clubRosterMember.create({
        data: { organizationId: clubOf(key), clubYear: "2026-27", personId: person.id, attendeeType: "YOUTH", role: "Pathfinder", sealedBirthDate: sealed, source: "DIRECTOR" },
      });
      ids.push(member.id);
    }
    memberIds.set(key, ids);
  }

  const definition = registrationFormDefinitionSchema.parse({
    title: "Locations check club registration",
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
  for (const id of [eventId, plainEventId]) {
    await prisma.registrationForm.create({
      data: {
        id: `${P}_form_${id}`, eventId: id, createdByUserId: staffUserId, name: definition.title, slug: formSlug, status: RegistrationFormStatus.PUBLISHED,
        versions: { create: { id: id === eventId ? formVersionId : `${P}_formver_plain`, createdByUserId: staffUserId, versionNumber: 1, status: RegistrationFormStatus.PUBLISHED, publishedAt: new Date(), definition } },
      },
    });
  }

  /** A real club submit through the same transaction the director's form uses. */
  async function submit(key: string, locationId: string | null, at: Date, people = 1, targetEvent = eventId) {
    const ids = memberIds.get(key)!.slice(0, people);
    return club.submitClubRegistration(clubOf(key), targetEvent, actor, {
      versionId: targetEvent === eventId ? formVersionId : `${P}_formver_plain`,
      idempotencyKey: randomUUID(),
      responses: { primary_contact_first_name: "Loc", primary_contact_last_name: "Director", email: `${P}-${key}@example.test` },
      attendees: ids.map((id) => ({ clientId: clubAttendeeClientId(id), responses: {} })),
      website: "",
    }, at, { locationId });
  }
  const regOf = (key: string, targetEvent = eventId) => prisma.registration.findFirstOrThrow({
    where: { eventId: targetEvent, clubRegistration: { organizationId: clubOf(key) } },
    select: { id: true, locationId: true, status: true, updatedAt: true },
  });
  const seats = (locationId: string) => prisma.registrationAttendee.count({
    where: { registration: { locationId, status: { in: ["SUBMITTED", "CONFIRMED"] } } },
  });

  // 1. Setup: names are unique per event ignoring case, order is saved, dates are validated.
  const heritage = await locations.createEventLocation(eventId, staffUserId, { name: "Camp Heritage 1", address: "1 Synthetic Rd", capacity: 3 });
  await expectCode(locations.createEventLocation(eventId, staffUserId, { name: "  camp   HERITAGE 1 " }), "LOCATION_NAME_TAKEN", "a name is unique per event, ignoring case and spacing");
  const sameNameElsewhere = await locations.createEventLocation(otherEventId, staffUserId, { name: "Camp Heritage 1" });
  assert(sameNameElsewhere.id !== heritage.id, "another event can reuse a location name");
  const desMoines = await locations.createEventLocation(eventId, staffUserId, { name: "Des Moines", capacity: 2 });
  const kansasCity = await locations.createEventLocation(eventId, staffUserId, { name: "Kansas City Multicultural", capacity: 5 });
  const early = await locations.createEventLocation(eventId, staffUserId, { name: "Early Site", registrationClosesOn: "2026-10-10" });
  const late = await locations.createEventLocation(eventId, staffUserId, { name: "Late Site", firstDay: "2026-12-19", lastDay: "2026-12-20", registrationClosesOn: "2026-12-15", capacity: 10 });
  assert([heritage, desMoines, kansasCity, early, late].map((row) => row.sortOrder).join() === "0,1,2,3,4", "new locations take the next order");
  const bad = await caught(locations.createEventLocation(eventId, staffUserId, { name: "Backwards", firstDay: "2026-12-06", lastDay: "2026-12-05" }));
  assert(bad instanceof Error && bad.name === "ZodError", "a last day before the first day is refused");
  await locations.reorderEventLocations(eventId, staffUserId, { orderedIds: [kansasCity.id, heritage.id, desMoines.id, early.id, late.id] });
  const ordered = (await locations.listEventLocations(eventId)).map((row) => row.name);
  assert(ordered[0] === "Kansas City Multicultural" && ordered[1] === "Camp Heritage 1", "the saved order is kept");
  await expectCode(locations.reorderEventLocations(eventId, staffUserId, { orderedIds: [heritage.id] }), "LOCATION_ORDER_MISMATCH", "a reorder must list every location");
  console.log("ok  setup: unique names per event, saved order, validated dates");

  // 2. The pick is required, and only an active location of this event can be picked.
  await expectCode(submit("c1", null, october), "LOCATION_REQUIRED", "a club must pick when the event has locations");
  await expectCode(submit("c1", sameNameElsewhere.id, october), "LOCATION_INVALID", "a location of another event is refused");
  await expectCode(submit("c1", "no-such-location", october), "LOCATION_INVALID", "an unknown location is refused");
  const inactive = await locations.createEventLocation(eventId, staffUserId, { name: "Retired Site", isActive: false });
  await expectCode(submit("c1", inactive.id, october), "LOCATION_INVALID", "an inactive location can't be picked");
  assert(await prisma.registration.count({ where: { eventId } }) === 0, "a refused pick created nothing");
  console.log("ok  a club must pick an active location of this event");

  // 3. Two clubs race for the last seats: exactly one wins, and the location is never over capacity.
  const raced = await Promise.allSettled([submit("c1", heritage.id, october, 2), submit("c2", heritage.id, october, 2)]);
  const raceWinners = raced.flatMap((result, index) => (result.status === "fulfilled" ? [["c1", "c2"][index]!] : []));
  const raceLosers = raced.flatMap((result, index) => (result.status === "rejected" ? [{ key: ["c1", "c2"][index]!, reason: result.reason as unknown }] : []));
  assert(raceWinners.length === 1 && raceLosers.length === 1, `expected one winner of the last seats, got ${raceWinners.length}`);
  assert(raceLosers[0]!.reason instanceof EventLocationError && raceLosers[0]!.reason.code === "LOCATION_FULL", `the loser is told the location is full, got ${String(raceLosers[0]!.reason)}`);
  assert(await seats(heritage.id) === 2, "exactly the winner's two seats are taken");
  assert(await prisma.registration.count({ where: { eventId, locationId: heritage.id } }) === 1, "only one registration holds the location");
  // The one seat left still goes to a club that asks for one.
  await submit(raceLosers[0]!.key, heritage.id, october, 1);
  assert(await seats(heritage.id) === 3, "the last seat goes to a club that fits");
  await expectCode(submit("c3", heritage.id, october, 1), "LOCATION_FULL", "a full location refuses another club");
  console.log("ok  two clubs racing for the last seats: exactly one won, and a full location refuses more");

  // 4. Three clubs, one seat each, two seats at Des Moines: exactly two win.
  const trioKeys = ["c3", "c4", "c5"];
  const trio = await Promise.allSettled(trioKeys.map((key) => submit(key, desMoines.id, october)));
  const trioWon = trioKeys.filter((_, index) => trio[index]!.status === "fulfilled");
  const trioLost = trioKeys.filter((_, index) => trio[index]!.status === "rejected");
  assert(trioWon.length === 2 && trioLost.length === 1, `expected two winners for two seats, got ${trioWon.length}`);
  assert(await seats(desMoines.id) === 2, "Des Moines holds exactly its two seats");
  const trioReason = (trio[trioKeys.indexOf(trioLost[0]!)] as PromiseRejectedResult).reason as unknown;
  assert(trioReason instanceof EventLocationError && trioReason.code === "LOCATION_FULL", `the third club is told it is full, got ${String(trioReason)}`);
  console.log("ok  three clubs racing for two seats: exactly two won");

  // 5. Each location closes on its own dates; the others stay open.
  await expectCode(submit("c6", early.id, midOctober), "REGISTRATION_CLOSED", "a location past its own closing date is closed");
  await submit("c6", early.id, october);
  assert((await regOf("c6")).locationId === early.id, "the same location took a registration before its closing date");
  await submit(trioLost[0]!, kansasCity.id, midOctober);
  assert((await regOf(trioLost[0]!)).locationId === kansasCity.id, "another location stayed open while the early one closed");
  console.log("ok  a location's closing date closes only that location");

  // 6. A director edit follows the registration's own location dates.
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
  const c6 = await regOf("c6");
  await expectCode(
    club.amendClubRegistration(clubOf("c6"), eventId, actor, { ...editInput("c6"), expectedUpdatedAt: c6.updatedAt.toISOString() }, midOctober),
    "REGISTRATION_CLOSED",
    "edits close with the registration's own location",
  );
  // A club at Kansas City (no closing date of its own) can still edit that same day.
  const kcClubKey = trioLost[0]!;
  const kcRegistration = await regOf(kcClubKey);
  await club.amendClubRegistration(clubOf(kcClubKey), eventId, actor, {
    ...editInput(kcClubKey, { selectedMemberIds: memberIds.get(kcClubKey)!.slice(0, 2) }),
    expectedUpdatedAt: kcRegistration.updatedAt.toISOString(),
  }, midOctober);
  assert(await prisma.registrationAttendee.count({ where: { registrationId: kcRegistration.id } }) === 2, "the Kansas City club added a second person while the early site was closed");
  console.log("ok  a director edit follows the registration's own location dates");

  // 6b. Adding people is checked against the location's capacity; switching location needs room and an open location.
  const dmKey = trioWon[0]!;
  const dmRegistration = await regOf(dmKey);
  assert(dmRegistration.locationId === desMoines.id, "a Des Moines club exists to edit");
  await expectCode(
    club.amendClubRegistration(clubOf(dmKey), eventId, actor, {
      ...editInput(dmKey, { selectedMemberIds: memberIds.get(dmKey)!.slice(0, 2) }),
      expectedUpdatedAt: dmRegistration.updatedAt.toISOString(),
    }, midOctober),
    "LOCATION_CAPACITY_UNAVAILABLE",
    "adding people beyond the location's capacity is refused",
  );
  await expectCode(
    club.amendClubRegistration(clubOf(dmKey), eventId, actor, { ...editInput(dmKey, { locationId: heritage.id }), expectedUpdatedAt: dmRegistration.updatedAt.toISOString() }, midOctober),
    "LOCATION_CAPACITY_UNAVAILABLE",
    "switching to a full location is refused",
  );
  await expectCode(
    club.amendClubRegistration(clubOf(dmKey), eventId, actor, { ...editInput(dmKey, { locationId: early.id }), expectedUpdatedAt: dmRegistration.updatedAt.toISOString() }, midOctober),
    "REGISTRATION_CLOSED",
    "switching to a closed location is refused",
  );
  assert((await regOf(dmKey)).locationId === desMoines.id, "a refused switch changes nothing");
  await club.amendClubRegistration(clubOf(dmKey), eventId, actor, { ...editInput(dmKey, { locationId: kansasCity.id }), expectedUpdatedAt: dmRegistration.updatedAt.toISOString() }, midOctober);
  assert((await regOf(dmKey)).locationId === kansasCity.id, "the registration moved to the new location");
  assert(await seats(desMoines.id) === 1, "the seat left Des Moines with the registration");
  // The vacated seat is free again for another club.
  await submit("c7", desMoines.id, midOctober);
  assert(await seats(desMoines.id) === 2, "the vacated Des Moines seat was reused");
  console.log("ok  changing location: refused when full or closed, allowed with room, and the old seat is freed");

  // 7. A location may run past the event's own closing date and last day (#575 applies to its own last day).
  const lateSubmit = (key: string, at: Date, locationId: string) => submit(key, locationId, at);
  await expectCode(lateSubmit("c8", afterEvent, heritage.id), "REGISTRATION_CLOSED", "after the event's dates, a location on the event's dates is closed");
  const lateDone = await lateSubmit("c8", afterEvent, late.id);
  assert(lateDone.confirmationCode && (await regOf("c8")).locationId === late.id, "a location running later than the event still takes registrations");
  await expectCode(lateSubmit("c9", afterLate, late.id), "REGISTRATION_CLOSED", "after a location's own last day it is closed");
  console.log("ok  a location may run later than the event, and closes after its own last day");

  // 7b. A held location lock is a bounded wait: the club submit and the staff edit both give up after 5s as
  // a retryable LOCATION_BUSY (503), and nothing was written.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "EventLocation" WHERE "id" = ${desMoines.id} FOR UPDATE`;
    await held;
  }, { timeout: 60_000, maxWait: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const [busySubmit, busyEdit] = await Promise.all([
    caught(submit("c9", desMoines.id, midOctober)),
    caught(locations.updateEventLocation(eventId, desMoines.id, staffUserId, { address: "Busy check" })),
  ]);
  release();
  await holder;
  assert(busySubmit instanceof EventLocationError && busySubmit.code === "LOCATION_BUSY", `a held lock makes the submit LOCATION_BUSY, got ${String(busySubmit)}`);
  assert(busyEdit instanceof EventLocationError && busyEdit.code === "LOCATION_BUSY", `a held lock makes the staff edit LOCATION_BUSY, got ${String(busyEdit)}`);
  assert(await prisma.clubEventRegistration.count({ where: { eventId, organizationId: clubOf("c9") } }) === 0, "the busy submit wrote nothing");
  assert((await prisma.eventLocation.findUniqueOrThrow({ where: { id: desMoines.id } })).address === null, "the busy edit wrote nothing");
  console.log("ok  a held location lock times out after 5s as a retryable LOCATION_BUSY and writes nothing");

  // 8. Deleting: refused while any registration uses the location; capacity can't drop below use.
  await expectCode(locations.deleteEventLocation(eventId, heritage.id, staffUserId), "LOCATION_IN_USE", "a used location can't be deleted");
  await expectCode(locations.updateEventLocation(eventId, heritage.id, staffUserId, { capacity: 1 }), "LOCATION_CAPACITY_BELOW_USAGE", "capacity can't drop below the people registered");
  await locations.updateEventLocation(eventId, kansasCity.id, staffUserId, { isActive: false });
  await expectCode(submit("c9", kansasCity.id, midOctober), "LOCATION_INVALID", "a deactivated location can't be picked");
  await locations.updateEventLocation(eventId, kansasCity.id, staffUserId, { isActive: true });
  const unused = await locations.createEventLocation(eventId, staffUserId, { name: "Never Used" });
  const afterDelete = await locations.deleteEventLocation(eventId, unused.id, staffUserId);
  assert(!afterDelete.some((row) => row.id === unused.id), "an unused location can be deleted");
  console.log("ok  delete refused while used, capacity never below use, deactivate and reactivate");

  // 9. Filters and exports: each location alone, or all combined with the location named.
  const all = await listRegistrations(eventId);
  const justHeritage = await listRegistrations(eventId, { locationId: heritage.id });
  assert(justHeritage.length > 0 && justHeritage.length < all.length && justHeritage.every((row) => row.location?.id === heritage.id), "the registration list filters by location");
  assert(all.every((row) => row.location !== null), "all locations lists everything with the location named");
  const records = await getClubEventRecords(eventId);
  const heritageRecords = await getClubEventRecords(eventId, { locationId: heritage.id });
  assert(records.clubs.length === all.length && heritageRecords.clubs.length === justHeritage.length, "club reports filter by location");
  assert(records.clubs.every((row) => row.locationName), "every club record names its location");
  const campingAll = campingReportCsv(buildCampingReport(records.clubs));
  assert(campingAll.split("\n")[0]!.includes("Location"), "the combined export has a Location column");
  const owed = await club.listChurchAmountsOwed(eventId);
  assert(owed.every((row) => row.locationName), "church amounts owed name each location");
  assert(churchAmountsOwedCsvRows(owed)[0]!.includes("Location"), "the church-owed export has a Location column");
  assert((await club.listChurchAmountsOwed(eventId, { locationId: heritage.id })).length === justHeritage.length, "church amounts owed filter by location");
  assert((await club.listClubCheckInInfo(eventId, { locationId: heritage.id })).length === justHeritage.length, "club check-in filters by location");
  const heritageClub = heritageRecords.clubs[0]!;
  const packet = await getClubPacketData(eventId, heritageClub.organizationId);
  assert(packet?.club.location?.name === "Camp Heritage 1" && packet.club.location.address === "1 Synthetic Rd", "the club packet shows the location");
  const workspace = await club.getClubEventWorkspace(heritageClub.organizationId, eventId, midOctober);
  assert(workspace.registration?.location?.name === "Camp Heritage 1" && workspace.locations.length >= 4, "the director's page shows the chosen location");
  assert(workspace.locations.find((row) => row.id === desMoines.id)?.full === true, "a full location shows as full and can't be picked");
  console.log("ok  registrations, club reports, church-owed, check-in and the packet filter by location and name it");

  // 10. Cloning copies active locations with dates moved by the event's own shift.
  await locations.updateEventLocation(eventId, early.id, staffUserId, { isActive: false });
  const plan = await previewEventClone(staffUserId, { sourceEventId: eventId });
  const locationDomain = plan.domains.find((domain) => domain.key === "locations");
  assert(locationDomain && locationDomain.count === 4, "the preview counts the active locations");
  const none = { value: null, none: true } as const;
  const cloneSlug = `${P}-clone-2027`;
  const cloned = await cloneEvent(staffUserId, {
    sourceEventId: eventId,
    expectedFingerprint: plan.fingerprint,
    requestKey: `${P}-clone-key-0001`,
    name: "Locations check weekend 2027",
    slug: cloneSlug,
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
  const clonedLocations = await prisma.eventLocation.findMany({ where: { eventId: cloned.event.id }, orderBy: { sortOrder: "asc" } });
  assert(clonedLocations.map((row) => row.name).join("|") === "Kansas City Multicultural|Camp Heritage 1|Des Moines|Late Site", `active locations are copied in order, got ${clonedLocations.map((row) => row.name).join("|")}`);
  const clonedLate = clonedLocations.find((row) => row.name === "Late Site")!;
  assert(clonedLate.firstDay === "2027-12-18" && clonedLate.lastDay === "2027-12-19" && clonedLate.registrationClosesOn === "2027-12-14", `dates moved by 364 days, got ${clonedLate.firstDay} ${clonedLate.lastDay} ${clonedLate.registrationClosesOn}`);
  assert(clonedLocations.find((row) => row.name === "Camp Heritage 1")?.capacity === 3 && clonedLocations.find((row) => row.name === "Camp Heritage 1")?.address === "1 Synthetic Rd", "capacity and address are copied");
  assert(await prisma.registration.count({ where: { eventId: cloned.event.id } }) === 0, "no registration is copied");
  console.log("ok  cloning copies active locations with shifted dates and no registrations");

  // 11. An event with no locations behaves exactly as before: no pick, no location on anything.
  const plain = await submit("c1", null, october, 1, plainEventId);
  assert(plain.confirmationCode, "a club registers on an event with no locations without picking");
  const plainRegistration = await regOf("c1", plainEventId);
  assert(plainRegistration.locationId === null, "no location is recorded");
  await expectCode(submit("c2", heritage.id, october, 1, plainEventId), "LOCATION_INVALID", "a location of another event is never accepted");
  const plainList = await listRegistrations(plainEventId);
  assert(plainList.every((row) => row.location === null), "no location is named on an event without locations");
  const nullable = await prisma.$queryRaw<{ is_nullable: string }[]>`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'Registration' AND column_name = 'locationId'`;
  assert(nullable[0]?.is_nullable === "YES", "Registration.locationId is a nullable column");
  console.log("ok  an event with no locations behaves as before");

  await cleanup();
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log("Event locations verification passed.");
  })
  .catch(async (error) => {
    console.error(error);
    try { await cleanup(); } catch { /* best effort */ }
    await prisma.$disconnect();
    process.exit(1);
  });
