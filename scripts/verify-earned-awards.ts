/**
 * Proves earned awards (#532) against a real PostgreSQL database, on top of
 * the club order layer (#487, #497): a completed class only *suggests* its
 * insignia set and nothing is added until a director confirms; an event's
 * patch is suggested for attendees only (checked in, or registered once an
 * event with no check-ins is over) and confirming a non-attendee is refused;
 * Master Award eligibility follows stored multi-group rules against members'
 * latest COMPLETED honors; rule imports arrive as drafts, changes are audited,
 * and a rule can't be activated until it's ready; earned items flow through
 * one order batch with honors and uniforms, one AdventSource file, receiving,
 * stock and handing out; "already has it" changes no stock; double submits
 * happen once; a view-only load writes nothing; and cleanup of departed
 * members is filtered by source type. Uses fictitious rows it creates and
 * removes itself, and expects a database without the real supply catalog
 * (a fresh CI or scratch database).
 *
 *   npm run test:earned-awards
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { clubYearFor } from "../modules/club-rosters/domain";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "earn";
const staffUserId = `${P}_staff`;
const clubs = {
  main: `${P}_club`,
  patch: `${P}_club_patch`,
  master: `${P}_club_master`,
  combo: `${P}_club_combo`,
  race: `${P}_club_race`,
  view: `${P}_club_view`,
  depart: `${P}_club_depart`,
  other: `${P}_club_other`,
};
const items = {
  strip: `${P}_item_strip`,
  chevron: `${P}_item_chevron`,
  pin: `${P}_item_pin`,
  // No "Trail Friend Ribbon Bar" row on purpose: the catalog is missing one set item.
  camporee: `${P}_item_camporee`,
  camporeeNumbered: `${P}_item_camporee_numbered`,
  goodConduct: `${P}_item_good_conduct`,
  tlt: `${P}_item_tlt`,
  masterHealth: `${P}_item_master_health`,
  honorPatch: `${P}_item_honor_patch`,
  scarf: `${P}_item_scarf`,
  inactive: `${P}_item_inactive`,
};
const honorIds = Array.from({ length: 10 }, (_, index) => `${P}_honor_${index + 1}`);
const honorNames = honorIds.map((_, index) => `Earn Check Honor ${index + 1}`);
const events = { mixed: `${P}_event_mixed`, camporee: `${P}_event_camporee`, noCheckIns: `${P}_event_nocheckin`, upcoming: `${P}_event_upcoming`, general: `${P}_event_general` };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function expectCode(promise: Promise<unknown>, code: string, message: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  assert(error && typeof error === "object" && "code" in error && (error as { code: string }).code === code, `${message}: expected ${code}, got ${String(error)}`);
}

const startsWithP = { startsWith: `${P}_` };
const ruleNamePrefix = "earn check";

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: staffUserId }, { metadata: { path: ["organizationId"], string_starts_with: `${P}_` } }] } });
  await prisma.checkIn.deleteMany({ where: { eventId: startsWithP } });
  await prisma.registrationAttendee.deleteMany({ where: { eventId: startsWithP } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId: startsWithP } });
  await prisma.registration.deleteMany({ where: { eventId: startsWithP } });
  await prisma.eventAwardItem.deleteMany({ where: { eventId: startsWithP } });
  await prisma.event.deleteMany({ where: { id: startsWithP } });
  await prisma.clubOrderNeed.deleteMany({ where: { organizationId: startsWithP } });
  const batches = await prisma.clubSupplyOrderBatch.findMany({ where: { organizationId: startsWithP }, select: { id: true } });
  await prisma.clubSupplyOrderLine.deleteMany({ where: { batchId: { in: batches.map((row) => row.id) } } });
  await prisma.clubSupplyOrderBatch.deleteMany({ where: { organizationId: startsWithP } });
  await prisma.clubSupplyStock.deleteMany({ where: { organizationId: startsWithP } });
  await prisma.memberClassCompletion.deleteMany({ where: { organizationId: startsWithP } });
  await prisma.masterAwardRule.deleteMany({ where: { normalizedName: { startsWith: ruleNamePrefix } } });
  await prisma.clubSupplyItem.deleteMany({ where: { id: startsWithP } });
  await prisma.memberHonorEntry.deleteMany({ where: { organizationId: startsWithP } });
  await prisma.honor.deleteMany({ where: { id: startsWithP } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: startsWithP } });
  await prisma.person.deleteMany({ where: { id: startsWithP } });
  await prisma.organization.deleteMany({ where: { id: startsWithP } });
  await prisma.user.deleteMany({ where: { id: staffUserId } });
}

const now = new Date();
const thisClubYear = clubYearFor(now);
let personCounter = 0;

async function addMember(organizationId: string, name = "Member", status: "ACTIVE" | "INACTIVE" = "ACTIVE", classLevel: "FRIEND" | "COMPANION" = "FRIEND") {
  personCounter += 1;
  const id = `${P}_person_${personCounter}`;
  await prisma.person.create({ data: { id, firstName: `${name}${personCounter}`, lastName: "Sample" } });
  const roster = await prisma.clubRosterMember.create({
    data: { id: `${id}_roster`, organizationId, clubYear: thisClubYear, personId: id, attendeeType: "YOUTH", role: "Pathfinder", classLevel, status, source: "DIRECTOR" },
  });
  return { personId: id, rosterId: roster.id };
}

async function addMembers(organizationId: string, count: number) {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) ids.push((await addMember(organizationId)).personId);
  return ids;
}

async function stockOf(organizationId: string, itemId: string) {
  const row = await prisma.clubSupplyStock.findUnique({ where: { organizationId_itemId: { organizationId, itemId } }, select: { quantityOnHand: true } });
  return row?.quantityOnHand ?? 0;
}

const countNeeds = (organizationId: string, where: Record<string, unknown> = {}) =>
  prisma.clubOrderNeed.count({ where: { organizationId, ...where } });

async function completeHonors(personId: string, organizationId: string, honors: readonly string[], status: "COMPLETED" | "IN_PROGRESS" = "COMPLETED") {
  for (const honorId of honors) {
    await prisma.memberHonorEntry.create({
      data: { personId, honorId, status, completionDate: status === "COMPLETED" ? "2026-06-01" : "", organizationId, recordedByUserId: staffUserId },
    });
  }
}

async function main() {
  const orders = await import("../modules/club-orders/repository");
  const domain = await import("../modules/club-orders/domain");
  const awards = await import("../modules/earned-awards/order-source");
  const rules = await import("../modules/earned-awards/rules-repository");
  const eventItems = await import("../modules/earned-awards/event-items");
  const importer = await import("../modules/earned-awards/master-award-import");
  const { recordUniformNeeds } = await import("../modules/uniforms/order-source");
  const { syncHonorOrderNeeds } = await import("../modules/honors/order-source");
  const { parseCsvMatrix } = await import("../modules/imports/csv-parser");

  await cleanup();
  const actor = { userId: staffUserId, actAsId: `${P}_actas` };
  await prisma.user.create({ data: { id: staffUserId, email: `${P}-staff@example.test`, displayName: "Earned Awards Check Staff", globalRole: "SYSTEM_ADMIN" } });
  await prisma.organization.createMany({
    data: Object.entries(clubs).map(([key, id]) => ({ id, type: "CLUB" as const, name: `Earned Awards Check ${key} Club`, normalizedName: `earned awards check ${key} club` })),
  });
  await prisma.honor.createMany({ data: honorIds.map((id, index) => ({ id, code: `${P.toUpperCase()}-${index + 1}`, name: honorNames[index], normalizedName: honorNames[index].toLowerCase() })) });
  await prisma.clubSupplyItem.createMany({
    data: [
      { id: items.strip, section: "INVESTITURE", name: "Friend Class Name Strip", normalizedName: `${P} friend class name strip`, catalogNumber: "002140" },
      { id: items.chevron, section: "INVESTITURE", name: "Friend Chevron", normalizedName: `${P} friend chevron`, catalogNumber: "002250" },
      { id: items.pin, section: "INVESTITURE", name: "Friend Pin", normalizedName: `${P} friend pin`, catalogNumber: "002120" },
      { id: items.camporee, section: "CAMPOREES", name: "Earn Check Fall Camporee Patch", normalizedName: `${P} fall camporee patch`, catalogNumber: null },
      { id: items.camporeeNumbered, section: "CAMPOREES", name: "Earn Check Memory Verse Pin", normalizedName: `${P} memory verse pin`, catalogNumber: "090002" },
      { id: items.goodConduct, section: "MISCELLANEOUS", name: "Earn Check Good Conduct Bar", normalizedName: `${P} good conduct bar`, catalogNumber: "002304" },
      { id: items.tlt, section: "TEEN_LEADERSHIP_TRAINING", name: "Earn Check TLT Pin", normalizedName: `${P} tlt pin`, catalogNumber: "004100" },
      { id: items.masterHealth, section: "MASTER_AWARDS", name: "Earn Check Health Master Award", normalizedName: `${P} health master award`, catalogNumber: "004035" },
      { id: items.honorPatch, section: "OUTDOOR_INDUSTRIES", name: "Earn Check Camping Patch", normalizedName: `${P} camping patch`, catalogNumber: "005157" },
      { id: items.scarf, section: "CLASS_A_UNIFORM_ACCESSORIES", name: "Earn Check Scarf", normalizedName: `${P} scarf`, catalogNumber: "020001" },
      { id: items.inactive, section: "MISCELLANEOUS", name: "Earn Check Retired Bar", normalizedName: `${P} retired bar`, catalogNumber: "099999", isActive: false },
    ],
  });
  await prisma.clubSupplyItem.update({ where: { id: items.honorPatch }, data: { honorId: honorIds[9] } });

  // ---------------------------------------------------------------- 1. class insignia: suggested, never auto-added
  const [friend, friend2, friend3] = await addMembers(clubs.main, 3);
  const outsider = (await addMember(clubs.other)).personId;
  const before = await prisma.clubOrderNeed.count();
  const recordedClass = await awards.recordClassCompletions(clubs.main, { personIds: [friend, friend2], classLevel: "FRIEND", completedOn: "2026-06-06" }, actor);
  assert(recordedClass.created === 2 && recordedClass.skipped === 0, `two members marked as having completed Friend, got ${JSON.stringify(recordedClass)}`);
  assert(await prisma.clubOrderNeed.count() === before, "marking a class completed adds NO needs at all");
  const suggested = await awards.listInsigniaSuggestions(clubs.main);
  assert(suggested.length === 2 && suggested.every((entry) => entry.classLevel === "FRIEND" && entry.items.length === 3), `each completed class suggests the 3 catalog insignia items, got ${JSON.stringify(suggested)}`);
  assert(suggested.every((entry) => JSON.stringify(entry.missing) === JSON.stringify(["Trail Friend Ribbon Bar"])), "the ribbon bar the catalog lacks is flagged, not dropped");
  assert(await prisma.clubOrderNeed.count() === before, "listing the suggestion writes nothing");
  assert((await awards.recordClassCompletions(clubs.main, { personIds: [friend], classLevel: "FRIEND", completedOn: "2026-06-06" }, actor)).created === 0, "recording the same class again is a no-op");
  await expectCode(awards.recordClassCompletions(clubs.main, { personIds: [friend, outsider], classLevel: "COMPANION", completedOn: "2026-06-06" }, actor), "MEMBER_NOT_ON_ROSTER", "another club's member");
  assert(await prisma.memberClassCompletion.count({ where: { classLevel: "COMPANION", organizationId: clubs.main } }) === 0, "a refused completion records nothing");
  const editorView = await awards.loadEarnedAwardsWorkspace(clubs.main, { forEditing: true });
  assert(editorView.insignia.length === 2 && await countNeeds(clubs.main) === 0, "an editor's load shows the suggestion and still adds nothing");
  console.log("ok  completing a class only suggests its insignia (3 catalog items, 1 flagged missing); nothing is added");

  // Confirmation adds only what the director ticked.
  const first = suggested.find((entry) => entry.personId === friend)!;
  const strip = first.items.find((item) => item.itemId === items.strip)!;
  const confirmed = await awards.confirmInsignia(clubs.main, [{ completionId: first.completionId, itemIds: [items.strip, items.chevron] }], actor);
  assert(confirmed.created === 2 && confirmed.skipped === 0, `two ticked items are added, got ${JSON.stringify(confirmed)}`);
  const insigniaNeeds = await prisma.clubOrderNeed.findMany({ where: { organizationId: clubs.main }, select: { sourceType: true, sourceId: true, status: true, sourceLabel: true, sourceDate: true, personId: true, itemId: true } });
  assert(insigniaNeeds.every((need) => need.sourceType === "AWARD" && need.status === "NEEDED" && need.personId === friend && need.sourceLabel === "Friend insignia" && need.sourceDate === "2026-06-06"), "confirmed insignia are NEEDED AWARD needs for that member, dated the completion");
  assert(insigniaNeeds.some((need) => need.sourceId === `class:${friend}:FRIEND:${items.strip}`), "keyed on member, class and item");
  const afterConfirm = await awards.listInsigniaSuggestions(clubs.main);
  assert(afterConfirm.find((entry) => entry.personId === friend)?.items.map((item) => item.itemId).join() === items.pin, "the unticked item is still suggested");
  assert(strip.catalogNumber === "002140", "the suggestion carries the catalog number");
  // An item that isn't in that class's set is refused with nothing added.
  await expectCode(awards.confirmInsignia(clubs.main, [{ completionId: first.completionId, itemIds: [items.pin, items.goodConduct] }], actor), "NOT_SUGGESTED", "an item outside the set");
  assert(await countNeeds(clubs.main) === 2, "a refused confirmation adds nothing, not even the valid item");
  await expectCode(awards.confirmInsignia(clubs.main, [{ completionId: `${P}_nope`, itemIds: [items.pin] }], actor), "NOT_SUGGESTED", "an unknown completion");
  const insigniaAudit = await prisma.auditLog.findMany({ where: { action: "CLUB_CLASS_INSIGNIA_CONFIRMED", metadata: { path: ["organizationId"], equals: clubs.main } }, select: { metadata: true, summary: true } });
  assert(insigniaAudit.length === 1 && !/Member\d|Sample/.test(JSON.stringify(insigniaAudit)), "the confirmation is audited with counts and item ids, no names");
  // "Not now" stops the suggestion.
  const second = suggested.find((entry) => entry.personId === friend2)!;
  assert((await awards.dismissInsignia(clubs.main, [second.completionId], actor)).dismissed === 1, "skipping a class's insignia");
  assert((await awards.dismissInsignia(clubs.main, [second.completionId], actor)).dismissed === 0, "skipping it twice does nothing");
  assert(!(await awards.listInsigniaSuggestions(clubs.main)).some((entry) => entry.personId === friend2) && await countNeeds(clubs.main, { personId: friend2 }) === 0, "a skipped class is no longer suggested and adds nothing");
  console.log("ok  confirming adds exactly the ticked items (keyed, audited by count); outside items are refused; 'Not now' stops the suggestion");

  // ---------------------------------------------------------------- 2. event patches: attendees only
  const attendedA = await addMember(clubs.patch, "Attended");
  const attendedB = await addMember(clubs.patch, "Attended");
  const undone = await addMember(clubs.patch, "Undone");
  const noShow = await addMember(clubs.patch, "NoShow");
  const inactive = await addMember(clubs.patch, "Inactive", "INACTIVE");
  const otherClubMember = await addMember(clubs.other, "Elsewhere");
  const hostPerson = attendedA.personId;
  const mkEvent = (id: string, audience: "CLUB" | "GENERAL", startsAt: Date, endsAt: Date) => prisma.event.create({
    data: { id, slug: `${id}-slug`, name: `Earn Check ${id}`, startsAt, endsAt, isPublished: true, audience, billingMode: "DEFERRED_ORGANIZATION_INVOICE" },
  });
  const day = 86_400_000;
  await mkEvent(events.camporee, "CLUB", new Date(now.getTime() - 30 * day), new Date(now.getTime() - 28 * day));
  await mkEvent(events.noCheckIns, "CLUB", new Date(now.getTime() - 20 * day), new Date(now.getTime() - 18 * day));
  await mkEvent(events.upcoming, "CLUB", new Date(now.getTime() - day), new Date(now.getTime() + day));
  await mkEvent(events.mixed, "CLUB", new Date(now.getTime() - 12 * day), new Date(now.getTime() - 10 * day));
  await mkEvent(events.general, "GENERAL", new Date(now.getTime() - 5 * day), new Date(now.getTime() - 4 * day));
  let attendeeCounter = 0;
  async function register(eventId: string, organizationId: string, attendees: Array<{ personId: string; rosterId?: string; checkedIn?: "yes" | "undone" | "no" }>) {
    const registration = await prisma.registration.create({ data: { eventId, accountHolderPersonId: hostPerson, confirmationCode: `${P.toUpperCase()}-${eventId.slice(-6)}-${organizationId.slice(-5)}`, status: "SUBMITTED", totalAmount: 0 } });
    await prisma.clubEventRegistration.create({ data: { eventId, organizationId, registrationId: registration.id } });
    for (const [index, entry] of attendees.entries()) {
      attendeeCounter += 1;
      const attendee = await prisma.registrationAttendee.create({
        data: { eventId, registrationId: registration.id, personId: entry.personId, attendeeType: "ATTENDEE", position: index, profileSnapshot: { firstName: "X", lastName: "Y", ...(entry.rosterId ? { clubRosterMemberId: entry.rosterId } : {}) } },
      });
      if (entry.checkedIn === "yes" || entry.checkedIn === "undone") {
        await prisma.checkIn.create({ data: { eventId, registrationAttendeeId: attendee.id, idempotencyKey: `${P}-checkin-${attendeeCounter}`, undoneAt: entry.checkedIn === "undone" ? new Date() : null } });
      }
    }
  }
  const temporary = await prisma.person.create({ data: { id: `${P}_person_temp`, firstName: "Visitor", lastName: "Sample" } });
  await register(events.camporee, clubs.patch, [
    { ...attendedA, checkedIn: "yes" }, { ...attendedB, checkedIn: "yes" }, { ...undone, checkedIn: "undone" }, { ...noShow, checkedIn: "no" },
    { ...inactive, checkedIn: "yes" }, { personId: temporary.id, checkedIn: "yes" },
  ]);
  await register(events.camporee, clubs.other, [{ ...otherClubMember, checkedIn: "yes" }]);
  await register(events.noCheckIns, clubs.patch, [{ ...attendedA, checkedIn: "no" }, { ...noShow, checkedIn: "no" }]);
  await register(events.upcoming, clubs.patch, [{ ...attendedA, checkedIn: "no" }]);
  // Club B checked in at this ended event; club A (this suite's patch club) never used check-in.
  await register(events.mixed, clubs.patch, [{ ...attendedA, checkedIn: "no" }, { ...noShow, checkedIn: "no" }]);
  await register(events.mixed, clubs.other, [{ ...otherClubMember, checkedIn: "yes" }]);

  // Linking: staff, club events, catalog items in event sections only, audited once.
  await eventItems.linkEventAwardItem(events.camporee, items.camporee, staffUserId);
  await eventItems.linkEventAwardItem(events.camporee, items.camporee, staffUserId);
  assert(await prisma.eventAwardItem.count({ where: { eventId: events.camporee } }) === 1, "linking twice keeps one link");
  assert(await prisma.auditLog.count({ where: { action: "EVENT_AWARD_ITEM_LINKED", eventId: events.camporee } }) === 1, "linking is audited once, against the event");
  await expectCode(eventItems.linkEventAwardItem(events.general, items.camporee, staffUserId), "NOT_A_CLUB_EVENT", "a general event");
  await expectCode(eventItems.linkEventAwardItem(events.camporee, items.strip, staffUserId), "ITEM_NOT_ALLOWED", "an insignia item");
  await expectCode(eventItems.linkEventAwardItem(events.camporee, items.inactive, staffUserId), "ITEM_NOT_ALLOWED", "an inactive item");
  await expectCode(eventItems.linkEventAwardItem(`${P}_nope`, items.camporee, staffUserId), "EVENT_NOT_FOUND", "a missing event");
  await eventItems.linkEventAwardItem(events.camporee, items.camporeeNumbered, staffUserId);
  await eventItems.linkEventAwardItem(events.noCheckIns, items.camporee, staffUserId);
  await eventItems.linkEventAwardItem(events.upcoming, items.camporee, staffUserId);
  await eventItems.linkEventAwardItem(events.mixed, items.camporee, staffUserId);
  console.log("ok  linking a catalog item to a club event: club events and event-section items only, idempotent, audited");

  const patchNeedsBefore = await countNeeds(clubs.patch);
  const patchSuggestions = await awards.listPatchSuggestions(clubs.patch);
  const camporeeSuggestion = patchSuggestions.find((entry) => entry.eventId === events.camporee && entry.itemId === items.camporee)!;
  assert(camporeeSuggestion.basis === "CHECK_IN", "an event with check-ins uses check-in as attendance");
  assert(camporeeSuggestion.people.map((person) => person.personId).sort().join() === [attendedA.personId, attendedB.personId].sort().join(),
    `only the two checked-in active members are suggested (not the undone check-in, the no-show, the inactive member, the temporary attendee, or another club's), got ${JSON.stringify(camporeeSuggestion.people)}`);
  assert(camporeeSuggestion.catalogNumber === null, "a conference-made patch carries no AdventSource number");
  assert(await countNeeds(clubs.patch) === patchNeedsBefore, "suggesting patches adds nothing");
  const noCheckInSuggestion = patchSuggestions.find((entry) => entry.eventId === events.noCheckIns && entry.itemId === items.camporee)!;
  assert(noCheckInSuggestion.basis === "REGISTRATION" && noCheckInSuggestion.people.length === 2, "an ended event with no check-ins falls back to who was registered");
  // Attendance is decided per club: another club's check-ins at the same ended event don't switch this club's off.
  const mixedSuggestion = patchSuggestions.find((entry) => entry.eventId === events.mixed)!;
  assert(mixedSuggestion.basis === "REGISTRATION" && mixedSuggestion.people.length === 2, `club A never checked in, so after the event ends it falls back to its own registered members even though club B checked in, got ${JSON.stringify(mixedSuggestion)}`);
  const otherMixed = (await awards.listPatchSuggestions(clubs.other)).find((entry) => entry.eventId === events.mixed)!;
  assert(otherMixed.basis === "CHECK_IN" && otherMixed.people.map((person) => person.personId).join() === otherClubMember.personId, "club B, which did check in, uses its own check-ins");
  assert(!patchSuggestions.some((entry) => entry.eventId === events.upcoming), "an event still under way with no check-ins suggests nothing yet");
  assert(!patchSuggestions.some((entry) => entry.people.some((person) => person.personId === otherClubMember.personId)), "another club's attendee is never suggested here");
  // Non-attendees can't be confirmed, and nothing is added.
  await expectCode(awards.confirmEventPatches(clubs.patch, { eventId: events.camporee, itemId: items.camporee, personIds: [attendedA.personId, noShow.personId] }, actor), "NOT_SUGGESTED", "a member who did not attend");
  await expectCode(awards.confirmEventPatches(clubs.patch, { eventId: events.camporee, itemId: items.camporee, personIds: [undone.personId] }, actor), "NOT_SUGGESTED", "an undone check-in");
  await expectCode(awards.confirmEventPatches(clubs.patch, { eventId: events.camporee, itemId: items.goodConduct, personIds: [attendedA.personId] }, actor), "NOT_SUGGESTED", "an item not linked to the event");
  assert(await countNeeds(clubs.patch) === patchNeedsBefore, "a refused confirmation adds nothing");
  const patched = await awards.confirmEventPatches(clubs.patch, { eventId: events.camporee, itemId: items.camporee, personIds: [attendedA.personId, attendedB.personId] }, actor);
  assert(patched.created === 2 && patched.skipped === 0, `both attendees get the patch, got ${JSON.stringify(patched)}`);
  const patchNeeds = await prisma.clubOrderNeed.findMany({ where: { organizationId: clubs.patch }, select: { sourceType: true, sourceId: true, sourceLabel: true } });
  assert(patchNeeds.every((need) => need.sourceType === "AWARD" && need.sourceId.startsWith(`event:${events.camporee}:`) && need.sourceLabel === `Earn Check ${events.camporee}`), "keyed on event, member and item");
  assert(!(await awards.listPatchSuggestions(clubs.patch)).some((entry) => entry.eventId === events.camporee && entry.itemId === items.camporee), "a confirmed patch is no longer suggested");
  const numbered = (await awards.listPatchSuggestions(clubs.patch)).find((entry) => entry.eventId === events.camporee && entry.itemId === items.camporeeNumbered);
  assert(numbered?.people.length === 2 && numbered.catalogNumber === "090002", "the event's second linked item is suggested on its own");
  const patchAudit = await prisma.auditLog.findMany({ where: { action: "CLUB_EVENT_PATCHES_CONFIRMED", metadata: { path: ["organizationId"], equals: clubs.patch } }, select: { metadata: true, eventId: true } });
  assert(patchAudit.length === 1 && patchAudit[0].eventId === events.camporee && (patchAudit[0].metadata as { basis: string }).basis === "CHECK_IN" && !/Attended|Sample/.test(JSON.stringify(patchAudit)), "audited with the event, counts and basis; no names");
  // Unlinking stops suggestions but keeps what was added.
  await eventItems.unlinkEventAwardItem(events.camporee, items.camporeeNumbered, staffUserId);
  assert(!(await awards.listPatchSuggestions(clubs.patch)).some((entry) => entry.itemId === items.camporeeNumbered), "an unlinked item is no longer suggested");
  assert(await prisma.auditLog.count({ where: { action: "EVENT_AWARD_ITEM_UNLINKED", eventId: events.camporee } }) === 1, "unlinking is audited");
  console.log("ok  event patches: suggested for checked-in members only (registration fallback once an event with no check-ins is over), non-attendees refused, no-number patch kept and flagged");

  // ---------------------------------------------------------------- 3. Master Awards: stored multi-group rules, staff-only, audited
  const seedFile = JSON.stringify({
    "Earn Check Health Master Award": {
      groups: [
        { minimum: 3, honors: [honorNames[0], honorNames[1], honorNames[2], honorNames[3]] },
        { minimum: 2, honors: [honorNames[4], honorNames[5], honorNames[6]] },
        { minimum: 2, honors: [honorNames[7], honorNames[8], "Earn Check Honor Nobody Has"] },
      ],
      groupsRequired: 3,
    },
    "Earn Check Aquatic Master Award": {
      groups: [{ minimum: 2, honors: [honorNames[0], honorNames[5], honorNames[9]] }],
      groupsRequired: 1,
    },
    "Earn Check Family Master Award": {
      groups: [{ minimum: 2, honors: [honorNames[1], honorNames[2]] }],
      groupsRequired: 2,
    },
  });
  const seeds = importer.parseMasterAwardRulesFile(seedFile);
  const preview = await rules.previewMasterAwardRulesImport(seeds);
  assert(preview.plan.summary.added === 3 && preview.plan.summary.existing === 0, "the preview would add 3 rules");
  assert(preview.plan.unmatched.length === 1 && preview.plan.unmatched[0].honor === "Earn Check Honor Nobody Has", "the honor that matches nothing is listed");
  const flags = Object.fromEntries(preview.plan.steps.map((step) => [step.name, step.needsManualCheck]));
  assert(flags["Earn Check Health Master Award"] === true && flags["Earn Check Family Master Award"] === true && flags["Earn Check Aquatic Master Award"] === false, `unmatched honors and partly parsed rules are flagged, got ${JSON.stringify(flags)}`);
  assert(await prisma.masterAwardRule.count({ where: { normalizedName: { startsWith: ruleNamePrefix } } }) === 0, "the preview saves nothing");
  await expectCode(rules.applyMasterAwardRulesImport(seeds, "stale-fingerprint", staffUserId), "PREVIEW_CHANGED", "a stale fingerprint");
  const imported = await Promise.allSettled([
    rules.applyMasterAwardRulesImport(seeds, preview.fingerprint, staffUserId),
    rules.applyMasterAwardRulesImport(seeds, preview.fingerprint, staffUserId),
  ]);
  assert(imported.filter((result) => result.status === "fulfilled").length === 1 && imported.filter((result) => result.status === "rejected").length === 1, "a double import saves once; the other is refused as a changed preview");
  const stored = await prisma.masterAwardRule.findMany({ where: { normalizedName: { startsWith: ruleNamePrefix } }, select: { id: true, name: true, status: true, itemId: true, needsManualCheck: true, groups: { select: { minimum: true, unmatchedHonorNames: true, honors: { select: { honorId: true } } }, orderBy: { position: "asc" } } } });
  assert(stored.length === 3 && stored.every((rule) => rule.status === "DRAFT"), "imported rules arrive as DRAFT");
  const health = stored.find((rule) => rule.name === "Earn Check Health Master Award")!;
  const aquatic = stored.find((rule) => rule.name === "Earn Check Aquatic Master Award")!;
  const family = stored.find((rule) => rule.name === "Earn Check Family Master Award")!;
  assert(health.itemId === items.masterHealth && aquatic.itemId === null, "the rule is linked to its Master Awards catalog item by name");
  assert(health.groups.map((group) => group.honors.length).join() === "4,3,2" && health.groups[2].unmatchedHonorNames.join() === "Earn Check Honor Nobody Has", "groups, minimums, matched honors and the unmatched name are stored");
  const rerun = await rules.previewMasterAwardRulesImport(seeds);
  assert(rerun.plan.summary.added === 0 && rerun.plan.summary.existing === 3, "re-running the import adds nothing and leaves saved rules alone");
  assert(await prisma.auditLog.count({ where: { action: "MASTER_AWARD_RULES_IMPORTED", actorUserId: staffUserId } }) === 1, "the import is audited once");

  // Members and honors: 3 groups (3 of 4, 2 of 3, 2 of 3).
  const [eligible, close, oneShort, corrected] = [
    (await addMember(clubs.master, "Eligible")).personId, (await addMember(clubs.master, "Close")).personId,
    (await addMember(clubs.master, "OneShort")).personId, (await addMember(clubs.master, "Corrected")).personId,
  ];
  await completeHonors(eligible, clubs.master, [honorIds[0], honorIds[1], honorIds[2], honorIds[4], honorIds[5], honorIds[7], honorIds[8]]);
  await completeHonors(close, clubs.master, [honorIds[0], honorIds[1], honorIds[2], honorIds[4], honorIds[7]]);
  await completeHonors(oneShort, clubs.master, [honorIds[0], honorIds[1], honorIds[2], honorIds[3], honorIds[4], honorIds[5], honorIds[6], honorIds[7]]);
  await completeHonors(corrected, clubs.master, [honorIds[0], honorIds[1], honorIds[2], honorIds[4], honorIds[5], honorIds[7], honorIds[8]]);
  await completeHonors(corrected, clubs.master, [honorIds[8]], "IN_PROGRESS");
  assert((await awards.loadMasterAwardProgress(clubs.master)).length === 0, "DRAFT rules are not used for progress");

  // Staff edit: a flagged rule can't be activated until checked; audited; the flag is cleared on purpose.
  await expectCode(rules.updateMasterAwardRule(health.id, { status: "ACTIVE" }, staffUserId), "RULE_NOT_READY", "activating a rule flagged for a manual check");
  await expectCode(rules.updateMasterAwardRule(health.id, { needsManualCheck: false, status: "ACTIVE", groups: [{ minimum: 4, honorIds: [honorIds[0], honorIds[1]] }] }, staffUserId), "RULE_NOT_READY", "a minimum that can't be reached");
  await expectCode(rules.updateMasterAwardRule(health.id, { groups: [{ minimum: 1, honorIds: [`${P}_nope`] }] }, staffUserId), "HONOR_NOT_FOUND", "an unknown honor");
  await expectCode(rules.updateMasterAwardRule(`${P}_nope`, { reviewNote: "x" }, staffUserId), "RULE_NOT_FOUND", "an unknown rule");
  assert((await prisma.masterAwardRule.findUniqueOrThrow({ where: { id: health.id }, select: { status: true } })).status === "DRAFT", "a refused edit changes nothing");
  await rules.updateMasterAwardRule(health.id, {
    needsManualCheck: false, status: "ACTIVE", reviewNote: "Checked against the official requirements.",
    groups: [
      { minimum: 3, honorIds: [honorIds[0], honorIds[1], honorIds[2], honorIds[3]] },
      { minimum: 2, honorIds: [honorIds[4], honorIds[5], honorIds[6]] },
      { minimum: 2, honorIds: [honorIds[7], honorIds[8]] },
    ],
  }, staffUserId);
  await rules.updateMasterAwardRule(aquatic.id, { needsManualCheck: false, status: "ACTIVE" }, staffUserId);
  await rules.updateMasterAwardRule(family.id, { status: "INACTIVE" }, staffUserId);
  const ruleAudits = await prisma.auditLog.findMany({ where: { entityType: "MasterAwardRule", actorUserId: staffUserId, entityId: { not: null } }, select: { action: true, metadata: true, entityId: true } });
  const actions = ruleAudits.map((row) => row.action).sort().join();
  assert(actions === "MASTER_AWARD_RULE_ACTIVATED,MASTER_AWARD_RULE_ACTIVATED,MASTER_AWARD_RULE_DEACTIVATED", `every rule change is audited, got ${actions}`);
  assert(!/Earn Check Honor|Master Award/.test(JSON.stringify(ruleAudits.map((row) => row.metadata))), "the rule audit records fields and ids, never the honor lists");
  const healthAudit = ruleAudits.find((row) => row.entityId === health.id)!.metadata as { groupsBefore?: unknown; groupsAfter?: unknown };
  assert(JSON.stringify(healthAudit.groupsBefore) === JSON.stringify([{ minimum: 3, honorCount: 4 }, { minimum: 2, honorCount: 3 }, { minimum: 2, honorCount: 2 }])
    && JSON.stringify(healthAudit.groupsAfter) === JSON.stringify([{ minimum: 3, honorCount: 4 }, { minimum: 2, honorCount: 3 }, { minimum: 2, honorCount: 2 }]),
  `a group edit records each group's minimum and honor count before and after, got ${JSON.stringify(healthAudit)}`);
  // One honor in two groups would count twice: an active rule can't be saved that way.
  await expectCode(rules.updateMasterAwardRule(aquatic.id, { groups: [{ minimum: 1, honorIds: [honorIds[0]] }, { minimum: 1, honorIds: [honorIds[0], honorIds[1]] }] }, staffUserId), "RULE_NOT_READY", "an honor in two groups");
  assert((await prisma.masterAwardRuleGroup.count({ where: { ruleId: aquatic.id } })) === 1, "the refused overlapping edit changed nothing");
  assert((await prisma.masterAwardRuleGroup.findMany({ where: { ruleId: health.id }, select: { unmatchedHonorNames: true } })).every((group) => group.unmatchedHonorNames.length === 0), "editing the groups clears the reviewed unmatched names");

  const progress = await awards.loadMasterAwardProgress(clubs.master);
  const healthRow = progress.find((row) => row.name === "Earn Check Health Master Award")!;
  assert(progress.length === 2, "only ACTIVE rules show progress");
  assert(healthRow.requirement === "3 of 4 + 2 of 3 + 2 of 2", `the rule's requirement line, got ${healthRow.requirement}`);
  assert(healthRow.eligible.map((person) => person.personId).join() === eligible, "only the member who met every group is eligible (the one who fell one short and the corrected honor are not)");
  const closeness = Object.fromEntries(healthRow.closest.map((row) => [row.personId, row.label]));
  assert(closeness[close] === "5 of 7" && closeness[oneShort] === "6 of 7" && closeness[corrected] === "6 of 7", `progress reads "N of M" summed over the groups, got ${JSON.stringify(closeness)}`);
  assert(healthRow.closest[0].personId !== close, "the closest members come first");
  const aquaticRow = progress.find((row) => row.name === "Earn Check Aquatic Master Award")!;
  assert(aquaticRow.missingItem && aquaticRow.requirement === "2 of 3", "a single-group rule works too, and shows it has no catalog item yet");
  assert(aquaticRow.eligible.map((person) => person.personId).sort().join() === [eligible, oneShort, corrected].sort().join(), "any 2 of 3 makes exactly the members with 2 of those honors eligible");
  assert(await countNeeds(clubs.master) === 0, "eligibility adds nothing by itself");
  // Adding needs the director's confirmation, for eligible members only.
  await expectCode(awards.addMasterAwardNeeds(clubs.master, { ruleId: health.id, personIds: [eligible, close] }, actor), "NOT_ELIGIBLE", "a member who hasn't reached it");
  await expectCode(awards.addMasterAwardNeeds(clubs.master, { ruleId: aquatic.id, personIds: [eligible] }, actor), "RULE_HAS_NO_ITEM", "a rule with no catalog item");
  await expectCode(awards.addMasterAwardNeeds(clubs.master, { ruleId: family.id, personIds: [eligible] }, actor), "NOT_ELIGIBLE", "an inactive rule");
  assert(await countNeeds(clubs.master) === 0, "refused additions add nothing");
  const addResults = await Promise.all([
    awards.addMasterAwardNeeds(clubs.master, { ruleId: health.id, personIds: [eligible] }, actor),
    awards.addMasterAwardNeeds(clubs.master, { ruleId: health.id, personIds: [eligible] }, actor),
  ]);
  assert(addResults[0].created + addResults[1].created === 1 && await countNeeds(clubs.master, { sourceType: "AWARD", itemId: items.masterHealth }) === 1, "a double tap adds the Master Award once");
  const afterAdd = (await awards.loadMasterAwardProgress(clubs.master)).find((row) => row.name === "Earn Check Health Master Award")!;
  assert(afterAdd.eligible.length === 0 && afterAdd.onOrder.map((person) => person.personId).join() === eligible, "an added award moves from 'eligible, not yet awarded' to on order");
  const masterNeedId = (await prisma.clubOrderNeed.findFirstOrThrow({ where: { organizationId: clubs.master }, select: { id: true } })).id;
  await orders.markNeedsAlreadyAwarded(clubs.master, [masterNeedId], actor);
  const afterAwarded = (await awards.loadMasterAwardProgress(clubs.master)).find((row) => row.name === "Earn Check Health Master Award")!;
  assert(afterAwarded.awardedCount === 1 && afterAwarded.onOrder.length === 0 && afterAwarded.eligible.length === 0, "an awarded Master Award is counted awarded and no longer eligible");
  console.log("ok  Master Awards: rules stored as data, imported as drafts, staff edits audited, multi-group eligibility and 'N of M' from latest COMPLETED honors, added only on confirmation");

  // A transferred member: the need key is unique across clubs, so an award a previous club recorded isn't "eligible" here.
  const moved = (await addMember(clubs.master, "Moved")).personId;
  await completeHonors(moved, clubs.master, [honorIds[0], honorIds[1], honorIds[2], honorIds[4], honorIds[5], honorIds[7], honorIds[8]]);
  const beforeMove = (await awards.loadMasterAwardProgress(clubs.master)).find((row) => row.name === "Earn Check Health Master Award")!;
  assert(beforeMove.eligible.some((person) => person.personId === moved), "before any record, the member is eligible");
  await prisma.clubOrderNeed.create({ data: { organizationId: clubs.other, sourceType: "AWARD", sourceId: `master:${moved}:${health.id}`, personId: moved, itemId: items.masterHealth, sourceLabel: "Earn Check Health Master Award", status: "ORDERED" } });
  const afterMove = (await awards.loadMasterAwardProgress(clubs.master)).find((row) => row.name === "Earn Check Health Master Award")!;
  assert(!afterMove.eligible.some((person) => person.personId === moved) && afterMove.givenElsewhere.map((person) => person.personId).join() === moved, "a member whose award another club already recorded shows as already given, not eligible");
  const needsBeforeMove = await countNeeds(clubs.master);
  const movedAdd = await awards.addMasterAwardNeeds(clubs.master, { ruleId: health.id, personIds: [moved] }, actor);
  assert(movedAdd.created === 0 && movedAdd.skipped === 1 && await countNeeds(clubs.master) === needsBeforeMove, "adding it here skips the member and records nothing");

  // ---------------------------------------------------------------- 4. hand-picked items, "already has it"
  const gcMembers = await addMembers(clubs.main, 4);
  const gc = await awards.recordAwardNeeds(clubs.main, { personIds: gcMembers, itemIds: [items.goodConduct, items.tlt], alreadyHasIt: false }, actor);
  assert(gc.created === 8 && gc.skipped === 0, `4 members x Good Conduct and TLT = 8 needs, got ${JSON.stringify(gc)}`);
  const gcAudits = await prisma.auditLog.findMany({ where: { action: "CLUB_AWARD_NEEDS_RECORDED", metadata: { path: ["organizationId"], equals: clubs.main } }, select: { metadata: true } });
  assert(gcAudits.length === 1 && (gcAudits[0].metadata as { needCount: number }).needCount === 8 && !/Member\d|Sample/.test(JSON.stringify(gcAudits)), "audited with counts and item ids only");
  assert((await awards.recordAwardNeeds(clubs.main, { personIds: gcMembers, itemIds: [items.goodConduct], alreadyHasIt: false }, actor)).created === 0, "re-submitting never doubles anything");
  const mainBefore = await countNeeds(clubs.main);
  for (const [label, input, code] of [
    ["an honor patch", { personIds: [gcMembers[0]], itemIds: [items.honorPatch] }, "ITEM_NOT_ORDERABLE"],
    ["a uniform item", { personIds: [gcMembers[0]], itemIds: [items.scarf] }, "ITEM_NOT_ORDERABLE"],
    ["an inactive item", { personIds: [gcMembers[0]], itemIds: [items.inactive] }, "ITEM_NOT_ORDERABLE"],
    ["another club's member", { personIds: [gcMembers[0], outsider], itemIds: [items.goodConduct] }, "MEMBER_NOT_ON_ROSTER"],
  ] as const) {
    await expectCode(awards.recordAwardNeeds(clubs.main, { ...input, alreadyHasIt: false }, actor), code, label);
  }
  assert(await countNeeds(clubs.main) === mainBefore, "a refused entry records nothing at all");
  // "Already has it": awarded, no stock change, settles an existing NEEDED need.
  const stockBefore = await stockOf(clubs.main, items.goodConduct);
  const settled = await awards.recordAwardNeeds(clubs.main, { personIds: [gcMembers[0], friend3], itemIds: [items.goodConduct], alreadyHasIt: true }, actor);
  assert(settled.marked === 1 && settled.created === 1 && settled.alreadyHadIt === 2, `one existing need settled, one recorded as awarded, got ${JSON.stringify(settled)}`);
  assert(await countNeeds(clubs.main, { itemId: items.goodConduct, status: "AWARDED" }) === 2, "both are awarded");
  assert(await stockOf(clubs.main, items.goodConduct) === stockBefore, "'already has it' never touches stock");
  const laterId = (await prisma.clubOrderNeed.findFirstOrThrow({ where: { organizationId: clubs.main, personId: gcMembers[1], itemId: items.tlt }, select: { id: true } })).id;
  const marked = await orders.markNeedsAlreadyAwarded(clubs.main, [laterId], actor);
  assert(marked.marked === 1 && await stockOf(clubs.main, items.tlt) === 0, "the order layer's own 'already handed out' works on an earned item, stock untouched");
  // Removal touches only not-yet-ordered AWARD needs.
  const honorTouch = await addMember(clubs.main);
  await completeHonors(honorTouch.personId, clubs.main, [honorIds[9]]);
  await syncHonorOrderNeeds(clubs.main);
  await recordUniformNeeds(clubs.main, { personIds: [honorTouch.personId], itemIds: [items.scarf], alreadyHasOne: false }, actor);
  const allIds = (await prisma.clubOrderNeed.findMany({ where: { organizationId: clubs.main, personId: honorTouch.personId }, select: { id: true } })).map((need) => need.id);
  assert(allIds.length === 2, "one honor need and one uniform need for that member");
  assert((await awards.removeAwardNeeds(clubs.main, allIds, actor)).removed === 0, "removing earned items can never reach honor or uniform needs");
  const removable = (await prisma.clubOrderNeed.findMany({ where: { organizationId: clubs.main, itemId: items.tlt, status: "NEEDED" }, select: { id: true } })).map((need) => need.id);
  assert((await awards.removeAwardNeeds(clubs.main, [...removable, laterId], actor)).removed === removable.length && await countNeeds(clubs.main, { id: laterId }) === 1, "only NEEDED earned items are removed; an awarded one stays");
  assert(await prisma.auditLog.count({ where: { action: "CLUB_AWARD_NEEDS_REMOVED", metadata: { path: ["organizationId"], equals: clubs.main } } }) === 1, "the removal is audited once, by count");
  console.log("ok  hand-picked items (Good Conduct, TLT): bulk entry, refusals, 'already has it' awards with no stock change, removal only reaches NEEDED earned items");

  // ---------------------------------------------------------------- 5. one batch with honors, uniforms and earned awards
  const comboMembers = await addMembers(clubs.combo, 3);
  for (const personId of comboMembers.slice(0, 2)) await completeHonors(personId, clubs.combo, [honorIds[9]]);
  await syncHonorOrderNeeds(clubs.combo);
  await recordUniformNeeds(clubs.combo, { personIds: comboMembers, itemIds: [items.scarf], alreadyHasOne: false }, actor);
  await awards.recordAwardNeeds(clubs.combo, { personIds: comboMembers, itemIds: [items.goodConduct], alreadyHasIt: false }, actor);
  await awards.recordAwardNeeds(clubs.combo, { personIds: [comboMembers[0]], itemIds: [items.tlt], alreadyHasIt: false }, actor);
  await awards.recordClassCompletions(clubs.combo, { personIds: [comboMembers[1]], classLevel: "FRIEND", completedOn: "2026-06-06" }, actor);
  const comboCompletion = (await awards.listInsigniaSuggestions(clubs.combo))[0];
  await awards.confirmInsignia(clubs.combo, [{ completionId: comboCompletion.completionId, itemIds: [items.strip] }], actor);
  await syncHonorOrderNeeds(clubs.combo);
  assert(await countNeeds(clubs.combo, { sourceType: "AWARD" }) === 5 && await countNeeds(clubs.combo, { sourceType: "UNIFORM" }) === 3 && await countNeeds(clubs.combo, { sourceType: "HONOR" }) === 2,
    "honors, uniforms and earned awards each keep their own needs; a honor sync leaves the others alone");
  await prisma.clubSupplyStock.create({ data: { organizationId: clubs.combo, itemId: items.goodConduct, quantityOnHand: 1 } });
  const list = await orders.listOrderList(clubs.combo, new Map([[items.tlt, 2]]));
  const gcLine = list.lines.find((line) => line.item.itemId === items.goodConduct)!;
  const tltLine = list.lines.find((line) => line.item.itemId === items.tlt)!;
  assert(gcLine.needed === 3 && gcLine.inStock === 1 && gcLine.toOrder === 2, `Good Conduct: 3 needed - 1 in stock = 2, got ${JSON.stringify(gcLine)}`);
  assert(tltLine.needed === 1 && tltLine.extra === 2 && tltLine.toOrder === 3, `TLT: 1 needed + 2 extra = 3, got ${JSON.stringify(tltLine)}`);
  const screen = domain.applyExtras((await orders.listOrderList(clubs.combo)).lines, { [items.tlt]: "2" });
  assert(domain.readableOrderCsv(list.lines) === domain.readableOrderCsv(screen) && domain.adventSourceOrderCsv(list.lines) === domain.adventSourceOrderCsv(screen), "the pre-order exports equal the screen");
  const comboBatch = await orders.createOrderBatch(clubs.combo, { [items.tlt]: 2 }, actor);
  assert(await prisma.clubSupplyOrderBatch.count({ where: { organizationId: clubs.combo } }) === 1, "ONE batch");
  const batchItems = new Set(comboBatch.lines.map((line) => line.item.itemId));
  assert([items.honorPatch, items.scarf, items.goodConduct, items.tlt, items.strip].every((id) => batchItems.has(id)), "the one batch holds the honor patch, the scarf, and the earned items");
  const asMap = Object.fromEntries(parseCsvMatrix(domain.adventSourceOrderCsv((await orders.getOrderBatch(clubs.combo, comboBatch.batchId)).lines)).slice(1).map((row) => [row[0], row[1]]));
  assert(asMap["005157"] === "2" && asMap["020001"] === "3" && asMap["002304"] === "2" && asMap["004100"] === "3" && asMap["002140"] === "1", `one AdventSource file combines honors, uniforms and awards, got ${JSON.stringify(asMap)}`);
  // Awards keep every #487 invariant: available stock, lock-serialized math, exports.
  assert(await countNeeds(clubs.combo, { status: "NEEDED", itemId: items.goodConduct }) === 1, "the Good Conduct need stock covers stays NEEDED, ready from stock");
  const pick = await orders.listPickList(clubs.combo, comboBatch.batchId);
  for (const entry of pick) assert(Object.keys(entry).sort().join() === "firstName,itemName,lastName,size,status", `pick list entry keys, got ${Object.keys(entry).join()}`);
  assert(pick.some((entry) => entry.itemName === "Friend Class Name Strip") && pick.some((entry) => entry.itemName === "Earn Check TLT Pin"), "the pick list names the earned items, names only");
  const received = await orders.markOrderBatchReceived(clubs.combo, comboBatch.batchId, actor);
  assert(received.status === "RECEIVED" && await stockOf(clubs.combo, items.goodConduct) === 3 && await stockOf(clubs.combo, items.tlt) === 3, "receiving adds the ordered quantities to stock");
  const awardable = await orders.listAwardableNeeds(clubs.combo);
  assert(awardable.some((need) => need.itemId === items.tlt) && awardable.some((need) => need.itemId === items.goodConduct && need.fromStock), "earned items are ready to hand out, one straight from stock");
  const tltNeed = (await prisma.clubOrderNeed.findFirstOrThrow({ where: { organizationId: clubs.combo, itemId: items.tlt }, select: { id: true } })).id;
  const first1 = await Promise.all([orders.markNeedsAwarded(clubs.combo, [tltNeed], actor), orders.markNeedsAwarded(clubs.combo, [tltNeed], actor)]);
  assert(first1[0].awarded + first1[1].awarded === 1 && await stockOf(clubs.combo, items.tlt) === 2, "handing out twice counts once and takes one from stock");
  const gcNeeds = (await prisma.clubOrderNeed.findMany({ where: { organizationId: clubs.combo, itemId: items.goodConduct }, select: { id: true } })).map((need) => need.id);
  const gcAwarded = await orders.markNeedsAwarded(clubs.combo, gcNeeds, actor);
  assert(gcAwarded.awarded === 3 && await stockOf(clubs.combo, items.goodConduct) === 0, "three Good Conduct handed out take stock down to exactly zero, never below");
  console.log("ok  earned items join ONE batch with honors and uniforms: one AdventSource file, stock math, receive, hand out from stock and received, never below zero");

  // ---------------------------------------------------------------- 6. double submits
  const racers = await addMembers(clubs.race, 4);
  await awards.recordClassCompletions(clubs.race, { personIds: racers.slice(0, 2), classLevel: "FRIEND", completedOn: "2026-06-06" }, actor);
  const raceSuggestions = await awards.listInsigniaSuggestions(clubs.race);
  const confirmInput = raceSuggestions.map((entry) => ({ completionId: entry.completionId, itemIds: entry.items.map((item) => item.itemId) }));
  const dbl = await Promise.all([awards.confirmInsignia(clubs.race, confirmInput, actor), awards.confirmInsignia(clubs.race, confirmInput, actor)]);
  assert(dbl[0].created + dbl[1].created === 6 && dbl[0].skipped + dbl[1].skipped === 6 && await countNeeds(clubs.race, { sourceType: "AWARD" }) === 6, `a double-tapped confirmation adds 2 members x 3 items once, got ${JSON.stringify(dbl)}`);
  assert(await prisma.auditLog.count({ where: { action: "CLUB_CLASS_INSIGNIA_CONFIRMED", metadata: { path: ["organizationId"], equals: clubs.race } } }) === 1, "one audit row for the double-tapped confirmation");
  const dblEntry = await Promise.all([
    awards.recordAwardNeeds(clubs.race, { personIds: racers, itemIds: [items.goodConduct], alreadyHasIt: false }, actor),
    awards.recordAwardNeeds(clubs.race, { personIds: racers, itemIds: [items.goodConduct], alreadyHasIt: false }, actor),
  ]);
  assert(dblEntry[0].created + dblEntry[1].created === 4 && await countNeeds(clubs.race, { itemId: items.goodConduct }) === 4, "a double-tapped hand entry records 4 once");
  const dblClass = await Promise.all([
    awards.recordClassCompletions(clubs.race, { personIds: racers, classLevel: "COMPANION", completedOn: "2026-06-07" }, actor),
    awards.recordClassCompletions(clubs.race, { personIds: racers, classLevel: "COMPANION", completedOn: "2026-06-07" }, actor),
  ]);
  assert(dblClass[0].created + dblClass[1].created === 4, "a double-tapped class completion records 4 once");
  const placeResults = await Promise.allSettled([orders.createOrderBatch(clubs.race, {}, actor), orders.createOrderBatch(clubs.race, {}, actor)]);
  assert(placeResults.filter((result) => result.status === "fulfilled").length === 1 && placeResults.filter((result) => result.status === "rejected").length === 1, "a double Place order makes one batch");
  assert(await prisma.clubSupplyOrderBatch.count({ where: { organizationId: clubs.race } }) === 1, "exactly one batch");
  // The patch double tap.
  const patchDouble = await Promise.all([
    awards.confirmEventPatches(clubs.patch, { eventId: events.noCheckIns, itemId: items.camporee, personIds: [attendedA.personId, noShow.personId] }, actor),
    awards.confirmEventPatches(clubs.patch, { eventId: events.noCheckIns, itemId: items.camporee, personIds: [attendedA.personId, noShow.personId] }, actor),
  ]);
  assert(patchDouble[0].created + patchDouble[1].created === 2 && await countNeeds(clubs.patch, { sourceId: { startsWith: `event:${events.noCheckIns}:` } }) === 2, "a double-tapped patch confirmation adds each once");
  console.log("ok  double submits (confirm insignia, hand entry, class completion, Place order, event patch) each happen once");

  // ---------------------------------------------------------------- 7. view-only writes nothing; departed cleanup filtered by source
  const viewMembers = await addMembers(clubs.view, 2);
  await awards.recordAwardNeeds(clubs.view, { personIds: viewMembers, itemIds: [items.goodConduct], alreadyHasIt: false }, actor);
  await awards.recordClassCompletions(clubs.view, { personIds: viewMembers, classLevel: "FRIEND", completedOn: "2026-06-06" }, actor);
  const writesBefore = { needs: await prisma.clubOrderNeed.count(), audits: await prisma.auditLog.count(), completions: await prisma.memberClassCompletion.count(), batches: await prisma.clubSupplyOrderBatch.count() };
  const viewOnly = await awards.loadEarnedAwardsWorkspace(clubs.view, { forEditing: false });
  await orders.loadOrderWorkspace(clubs.view);
  const writesAfter = { needs: await prisma.clubOrderNeed.count(), audits: await prisma.auditLog.count(), completions: await prisma.memberClassCompletion.count(), batches: await prisma.clubSupplyOrderBatch.count() };
  assert(JSON.stringify(writesBefore) === JSON.stringify(writesAfter), "a view-only load writes nothing");
  assert(viewOnly.catalog.length === 0 && viewOnly.members.length === 0 && viewOnly.insignia.length === 0 && viewOnly.patches.length === 0 && viewOnly.needs.length === 2, "a view-only load gets the open items only: no picker, no member list, no suggestions");
  for (const row of viewOnly.needs) assert(Object.keys(row).sort().join() === "firstName,itemName,lastName,missingCatalogNumber,needId,origin,personId,status", `open item row carries names, item, origin and status only, got ${Object.keys(row).join()}`);
  // Another club's completion for the same person never shows in this club's member row.
  const strayCompletion = await prisma.memberClassCompletion.create({ data: { organizationId: clubs.other, personId: viewMembers[0], classLevel: "GUIDE", completedOn: "2026-07-07" } });
  const editing = await awards.loadEarnedAwardsWorkspace(clubs.view, { forEditing: true });
  assert(editing.members.length === 2 && editing.insignia.length === 2 && !editing.catalog.some((row) => [items.honorPatch, items.scarf, items.inactive].includes(row.itemId)), "an editor gets the roster, suggestions, and only active award-section items");
  for (const member of editing.members) {
    assert(Object.keys(member).sort().join() === "classLabel,completed,firstName,lastName,personId", `member row is names, current class and recorded class dates only, got ${Object.keys(member).join()}`);
    assert(JSON.stringify(member.completed) === JSON.stringify({ FRIEND: "2026-06-06" }), `the member's recorded Friend completion rides along for the class status column, got ${JSON.stringify(member.completed)}`);
  }
  assert(!JSON.stringify(editing.members).includes("2026-07-07") && editing.members.every((member) => !("GUIDE" in (member.completed ?? {}))), "another club's completion for the same person does not appear in completed");
  await prisma.memberClassCompletion.delete({ where: { id: strayCompletion.id } });
  assert(!JSON.stringify(editing).match(/birth|medical|allerg|insurance/i), "no birth date or medical field appears in the awards data");
  const otherView = await awards.loadEarnedAwardsWorkspace(clubs.other, { forEditing: true });
  // The only need under this club is the transferred member's Master Award recorded above; nothing from the other clubs leaks in.
  assert(otherView.needs.length === 1 && otherView.needs[0].origin === "Master Award" && otherView.insignia.length === 0, "another club sees only its own data");

  const stays = (await addMember(clubs.depart)).personId;
  const leaves = (await addMember(clubs.depart)).personId;
  await awards.recordAwardNeeds(clubs.depart, { personIds: [stays, leaves], itemIds: [items.goodConduct], alreadyHasIt: false }, actor);
  await recordUniformNeeds(clubs.depart, { personIds: [leaves], itemIds: [items.scarf], alreadyHasOne: false }, actor);
  await completeHonors(leaves, clubs.depart, [honorIds[9]]);
  await syncHonorOrderNeeds(clubs.depart);
  await prisma.clubRosterMember.updateMany({ where: { personId: leaves }, data: { status: "INACTIVE" } });
  await awards.loadEarnedAwardsWorkspace(clubs.depart, { forEditing: false });
  assert(await countNeeds(clubs.depart, { sourceType: "AWARD" }) === 2, "a view-only load removes nothing");
  await awards.loadEarnedAwardsWorkspace(clubs.depart, { forEditing: true });
  assert(await countNeeds(clubs.depart, { sourceType: "AWARD" }) === 1 && await countNeeds(clubs.depart, { sourceType: "AWARD", personId: stays }) === 1, "an editor's load removes a departed member's NEEDED earned item");
  assert(await countNeeds(clubs.depart, { sourceType: "HONOR", personId: leaves }) === 1, "a departed member's honor need is left to the honor source (it follows a transfer)");
  assert(await countNeeds(clubs.depart, { sourceType: "UNIFORM" }) === 0, "the uniform cleanup still works");
  const departAudits = await prisma.auditLog.findMany({ where: { action: { in: ["CLUB_AWARD_NEEDS_DEPARTED_REMOVED", "CLUB_UNIFORM_NEEDS_DEPARTED_REMOVED"] }, metadata: { path: ["organizationId"], equals: clubs.depart } }, select: { action: true, metadata: true } });
  assert(departAudits.length === 2 && departAudits.every((row) => (row.metadata as { needCount: number }).needCount === 1), "each source's cleanup is audited by count");
  console.log("ok  view-only writes nothing and sees names/items only; departed members' NEEDED earned and uniform items are removed by source type, honors untouched");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
