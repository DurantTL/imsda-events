/**
 * Lodging assignment (#200) through the real built app: the private registration page shows a published room (and a
 * roommate by first name only, never a surname, email, phone or confirmation code), shows nothing before staff publish,
 * the registrant waitlist route works only through a valid private link, from the same origin, and cannot offer or
 * promote, and every staff route and page refuses a signed-out caller. Uses fictitious rows it creates and removes.
 *
 *   npm run test:lodging-assignment-http   (against `npm run start`, like the other public HTTP suites)
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase, assertLocalUrl } from "./support/local-only-guard";
import { createOpaqueToken, hashOpaqueToken } from "../modules/access/tokens";
import { applyAssignmentAction, updateAssignmentSettings } from "../modules/lodging/assignment-service";
import { selectEventProperty } from "../modules/lodging/service";

loadEnvConfig(process.cwd());
// Local-only: this suite writes fictitious rows and calls a local app.
assertLocalDatabase(process.env, "run the lodging assignment HTTP check");

const prisma = new PrismaClient();
const baseUrl = process.env.PUBLIC_REGISTRATION_TEST_URL ?? "http://localhost:3000";
assertLocalUrl(baseUrl, "PUBLIC_REGISTRATION_TEST_URL");
const key = randomUUID().replaceAll("-", "").slice(0, 10);
const eventId = `lodghttp_${key}`;
const userId = `lodghttp_user_${key}`;

async function main() {
  await prisma.user.create({ data: { id: userId, email: `${key}@lodging.example.test`, displayName: "Lodging HTTP verifier" } });
  await prisma.event.create({
    data: { id: eventId, slug: `lodghttp-${key}`, name: "Lodging assignment HTTP check", startsAt: new Date("2027-06-15T15:00:00Z"), endsAt: new Date("2027-06-19T15:00:00Z"), timezone: "America/Chicago", isPublished: true },
  });
  await selectEventProperty(eventId, userId, { propertyKey: "sunnydale-academy" }, prisma);
  const make = async (tag: string, age: number) => {
    const person = await prisma.person.create({ data: { firstName: `Tag${tag}`, lastName: `Surname${tag}${key}`, normalizedEmail: `${tag}.${key}@lodging.example.test`, phone: tag === "a" ? "555-0198" : "555-0197" } });
    const registration = await prisma.registration.create({ data: { eventId, accountHolderPersonId: person.id, confirmationCode: `AD-${tag}${key}`.toUpperCase(), status: "CONFIRMED", totalAmount: 0, submittedAt: new Date() } });
    const attendee = await prisma.registrationAttendee.create({ data: { eventId, registrationId: registration.id, personId: person.id, attendeeType: "adult", position: 0, profileSnapshot: { firstName: person.firstName, lastName: person.lastName }, formResponses: { attendee_age: age } } });
    const token = createOpaqueToken();
    await prisma.registrationAccessToken.create({ data: { registrationId: registration.id, tokenHash: hashOpaqueToken(token), expiresAt: new Date(Date.now() + 86_400_000) } });
    return { person, registration, attendee, token };
  };
  const a = await make("a", 40);
  const b = await make("b", 35);
  const room = await prisma.eventLodgingUnit.findFirstOrThrow({ where: { eventId, unit: { key: "girls-224" } } });
  await prisma.eventLodgingUnit.update({ where: { id: room.id }, data: { capacityOverride: 2 } });
  for (const who of [a, b]) {
    await applyAssignmentAction(eventId, userId, { action: "place", placements: [{ occupant: { kind: "ATTENDEE", id: who.attendee.id }, place: { kind: "UNIT", eventUnitId: room.id }, firstNight: "2027-06-15", lastNight: "2027-06-18" }] }, prisma);
  }

  // Not published: the private page shows no room.
  let html = await (await fetch(`${baseUrl}/manage/${a.token}`, { cache: "no-store" })).text();
  assert.ok(!html.includes("Girls Dorm"), "nothing shown before publishing");
  await updateAssignmentSettings(eventId, userId, { showAssignmentsToAttendees: true, showRoommateFirstNames: true, attendeeInstructions: "Check in at the office." }, prisma);
  const response = await fetch(`${baseUrl}/manage/${a.token}`, { cache: "no-store" });
  assert.equal(response.status, 200);
  html = await response.text();
  assert.ok(html.includes("Girls Dorm") && html.includes("224") && html.includes("Check in at the office."), "the published room is on the private page");
  assert.ok(html.includes(b.person.firstName), "the roommate's first name is shown");
  for (const [label, value] of [["last name", b.person.lastName], ["email", b.person.normalizedEmail!], ["phone", "555-0197"], ["code", b.registration.confirmationCode]] as const) {
    const at = html.indexOf(value);
    assert.ok(at === -1, `${label} of the roommate is on the page: ...${html.slice(Math.max(0, at - 120), at + 80)}...`);
  }
  assert.ok(!html.includes("__IMSDA_PRIVATE"), "no sentinel leaks");

  // The waitlist routes: a private link only, same origin only.
  const view = await fetch(`${baseUrl}/api/public/manage/${a.token}/lodging/waitlist`, { cache: "no-store" });
  assert.equal(view.status, 200);
  assert.match(view.headers.get("cache-control") ?? "", /no-store/);
  const bad = await fetch(`${baseUrl}/api/public/manage/${"x".repeat(43)}/lodging/waitlist`, { cache: "no-store" });
  assert.equal(bad.status, 404);
  const accept = await fetch(`${baseUrl}/api/public/manage/${a.token}/lodging/waitlist`, { method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ action: "accept" }) });
  assert.equal(accept.status, 404);
  assert.equal((await accept.json()).error, "WAITLIST_ENTRY_NOT_FOUND");
  const foreign = await fetch(`${baseUrl}/api/public/manage/${a.token}/lodging/waitlist`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ action: "accept" }) });
  assert.ok(foreign.status === 403 || foreign.status === 400, `a cross-origin post is refused (${foreign.status})`);
  const staffOnly = await fetch(`${baseUrl}/api/public/manage/${a.token}/lodging/waitlist`, { method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ action: "offer", entryIds: ["x"] }) });
  assert.equal(staffOnly.status, 400, "a registrant cannot offer or promote");

  // Staff routes need a signed-in staff member.
  for (const [method, path] of [["GET", `/api/events/${eventId}/lodging/assignments`], ["GET", `/api/events/${eventId}/lodging/assignments/reports`], ["GET", `/api/events/${eventId}/exports/lodging-assignments?report=assignments`]] as const) {
    const refused = await fetch(`${baseUrl}${path}`, { method, cache: "no-store", redirect: "manual" });
    assert.ok([401, 403, 307, 302].includes(refused.status), `${path} refuses a signed-out caller (${refused.status})`);
  }
  const post = await fetch(`${baseUrl}/api/events/${eventId}/lodging/assignments`, { method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ action: "release_inactive", reason: "x" }), redirect: "manual" });
  assert.ok([401, 403, 307, 302].includes(post.status), `a signed-out assignment action is refused (${post.status})`);
  const page = await fetch(`${baseUrl}/more/lodging/assignments?event=${eventId}`, { cache: "no-store", redirect: "manual" });
  assert.ok([307, 302, 401, 403].includes(page.status), `the staff page redirects a signed-out visitor (${page.status})`);
  console.log("Lodging assignment HTTP checks passed.");
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    await prisma.$transaction([
      prisma.$executeRaw`SELECT set_config('imsda.event_deletion', 'on', true)`,
      prisma.eventLodgingAssignmentNotice.deleteMany({ where: { eventId } }),
      prisma.eventLodgingAssignmentHistory.deleteMany({ where: { eventId } }),
      prisma.eventLodgingAssignment.deleteMany({ where: { eventId } }),
    ]);
    await prisma.event.deleteMany({ where: { id: eventId } });
    await prisma.person.deleteMany({ where: { lastName: { contains: key } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: userId }, { eventId }] } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });
