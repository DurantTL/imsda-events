/**
 * Proves the Honors Weekend class waitlist (#831) holds on the server, against a
 * real PostgreSQL database with fictitious rows it creates and removes itself:
 *
 *  - youth join a full class's waitlist in order, and a seat that opens is OFFERED
 *    to the next in line (never taken by a direct pick that jumps the line), with
 *    one email to that club's director;
 *  - the director accepts (twice is once); an offer not accepted in time passes to
 *    the next youth, by the sweep or when someone tries to accept late;
 *  - a youth who already holds a class in that session is skipped and keeps their
 *    place, and an offer they can no longer take is released;
 *  - a club at its per-club limit is skipped; waitlist spots and offers never count
 *    toward it, only seats do;
 *  - acceptance re-checks the class's level rule (#832);
 *  - nothing is offered after the class-change deadline, and an offer that was live
 *    at the deadline lapses without passing the seat on;
 *  - two seats opening at once, a direct pick, a sweep and a double accept racing never
 *    overfill a class and never offer out of order; a cancellation passes seats on.
 *
 *   npm run test:honor-class-waitlist
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { ClassSelectionError, getClassSelectionWorkspace, setClassSelections } from "../modules/honors/enrollment-repository";
import { createHonorOffering } from "../modules/honors/repository";
import {
  acceptClassWaitlistOffer,
  joinClassWaitlist,
  leaveClassWaitlist,
  promoteAfterRegistrationCancelled,
  setHonorWaitlistOfferHours,
  sweepClassWaitlists,
  type JoinWaitlistInput,
} from "../modules/honors/waitlist-repository";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "hwl";
const adminId = `${P}_admin`;
const eventId = `${P}_event`;
const clubKeys = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"] as const;
type ClubKey = (typeof clubKeys)[number];
const now = new Date("2026-10-15T15:00:00Z");
const hours = (base: Date, count: number) => new Date(base.getTime() + count * 60 * 60 * 1000);
const late = new Date("2026-12-01T15:00:00Z");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

const rejected = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error);

async function expectCode(work: Promise<unknown>, code: ClassSelectionError["code"], pattern: RegExp | null, what: string) {
  const error = await rejected(work);
  assert(error instanceof ClassSelectionError && error.code === code && (!pattern || pattern.test(error.message)), `${what}: expected ${code}, got ${String(error)}`);
}

const orgOf = (key: ClubKey) => `${P}_org_${key}`;
const regOf = (key: ClubKey) => `${P}_reg_${key}`;
const emailOf = (key: ClubKey) => `${P}-${key}@example.test`;
const honorIds: string[] = [];

async function cleanup() {
  await prisma.messageOutbox.deleteMany({ where: { eventId } });
  await prisma.honorClassWaitlistEntry.deleteMany({ where: { eventId } });
  await prisma.honorEnrollment.deleteMany({ where: { eventId } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId }, { actorUserId: adminId }] } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId } });
  await prisma.registration.deleteMany({ where: { eventId } });
  await prisma.honorOffering.deleteMany({ where: { eventId } });
  await prisma.honorSession.deleteMany({ where: { eventId } });
  await prisma.honor.deleteMany({ where: { id: { startsWith: `${P}_honor_` } } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: { startsWith: `${P}_org_` } } });
  await prisma.event.deleteMany({ where: { id: eventId } });
  await prisma.organization.deleteMany({ where: { id: { startsWith: `${P}_org_` } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.user.deleteMany({ where: { id: adminId } });
}

type Level = "FRIEND" | "GUIDE" | null;
const youth = new Map<string, { attendeeId: string; memberId: string; club: ClubKey }>();

async function addPerson(club: ClubKey, key: string, level: Level = null, type: "YOUTH" | "STAFF" = "YOUTH") {
  const person = await prisma.person.create({ data: { id: `${P}_p_${key}`, firstName: "Test", lastName: key } });
  const member = await prisma.clubRosterMember.create({
    data: { organizationId: orgOf(club), clubYear: "2026-27", personId: person.id, attendeeType: type, classLevel: level, source: "DIRECTOR" },
  });
  const count = await prisma.registrationAttendee.count({ where: { registrationId: regOf(club) } });
  const attendee = await prisma.registrationAttendee.create({
    data: {
      eventId, registrationId: regOf(club), personId: person.id, attendeeType: type, position: count,
      profileSnapshot: { firstName: "Test", lastName: key, ageOnEventDate: 13, clubRosterMemberId: member.id },
    },
  });
  youth.set(key, { attendeeId: attendee.id, memberId: member.id, club });
}

const who = (key: string) => youth.get(key)!;
const director = (club: ClubKey) => ({ accountId: `${P}-director-${club}` });
const attendeeOf = (key: string) => who(key).attendeeId;

const pick = (key: string, classIds: string[], at = now) => setClassSelections(orgOf(who(key).club), eventId, director(who(key).club), { [attendeeOf(key)]: classIds }, at);
const join = (key: string, classId: string, extra: Partial<JoinWaitlistInput> = {}, at = now) =>
  joinClassWaitlist(orgOf(who(key).club), eventId, director(who(key).club), { attendeeId: attendeeOf(key), offeringId: classId, ...extra }, at);
const entryOf = (key: string, classId: string) => prisma.honorClassWaitlistEntry.findFirst({ where: { registrationAttendeeId: attendeeOf(key), offeringId: classId }, orderBy: { joinOrder: "desc" } });
const accept = async (key: string, classId: string, at = now) => {
  const entry = await entryOf(key, classId);
  assert(entry, `${key} has a waitlist entry for the class`);
  return acceptClassWaitlistOffer(orgOf(who(key).club), eventId, director(who(key).club), entry.id, at);
};
const leave = async (key: string, classId: string, at = now) => {
  const entry = await entryOf(key, classId);
  assert(entry, `${key} has a waitlist entry for the class`);
  return leaveClassWaitlist(orgOf(who(key).club), eventId, director(who(key).club), entry.id, at);
};
const statusOf = async (key: string, classId: string) => (await entryOf(key, classId))?.status ?? null;
const seats = (classId: string) => prisma.honorEnrollment.count({ where: { offeringId: classId, consumesSeat: true } });
const holds = async (key: string, classId: string) => (await prisma.honorEnrollment.count({ where: { registrationAttendeeId: attendeeOf(key), offeringId: classId } })) === 1;
const offerMail = (club: ClubKey) => prisma.messageOutbox.findMany({ where: { registrationId: regOf(club), templateKey: "HONOR_CLASS_WAITLIST_OFFER" }, orderBy: { createdAt: "asc" } });
const waitlistView = async (club: ClubKey, at = now) => (await getClassSelectionWorkspace(orgOf(club), eventId, at)).waitlist!;

/** Saving again after "several people were choosing at once" is the product's own answer to a busy moment. */
async function settle(work: () => Promise<unknown>) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const error = await rejected(work());
    if (error === null) return;
    if (!(error instanceof ClassSelectionError && error.code === "SELECTION_CONFLICT")) throw error;
  }
  throw new Error("FAILED: a save kept conflicting");
}

/** Whatever happened, no class holds more than its capacity in seats plus live offers. */
async function assertNoOverfill(when: string, at = now) {
  const offerings = await prisma.honorOffering.findMany({ where: { eventId }, select: { id: true, capacity: true } });
  for (const offering of offerings) {
    const taken = await prisma.honorEnrollment.count({ where: { offeringId: offering.id, consumesSeat: true, registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } } });
    const live = await prisma.honorClassWaitlistEntry.count({ where: { offeringId: offering.id, status: "OFFERED", offerExpiresAt: { gt: at } } });
    assert(taken + live <= offering.capacity, `${when}: class ${offering.id} holds ${taken} seats and ${live} offers for ${offering.capacity}`);
  }
}

async function main() {
  await cleanup();
  await prisma.user.create({ data: { id: adminId, email: `${P}-admin@example.test`, displayName: "Waitlist Admin", globalRole: "SYSTEM_ADMIN" } });
  await prisma.event.create({
    data: {
      id: eventId, slug: `${P}-event`, name: "Class waitlist verification", startsAt: new Date("2026-12-05T15:00:00Z"),
      endsAt: new Date("2026-12-06T20:00:00Z"), isPublished: true, registrationOpensOn: "2026-10-01",
      registrationClosesOn: "2026-11-30", billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB",
    },
  });
  const sessions = await Promise.all(["One", "Two", "Three"].map((name, sortOrder) => prisma.honorSession.create({ data: { eventId, name, normalizedName: name.toLowerCase(), sortOrder } })));
  const [s1, s2, s3] = sessions as [typeof sessions[number], typeof sessions[number], typeof sessions[number]];

  for (const key of clubKeys) {
    await prisma.organization.create({ data: { id: orgOf(key), type: "CLUB", name: `Waitlist Club ${key}`, normalizedName: `waitlist club ${key}` } });
    const holder = await prisma.person.create({ data: { id: `${P}_holder_${key}`, firstName: "Test", lastName: `Director ${key}`, normalizedEmail: emailOf(key) } });
    await prisma.registration.create({ data: { id: regOf(key), eventId, accountHolderPersonId: holder.id, confirmationCode: `REG-${P}-${key}`, status: "SUBMITTED", totalAmount: 0, submittedAt: now } });
    await prisma.clubEventRegistration.create({ data: { eventId, organizationId: orgOf(key), registrationId: regOf(key) } });
  }

  // Classes, made through the staff catalog code. Each teaches its own honor.
  let honorCount = 0;
  const makeClass = async (sessionId: string, capacity: number, extra: Record<string, unknown> = {}) => {
    const honorId = `${P}_honor_${honorCount += 1}`;
    honorIds.push(honorId);
    await prisma.honor.create({ data: { id: honorId, code: `HWL-${honorCount}`, name: `Waitlist honor ${honorCount}`, normalizedName: `waitlist honor ${honorCount}` } });
    const setup = await createHonorOffering(eventId, {
      honorIds: [honorId], span: "SINGLE_SESSION" as const, sessionId, locationId: null, capacity, minimumAge: null, perClubLimit: null,
      teacherName: "Synthetic Teacher", location: "Room 1", additionalCostCents: null, requirementNote: "", isActive: true, ...extra,
    }, adminId);
    return setup.offerings.find((offering) => offering.honorIds.includes(honorId))!.id;
  };
  const classA = await makeClass(s1.id, 2);
  const classX = await makeClass(s2.id, 1);
  const classY = await makeClass(s2.id, 5);
  const classP = await makeClass(s3.id, 1);
  const classQ = await makeClass(s3.id, 5);
  const classL = await makeClass(s1.id, 3, { perClubLimit: 1 });
  const classR = await makeClass(s2.id, 1, { minimumClassLevel: "GUIDE" });
  const classD = await makeClass(s3.id, 1);
  const classD2 = await makeClass(s3.id, 1);
  const classK = await makeClass(s1.id, 2);
  const classZ = await makeClass(s2.id, 1);

  // ---- 1. Order, offers, accept, expiry
  for (const key of ["y1", "y5"]) await addPerson("c1", key);
  for (const key of ["y2", "y6"]) await addPerson("c2", key);
  for (const key of ["y3", "y4"]) await addPerson("c3", key);
  await addPerson("c3", "staff1", null, "STAFF");

  await pick("y1", [classA]);
  await expectCode(join("y3", classA), "WAITLIST_NOT_NEEDED", /still has a seat/, "a class with a free seat takes direct picks, not a waitlist");
  await pick("y2", [classA]);
  assert((await seats(classA)) === 2, "class A is full");
  await expectCode(join("staff1", classA), "SELECTION_INVALID", /don't use a class seat/, "staff use no waitlist spot");
  await expectCode(join("y1", classA), "SELECTION_INVALID", /already has a seat/, "a youth who holds the class can't wait for it");

  await join("y3", classA);
  await join("y5", classA);
  await join("y4", classA);
  await expectCode(join("y3", classA), "ALREADY_WAITING", null, "one place per youth and class");
  assert((await seats(classA)) === 2, "joining a waitlist takes no seat");
  const joined = await prisma.honorClassWaitlistEntry.findMany({ where: { offeringId: classA }, orderBy: { joinOrder: "asc" }, select: { registrationAttendeeId: true } });
  assert(joined.map((row) => row.registrationAttendeeId).join() === [attendeeOf("y3"), attendeeOf("y5"), attendeeOf("y4")].join(), "the line is in join order");
  const c3View = await waitlistView("c3");
  assert(c3View.entries.find((entry) => entry.attendeeId === attendeeOf("y3"))?.place === 1 && c3View.entries.find((entry) => entry.attendeeId === attendeeOf("y4"))?.place === 3, "a club sees its places in line");
  console.log("ok  joining: a free class refuses the waitlist, staff and holders are refused, duplicates are refused, the line keeps join order and takes no seat");

  await pick("y1", []);
  assert((await statusOf("y3", classA)) === "OFFERED" && (await statusOf("y5", classA)) === "WAITING" && (await statusOf("y4", classA)) === "WAITING", "the seat is offered to the first in line only");
  const firstOffer = await entryOf("y3", classA);
  assert(firstOffer?.offerExpiresAt?.getTime() === hours(now, 24).getTime() && firstOffer.offerCount === 1, "the offer runs for the event's window (24 hours by default)");
  const c3Mail = await offerMail("c3");
  assert(c3Mail.length === 1 && c3Mail[0]!.recipientEmail === emailOf("c3") && c3Mail[0]!.recipientKind === "INTERNAL", "one email to that club's director");
  assert(c3Mail[0]!.bodyTextSnapshot.includes(`/account/clubs/${orgOf("c3")}/events/${eventId}`) && /Waitlist honor 1/.test(c3Mail[0]!.subjectSnapshot), "the email names the class and links to the club's page");
  assert((await offerMail("c1")).length === 0 && (await offerMail("c2")).length === 0, "no one else is emailed");
  const c2Workspace = await getClassSelectionWorkspace(orgOf("c2"), eventId, now);
  assert(c2Workspace.offerings.find((offering) => offering.id === classA)!.seatsTaken === 2, "a held offer counts as a taken seat in everyone's view");
  await expectCode(pick("y6", [classA]), "CLASS_FULL", null, "another club cannot pick the seat held for the offer");
  await expectCode(pick("y4", [classA]), "CLASS_FULL", null, "nor can someone further down the line jump ahead");
  await assertNoOverfill("after the first offer");
  console.log("ok  a freed seat is offered to the next in line (one director emailed), held against direct picks, and counted as taken");

  await expectCode(acceptClassWaitlistOffer(orgOf("c1"), eventId, director("c1"), firstOffer.id, now), "OFFER_NOT_FOUND", null, "another club cannot accept the offer");
  await accept("y3", classA);
  assert((await holds("y3", classA)) && (await statusOf("y3", classA)) === "ACCEPTED" && (await seats(classA)) === 2, "accepting takes the held seat");
  await accept("y3", classA);
  assert((await prisma.honorEnrollment.count({ where: { registrationAttendeeId: attendeeOf("y3"), offeringId: classA } })) === 1, "accepting twice is once");
  console.log("ok  accepting takes the held seat, once, and only for the club that was offered it");

  await pick("y2", []);
  assert((await statusOf("y5", classA)) === "OFFERED" && (await offerMail("c1")).length === 1, "the next seat goes to the next in line (club c1)");
  const noSweep = await sweepClassWaitlists(hours(now, 1));
  assert(noSweep.offered === 0 && noSweep.lapsed === 0, "a sweep before the window runs out changes nothing");
  const swept = await sweepClassWaitlists(hours(now, 25));
  assert((await statusOf("y5", classA)) === "EXPIRED" && (await entryOf("y5", classA))!.resolution === "Offer expired", "an offer not accepted in time expires");
  assert((await statusOf("y4", classA)) === "OFFERED" && swept.offered === 1 && swept.lapsed === 1, "and the seat passes to the next youth");
  assert((await offerMail("c3")).length === 2, "whose director is emailed once");
  assert((await entryOf("y4", classA))!.offerExpiresAt?.getTime() === hours(now, 49).getTime(), "their window runs from when it was offered");
  const again = await sweepClassWaitlists(hours(now, 25));
  assert(again.offered === 0 && again.lapsed === 0 && (await offerMail("c3")).length === 2, "sweeping again offers and emails nothing more");
  await expectCode(accept("y5", classA, hours(now, 26)), "OFFER_NOT_FOUND", null, "an expired offer can't be accepted");
  // Lazy expiry: the window ran out, no sweep has run yet, and the director tries to accept.
  await expectCode(accept("y4", classA, hours(now, 50)), "OFFER_EXPIRED", /ran out/, "accepting after the window is refused");
  assert((await statusOf("y4", classA)) === "EXPIRED", "and the lapse is recorded");
  await pick("y2", [classA], hours(now, 50));
  assert((await holds("y2", classA)) && (await seats(classA)) === 2, "with no one left waiting the free seat is open to anyone again");
  await join("y5", classA, {}, hours(now, 50));
  assert((await entryOf("y5", classA))!.status === "WAITING" && (await entryOf("y5", classA))!.joinOrder > (await entryOf("y4", classA))!.joinOrder, "someone whose offer lapsed can join again, at the end");
  await assertNoOverfill("after expiry");
  console.log("ok  an unaccepted offer passes to the next youth (sweep, or when accepted late), emails each director once, and expired offers can't be accepted");

  // ---- 2. A youth who already holds a class in the session is skipped and keeps their place
  await addPerson("c2", "y7");
  await addPerson("c1", "y8");
  await addPerson("c3", "y9");
  await pick("y7", [classX]);
  await pick("y8", [classY]);
  await join("y8", classX);
  await join("y9", classX);
  await pick("y7", []);
  assert((await statusOf("y8", classX)) === "WAITING" && (await statusOf("y9", classX)) === "OFFERED", "the youth who holds a class in that session is skipped and the next youth is offered the seat");
  await pick("y8", []);
  assert((await statusOf("y8", classX)) === "WAITING" && (await waitlistView("c1")).entries.find((entry) => entry.attendeeId === attendeeOf("y8"))?.place === 1, "dropping the other class doesn't take the seat held for another, and keeps their place first in line");
  await leave("y9", classX);
  assert((await statusOf("y9", classX)) === "DECLINED" && (await statusOf("y8", classX)) === "OFFERED", "when the offered seat is declined it goes to the one who was skipped, who kept their place");
  await accept("y8", classX);
  assert(await holds("y8", classX), "and they can accept it");
  console.log("ok  a youth with a class in that session is skipped, keeps their place, and is offered the next seat when they are free");

  // An offer a youth can no longer take (they picked a class in that session) is released and passes on.
  await addPerson("c4", "y10");
  await addPerson("c1", "y11");
  await addPerson("c2", "y12");
  await pick("y10", [classP]);
  await join("y11", classP);
  await join("y12", classP);
  await pick("y10", []);
  assert((await statusOf("y11", classP)) === "OFFERED", "the first in line is offered the seat");
  await pick("y11", [classQ]);
  assert((await statusOf("y11", classP)) === "WAITING" && (await statusOf("y12", classP)) === "OFFERED", "picking another class in that session releases the offer and passes it on");
  await accept("y12", classP);
  assert(await holds("y12", classP), "and the next youth can accept it");
  await assertNoOverfill("after a conflict release");
  console.log("ok  an offer the youth can no longer take is released, keeps their place, and passes on");

  // ---- 3. Per-club limits count seats only
  for (const [club, key] of [["c1", "y13"], ["c2", "y14"], ["c3", "y15"], ["c1", "y16"], ["c4", "y17"]] as const) await addPerson(club, key);
  await pick("y13", [classL]);
  await pick("y14", [classL]);
  await pick("y15", [classL]);
  await join("y16", classL);
  await join("y17", classL);
  assert((await waitlistView("c1")).entries.length >= 1, "a club at the limit can still hold a waitlist spot");
  await pick("y14", []);
  assert((await statusOf("y16", classL)) === "WAITING" && (await statusOf("y17", classL)) === "OFFERED", "a club at the class's limit is skipped, and the seat goes to the next club");
  const c4Offer = await getClassSelectionWorkspace(orgOf("c4"), eventId, now);
  assert(c4Offer.offerings.find((offering) => offering.id === classL)!.clubSeatsTaken === 0, "an offer is not a seat toward the club's limit");
  await accept("y17", classL);
  assert((await getClassSelectionWorkspace(orgOf("c4"), eventId, now)).offerings.find((offering) => offering.id === classL)!.clubSeatsTaken === 1, "once accepted it is");
  console.log("ok  per-club limits count seats only: waitlist spots and offers don't, and a club at its limit is skipped");

  // ---- 4. Acceptance re-checks the class's level rule (#832)
  await addPerson("c1", "gA", "GUIDE");
  await addPerson("c2", "fF", "FRIEND");
  await addPerson("c2", "gB", "GUIDE");
  await addPerson("c3", "nN", null);
  await pick("gA", [classR]);
  await expectCode(join("fF", classR), "SELECTION_INVALID", /class level Guide or higher, and this person is Friend/, "a youth known to be too low can't join");
  await expectCode(join("nN", classR), "SELECTION_INVALID", /isn't on the roster/, "a missing level needs the director's confirmation to join");
  await join("gB", classR);
  await join("nN", classR, { confirmed: true });
  await pick("gA", []);
  assert((await statusOf("gB", classR)) === "OFFERED", "the first eligible youth is offered the seat");
  await prisma.clubRosterMember.update({ where: { id: who("gB").memberId }, data: { classLevel: "FRIEND" } });
  await expectCode(accept("gB", classR), "SELECTION_INVALID", /this person is Friend/, "acceptance re-checks eligibility");
  assert((await statusOf("gB", classR)) === "OFFERED" && !(await holds("gB", classR)), "a refused acceptance leaves the offer as it was");
  await leave("gB", classR);
  assert((await statusOf("nN", classR)) === "OFFERED", "declining passes it on");
  await accept("nN", classR);
  assert((await prisma.honorEnrollment.findFirst({ where: { registrationAttendeeId: attendeeOf("nN"), offeringId: classR } }))?.levelConfirmedByDirector === true, "the confirmation given when joining is recorded on the seat");
  console.log("ok  waitlist eligibility: joining and accepting both follow the class's level rule, with the join-time confirmation carried to the seat");

  // ---- 5. The class-change deadline (event closes 2026-11-30) and the acceptance window setting
  await expectCode(setHonorWaitlistOfferHours(eventId, 0, adminId), "SELECTION_INVALID", /1 to 168/, "a window under an hour is refused");
  await expectCode(setHonorWaitlistOfferHours(eventId, 169, adminId), "SELECTION_INVALID", /1 to 168/, "a window over a week is refused");
  await setHonorWaitlistOfferHours(eventId, 100, adminId);
  for (const [club, key] of [["c1", "d1"], ["c2", "d2"], ["c3", "d3"], ["c1", "d4"], ["c5", "d5"], ["c6", "d6"]] as const) await addPerson(club, key);
  const beforeDeadline = new Date("2026-11-29T15:00:00Z");
  await pick("d1", [classD], beforeDeadline);
  await pick("d4", [classD2], beforeDeadline);
  await join("d2", classD, {}, beforeDeadline);
  await join("d5", classD2, {}, beforeDeadline);
  await join("d6", classD2, {}, beforeDeadline);
  await pick("d4", [], beforeDeadline);
  const lateOffer = await entryOf("d5", classD2);
  assert(lateOffer?.status === "OFFERED" && lateOffer.offerExpiresAt?.getTime() === hours(beforeDeadline, 100).getTime(), "the event's own window (100 hours here) sets the offer's expiry");
  // The registration closes after 2026-11-30: no seat is offered, a live offer can't be accepted, and it lapses without passing on.
  const closedSweep = await sweepClassWaitlists(late);
  assert((await statusOf("d5", classD2)) === "EXPIRED" && (await entryOf("d5", classD2))!.resolution === "Class changes closed", "an offer live at the deadline lapses when class changes close");
  assert((await statusOf("d6", classD2)) === "WAITING" && closedSweep.offered === 0, "and its seat is not passed on after the deadline");
  await expectCode(join("d3", classD, {}, late), "DEADLINE_PASSED", null, "no one can join a waitlist after the deadline");
  await prisma.registration.update({ where: { id: regOf("c1") }, data: { status: "CANCELLED", cancelledAt: late } });
  await promoteAfterRegistrationCancelled(regOf("c1"), late);
  assert((await statusOf("d2", classD)) === "WAITING", "a seat freed after the deadline (a cancellation) is not offered");
  assert((await sweepClassWaitlists(late)).offered === 0, "the sweep offers nothing after the deadline either");
  await prisma.registration.update({ where: { id: regOf("c1") }, data: { status: "SUBMITTED", cancelledAt: null } });
  await setHonorWaitlistOfferHours(eventId, 24, adminId);
  console.log("ok  the deadline: no offers, joins or acceptances after class changes close, a live offer lapses without passing on, and the window is a per-event setting");

  // ---- 6. A cancellation passes seats on (before the deadline)
  await addPerson("c7", "z1");
  await addPerson("c6", "z2");
  await addPerson("c7", "z3");
  await pick("z1", [classZ]);
  await join("z2", classZ);
  await join("z3", classZ);
  await prisma.registration.update({ where: { id: regOf("c7") }, data: { status: "CANCELLED", cancelledAt: now } });
  await promoteAfterRegistrationCancelled(regOf("c7"), now);
  assert((await statusOf("z2", classZ)) === "OFFERED" && (await offerMail("c6")).length >= 1, "a cancelled registration's seat is offered to the next youth, whose director is emailed");
  assert((await statusOf("z3", classZ)) === "REMOVED", "and the cancelled registration's own waitlist place ends");
  await assertNoOverfill("after a cancellation");
  console.log("ok  a cancelled registration's seat is offered on and its own waitlist places end");

  // ---- 7. Two seats opening at once never overfill and never offer out of order
  for (const [club, key] of [["c1", "k1"], ["c2", "k2"], ["c3", "k3"], ["c3", "k4"], ["c4", "k5"], ["c5", "k6"], ["c6", "k7"]] as const) await addPerson(club, key);
  await pick("k1", [classK]);
  await pick("k2", [classK]);
  await join("k3", classK);
  await join("k4", classK);
  await join("k5", classK);
  const race = await Promise.allSettled([
    pick("k1", []),
    pick("k2", []),
    sweepClassWaitlists(now),
    pick("k6", [classK]),
    pick("k7", [classK]),
    sweepClassWaitlists(now),
  ]);
  // A busy moment may ask a director to save again; that is the product's answer, and it must still end correctly.
  for (const [index, key] of [[0, "k1"], [1, "k2"]] as const) {
    if (race[index]!.status === "rejected") await settle(() => pick(key, []));
  }
  assert(!(await holds("k1", classK)) && !(await holds("k2", classK)), "both seats were given up");
  assert(!(await holds("k6", classK)) && !(await holds("k7", classK)), "a direct pick never takes a seat from the line");
  await sweepClassWaitlists(now);
  const statuses = await prisma.honorClassWaitlistEntry.findMany({ where: { offeringId: classK }, orderBy: { joinOrder: "asc" }, select: { status: true } });
  assert(statuses.map((row) => row.status).join() === "OFFERED,OFFERED,WAITING", `two seats, two offers in order, the third waits (got ${statuses.map((row) => row.status).join()})`);
  const offeredNow = await prisma.honorClassWaitlistEntry.count({ where: { offeringId: classK, status: "OFFERED" } });
  assert(offeredNow + (await seats(classK)) === 2, "seats plus offers equal the two seats that opened");
  assert((await offerMail("c3")).filter((message) => /Waitlist honor 10/.test(message.subjectSnapshot)).length === 2 && (await offerMail("c4")).length === 1, "each offer was emailed exactly once, however many sweeps ran");
  // Two accepts of the same offer at the same time are one seat.
  const doubles = await Promise.allSettled([accept("k3", classK), accept("k3", classK)]);
  assert(doubles.some((outcome) => outcome.status === "fulfilled"), "an accept goes through");
  await settle(() => accept("k3", classK));
  assert((await prisma.honorEnrollment.count({ where: { registrationAttendeeId: attendeeOf("k3"), offeringId: classK } })) === 1, "a double accept is one seat");
  await settle(() => accept("k4", classK));
  assert((await seats(classK)) === 2 && (await statusOf("k5", classK)) === "WAITING", "both offered seats are taken and the class is exactly full");
  await assertNoOverfill("after the race");
  console.log("ok  concurrency: two seats opening together with sweeps and direct picks racing are offered in order, once each, and never overfill");

  // ---- 8. The audit trail records each step with ids only
  for (const action of ["HONOR_CLASS_WAITLIST_JOINED", "HONOR_CLASS_WAITLIST_OFFERED", "HONOR_CLASS_WAITLIST_ACCEPTED", "HONOR_CLASS_WAITLIST_OFFER_EXPIRED", "HONOR_CLASS_WAITLIST_DECLINED", "HONOR_CLASS_WAITLIST_OFFER_RELEASED", "HONOR_CLASS_WAITLIST_WINDOW_UPDATED"]) {
    assert((await prisma.auditLog.count({ where: { eventId, action } })) > 0, `${action} is audited`);
  }
  const entries = await prisma.auditLog.findMany({ where: { eventId, action: { startsWith: "HONOR_CLASS_WAITLIST" } }, select: { summary: true, metadata: true } });
  assert(entries.length > 0 && entries.every((entry) => !/Test|Director/.test(entry.summary) && !/firstName|lastName|@example/.test(JSON.stringify(entry.metadata))), "the audit entries name no one");
  console.log("ok  every step is audited, with ids and no names");

  console.log("honor class waitlist: all checks passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error("cleanup failed", error));
    await prisma.$disconnect();
  });
