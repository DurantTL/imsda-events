/**
 * Honors Weekend class instructors (#833) through the real built app, by URL
 * and by API: an instructor's own class opens (page and JSON) with name and
 * club only, and planted contact, health, guardian and birth-date data never
 * appears in either; another instructor's class, an unknown class, and a
 * signed-in non-instructor all get the same 404 on the page and the API, for
 * reading and for marking; without a current Sterling Volunteers check the page
 * and API show the message and no names; a signed-out caller is refused; a
 * cross-origin post is refused; every staff route refuses a caller with no staff
 * session. Uses fictitious rows it creates and removes.
 *
 *   npm run test:honor-instructors-http   (against `npm run start`, like the other HTTP suites)
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase, assertLocalUrl } from "./support/local-only-guard";
import { matchableName } from "../modules/background-checks/domain";
import { ATTENDEE_SESSION_COOKIE_NAME, createAttendeeSession } from "../modules/attendee-accounts/session-store";

loadEnvConfig(process.cwd());
assertLocalDatabase(process.env, "run the honor instructor HTTP check");

const prisma = new PrismaClient();
const baseUrl = process.env.PUBLIC_REGISTRATION_TEST_URL ?? "http://localhost:3000";
assertLocalUrl(baseUrl, "PUBLIC_REGISTRATION_TEST_URL");
const key = randomUUID().replaceAll("-", "").slice(0, 10);
const P = `hinh_${key}`;
const DAY = 24 * 60 * 60 * 1000;
const secrets = [`planted-${key}@example.test`, "2011-03-04", `Guardian${key}`, `Allergy${key}`, `555-01${key.slice(0, 2)}-planted`];

async function main() {
  const startsAt = new Date(Date.now() - 3 * DAY);
  const endsAt = new Date(Date.now() - 2 * DAY);
  const eventId = `${P}_event`;
  const staff = await prisma.user.create({ data: { id: `${P}_staff`, email: `${P}-staff@example.test`, displayName: "HTTP Staff" } });
  await prisma.organization.create({ data: { id: `${P}_club`, type: "CLUB", name: `HTTP Club ${key}`, normalizedName: `http club ${key}` } });
  await prisma.honor.createMany({ data: ["a", "b"].map((id) => ({ id: `${P}_honor_${id}`, code: `${P}${id}`.toUpperCase(), name: `HTTP Honor ${id} ${key}`, normalizedName: `http honor ${id} ${key}` })) });
  await prisma.event.create({
    data: { id: eventId, slug: `${P}-slug`, name: "Instructor HTTP check", startsAt, endsAt, isPublished: true, registrationOpensOn: "2026-01-01", registrationClosesOn: "2026-02-01", billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB" },
  });
  const holder = await prisma.person.create({ data: { id: `${P}_holder`, firstName: "Holder", lastName: "Sample" } });
  const registration = await prisma.registration.create({ data: { eventId, accountHolderPersonId: holder.id, confirmationCode: `${P}`.toUpperCase().slice(0, 14), status: "SUBMITTED", totalAmount: 0 } });
  await prisma.clubEventRegistration.create({ data: { eventId, organizationId: `${P}_club`, registrationId: registration.id } });
  const session = await prisma.honorSession.create({ data: { eventId, name: "Sabbath afternoon", normalizedName: "sabbath afternoon" } });
  const offering = (honor: string) => prisma.honorOffering.create({ data: { eventId, honorId: `${P}_honor_${honor}`, sessionId: session.id, span: "SINGLE_SESSION", capacity: 10, location: "Room 1" }, select: { id: true } });
  const o1 = await offering("a");
  const o2 = await offering("b");
  let position = 0;
  const enroll = async (name: string, offeringId: string) => {
    const person = await prisma.person.create({ data: { id: `${P}_p_${name}`, firstName: `Kid${name}`, lastName: `Sample${key}`, phone: secrets[4] } });
    position += 1;
    const attendee = await prisma.registrationAttendee.create({
      data: {
        eventId, registrationId: registration.id, personId: person.id, attendeeType: "ATTENDEE", position,
        profileSnapshot: { firstName: person.firstName, lastName: person.lastName, email: secrets[0], birthDate: secrets[1], guardianName: secrets[2], phone: secrets[4] },
        formResponses: { medical_notes: secrets[3], guardian: secrets[2] },
      },
    });
    return prisma.honorEnrollment.create({
      data: { eventId, offeringId, registrationId: registration.id, registrationAttendeeId: attendee.id, organizationId: `${P}_club`, consumesSeat: true },
      select: { id: true },
    });
  };
  const e1 = await enroll("one", o1.id);
  await enroll("two", o1.id);
  const e2 = await enroll("three", o2.id);

  const account = (name: string) => prisma.attendeeAccount.create({ data: { id: `${P}_acct_${name}`, email: `${P}-${name}@example.test`, displayName: `Instructor ${name}`, status: "ACTIVE", emailVerifiedAt: new Date() }, select: { id: true, email: true } });
  const [a, b, nobody] = [await account("a"), await account("b"), await account("n")];
  const future = new Date(Date.now() + 200 * DAY).toISOString().slice(0, 10);
  await prisma.backgroundCheckUpload.create({ data: { id: `${P}_upload`, format: "STERLING", rowCount: 1, added: 1, changed: 0, dropped: 0, uploadedByUserId: staff.id } });
  const instructor = async (name: string, accountId: string, offeringId: string, first: string, last: string) => {
    const person = await prisma.person.create({ data: { id: `${P}_ip_${name}`, firstName: first, lastName: last, normalizedEmail: `${P}-${name}@example.test` } });
    const row = await prisma.honorInstructor.create({ data: { eventId, personId: person.id, email: `${P}-${name}@example.test`, name: `${first} ${last}`, attendeeAccountId: accountId, acceptedAt: new Date() } });
    await prisma.honorInstructorClass.create({ data: { instructorId: row.id, offeringId } });
  };
  await instructor("a", a.id, o1.id, "Ina", `Instructor${key}`);
  await instructor("b", b.id, o2.id, "Ben", `Teacher${key}`);
  // Only Ina has a current Sterling Volunteers check on the list.
  await prisma.backgroundCheckEntry.create({
    data: { uploadId: `${P}_upload`, line: 1, firstName: "Ina", lastName: `Instructor${key}`, normalizedName: matchableName(`Ina Instructor${key}`), email: a.email, identityKey: `${P}-key-1`, checkedOn: "2025-01-01", expiresOn: future },
  });

  const cookieFor = async (accountId: string) => `${ATTENDEE_SESSION_COOKIE_NAME}=${(await createAttendeeSession(accountId, null, { secondFactorVerifiedAt: new Date() })).token}`;
  const ina = await cookieFor(a.id);
  const ben = await cookieFor(b.id);
  const other = await cookieFor(nobody.id);
  const origin = new URL(baseUrl).origin;
  const call = (path: string, cookie: string | null, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, { redirect: "manual", cache: "no-store", ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.method === "POST" ? { origin, "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
  const api = (offeringId: string) => `/api/attendee/honor-instructor/classes/${offeringId}`;
  const page = (offeringId: string) => `/account/instructor/${offeringId}`;
  const noSecrets = (text: string, label: string) => {
    for (const secret of secrets) assert.ok(!text.includes(secret), `${label} contains planted data ${secret}`);
  };

  // Own class: API and page.
  const own = await call(api(o1.id), ina);
  assert.equal(own.status, 200, "Ina's own class API");
  assert.match(own.headers.get("cache-control") ?? "", /no-store/);
  const ownText = await own.text();
  noSecrets(ownText, "the roster API");
  const people = (JSON.parse(ownText) as { people: Array<Record<string, unknown>> }).people;
  assert.equal(people.length, 2, "two people in Ina's class");
  assert.deepEqual(Object.keys(people[0]!).sort(), ["attended", "clubName", "completed", "enrollmentId", "firstName", "lastName", "recorded", "recordedVoided"], "only the allowed fields");
  const ownPage = await call(page(o1.id), ina);
  assert.equal(ownPage.status, 200, "Ina's own class page");
  const ownHtml = await ownPage.text();
  assert.ok(ownHtml.includes("Kidone") && ownHtml.includes(`HTTP Club ${key}`), "the page shows names and the club");
  noSecrets(ownHtml, "the roster page (including its payload)");
  assert.ok(!ownHtml.includes(registration.id) && !ownHtml.includes(`${P}_p_one`), "no registration or person id on the page");

  // Everyone else's class, a missing class, a non-instructor: the same 404, by page and API, reading and marking.
  for (const [who, cookie, offeringId] of [["Ina on Ben's class", ina, o2.id], ["Ina on a missing class", ina, "nope"], ["a non-instructor", other, o1.id]] as const) {
    assert.equal((await call(api(offeringId), cookie)).status, 404, `${who}: roster API`);
    assert.equal((await call(page(offeringId), cookie)).status, 404, `${who}: roster page`);
    assert.equal((await call(`${api(offeringId)}/marks`, cookie, { method: "POST", body: JSON.stringify({ action: "ALL_COMPLETED" }) })).status, 404, `${who}: marks API`);
  }
  assert.equal(await prisma.honorEnrollment.count({ where: { eventId, instructorMark: { isNot: null } } }), 0, "no refused call marked anyone");
  assert.equal((await call(`${api(o1.id)}/marks`, ina, { method: "POST", body: JSON.stringify({ action: "SET", enrollmentId: e2.id, completed: true }) })).status, 404, "a person from another class by id");
  assert.equal(await prisma.honorEnrollmentMark.count({ where: { enrollmentId: e2.id } }), 0, "and nothing was marked");

  // Marks work for the owner; cross-origin and bad bodies are refused.
  const marked = await call(`${api(o1.id)}/marks`, ina, { method: "POST", body: JSON.stringify({ action: "SET", enrollmentId: e1.id, attended: true }) });
  assert.equal(marked.status, 200, "Ina marks her own class");
  noSecrets(await marked.text(), "the marks response");
  assert.equal((await call(`${api(o1.id)}/marks`, ina, { method: "POST", body: JSON.stringify({ action: "CLEAR" }), headers: { origin: "https://evil.example" } })).status, 403, "a cross-origin post");
  assert.equal((await call(`${api(o1.id)}/marks`, ina, { method: "POST", body: JSON.stringify({ action: "CLEAR", accountId: b.id }) })).status, 400, "an extra field");
  assert.equal((await call(`${api(o1.id)}/marks`, ina)).status, 405, "no marking by GET");
  assert.equal(await prisma.honorEnrollmentMark.count({ where: { enrollmentId: e1.id, attended: true, completed: false } }), 1, "only the one valid mark landed");

  // No current Sterling Volunteers check: the message, never a name.
  const blocked = await call(api(o2.id), ben);
  assert.equal(blocked.status, 403, "Ben has no current check");
  const blockedText = await blocked.text();
  assert.ok(blockedText.includes("Sterling Volunteers check") && !blockedText.includes("Kidthree"), "the API shows the message and no name");
  const blockedPage = await (await call(page(o2.id), ben)).text();
  assert.ok(blockedPage.includes("Sterling Volunteers check") && !blockedPage.includes("Kidthree"), "the page shows the message and no name");
  assert.equal((await call(`${api(o2.id)}/marks`, ben, { method: "POST", body: JSON.stringify({ action: "ALL_ATTENDED" }) })).status, 403, "and marking is refused");

  // Signed out, and staff routes with no staff session.
  assert.equal((await call(api(o1.id), null)).status, 401, "signed-out API");
  const signedOutPage = await call(page(o1.id), null);
  assert.ok([302, 303, 307, 308].includes(signedOutPage.status), `signed-out page redirects, got ${signedOutPage.status}`);
  assert.equal((await call(`${api(o1.id)}/marks`, null, { method: "POST", body: JSON.stringify({ action: "CLEAR" }) })).status, 401, "signed-out marks");
  const staffBase = `/api/events/${eventId}/honors/instructors`;
  for (const [label, path, init] of [
    ["list", staffBase, {}],
    ["invite", staffBase, { method: "POST", body: JSON.stringify({ firstName: "X", lastName: "Y", email: "x@example.test", offeringIds: [o1.id] }) }],
    ["classes", `${staffBase}/x`, { method: "PATCH", body: JSON.stringify({ offeringIds: [o1.id] }) }],
    ["remove", `${staffBase}/x`, { method: "DELETE" }],
    ["resend", `${staffBase}/x/resend`, { method: "POST", body: "{}" }],
  ] as const) {
    for (const [who, cookie] of [["signed out", null], ["an instructor's attendee session", ina]] as const) {
      const init2 = { ...init, headers: "method" in init ? { origin, "content-type": "application/json" } : {} } as RequestInit;
      const response = await call(path, cookie, init2);
      assert.ok([401, 403].includes(response.status), `staff ${label} for ${who} is refused, got ${response.status}`);
    }
  }
  assert.equal(await prisma.honorInstructor.count({ where: { eventId } }), 2, "no refused staff call changed the instructors");
  console.log("Honors Weekend instructor HTTP checks passed.");
}

async function cleanup() {
  const enrollments = await prisma.honorEnrollment.findMany({ where: { eventId: { startsWith: P } }, select: { id: true } });
  await prisma.honorWeekendCompletionLink.deleteMany({ where: { enrollmentId: { in: enrollments.map((row) => row.id) } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { startsWith: P } }, { actorUserId: { startsWith: P } }] } });
  await prisma.honorEnrollment.deleteMany({ where: { eventId: { startsWith: P } } });
  await prisma.registrationAttendee.deleteMany({ where: { eventId: { startsWith: P } } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId: { startsWith: P } } });
  await prisma.registration.deleteMany({ where: { eventId: { startsWith: P } } });
  await prisma.honorInstructor.deleteMany({ where: { eventId: { startsWith: P } } });
  await prisma.honorOffering.deleteMany({ where: { eventId: { startsWith: P } } });
  await prisma.honorSession.deleteMany({ where: { eventId: { startsWith: P } } });
  await prisma.event.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.backgroundCheckUpload.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.memberHonorEntry.deleteMany({ where: { organizationId: { startsWith: P } } });
  await prisma.honor.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.attendeeSession.deleteMany({ where: { accountId: { startsWith: P } } });
  await prisma.attendeeAccount.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.organization.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
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
