/**
 * Check-in desk with 2-4 devices on ONE staff account (#825), through the real
 * built app. One staff user signs in from four separate cookie jars (each with
 * its own user agent and network address, and one address change mid-session),
 * through the full password + second-step flow, then all four scan at the same
 * time. Nothing may answer 401, 403, 429 or 500; every attendee ends with
 * exactly one check-in; a second device gets "already checked in ... by <name>";
 * a re-sent scan is idempotent; check-in racing undo is consistent; the
 * other devices' lists see the change through the small live-poll route; and
 * every one of the four sessions is still valid at the end.
 *
 *   npm run test:check-in-multi-device-http   (against `npm run start`, like the other HTTP suites)
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase, assertLocalUrl } from "./support/local-only-guard";
import { hashPassword } from "../modules/access/passwords";
import { totpCode } from "../modules/access/totp";
import { createOpaqueToken, hashOpaqueToken } from "../modules/access/tokens";

loadEnvConfig(process.cwd());
assertLocalDatabase(process.env, "run the multi-device check-in HTTP check");

const prisma = new PrismaClient();
const baseUrl = process.env.PUBLIC_REGISTRATION_TEST_URL ?? "http://localhost:3000";
assertLocalUrl(baseUrl, "PUBLIC_REGISTRATION_TEST_URL");
const key = randomUUID().replaceAll("-", "").slice(0, 10);
const eventId = `cinhttp_${key}`;
const userId = `cinhttp_user_${key}`;
const email = `desk.${key}@checkin.example.test`;
const password = `synthetic-desk-passphrase-${key}`;
const displayName = "Desk Account";
const forbidden = new Set([401, 403, 429, 500]);

type Device = { name: string; cookie: string; agent: string; address: string };
const devices: Device[] = ["phone-one", "phone-two", "phone-three", "tablet"].map((name, index) => ({
  name,
  cookie: "",
  agent: `Synthetic-${name}/1.0 (jar ${index})`,
  address: `203.0.113.${10 + index}`,
}));
const statuses: number[] = [];

async function call(device: Device, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    cache: "no-store",
    redirect: "manual",
    headers: {
      origin: baseUrl,
      "user-agent": device.agent,
      "x-forwarded-for": device.address,
      ...(device.cookie ? { cookie: device.cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  statuses.push(response.status);
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a non-JSON answer (an image) */ }
  return { response, status: response.status, json, text };
}

function sessionCookie(response: Response) {
  const cookie = response.headers.getSetCookie().find((line) => line.startsWith("imsda_session="));
  assert.ok(cookie, "a session cookie was set");
  return cookie.split(";")[0];
}

async function signIn(device: Device, secondStep: (challengeToken: string, gate: string) => Promise<Record<string, unknown>>) {
  const login = await call(device, "POST", "/api/auth/login", { email, password });
  assert.equal(login.status, 200, `${device.name} password step: ${login.text}`);
  const mfa = login.json?.mfa as { challengeToken: string; gate: string } | undefined;
  assert.ok(mfa?.challengeToken, `${device.name} is asked for the second step`);
  const verify = await secondStep(mfa.challengeToken, mfa.gate);
  assert.equal(verify.ok, true, `${device.name} second step: ${JSON.stringify(verify)}`);
}

async function main() {
  await prisma.user.create({ data: { id: userId, email, displayName, accountStatus: "ACTIVE", activatedAt: new Date() } });
  await prisma.authCredential.create({ data: { userId, passwordHash: await hashPassword(password) } });
  await prisma.event.create({
    data: { id: eventId, slug: `cinhttp-${key}`, name: "Multi-device check-in HTTP check", startsAt: new Date("2027-06-15T15:00:00Z"), endsAt: new Date("2027-06-19T15:00:00Z"), timezone: "America/Chicago", isPublished: true },
  });
  await prisma.eventMembership.create({ data: { eventId, userId, role: "CHECK_IN_STAFF", status: "ACTIVE" } });

  // Registrations of four attendees each: every device will scan every one of them.
  const registrations: Array<{ code: string; attendeeIds: string[]; token: string }> = [];
  for (let r = 0; r < 6; r += 1) {
    const holder = await prisma.person.create({ data: { firstName: `Reg${r}`, lastName: `Http${key}`, normalizedEmail: `r${r}.${key}@checkin.example.test` } });
    const code = `CH-${r}${key}`.toUpperCase();
    const registration = await prisma.registration.create({ data: { eventId, accountHolderPersonId: holder.id, confirmationCode: code, status: "CONFIRMED", totalAmount: 0, submittedAt: new Date() } });
    const attendeeIds: string[] = [];
    for (let a = 0; a < 4; a += 1) {
      const person = a === 0 ? holder : await prisma.person.create({ data: { firstName: `Reg${r}m${a}`, lastName: `Http${key}`, normalizedEmail: `r${r}m${a}.${key}@checkin.example.test` } });
      const attendee = await prisma.registrationAttendee.create({ data: { eventId, registrationId: registration.id, personId: person.id, attendeeType: "adult", position: a, profileSnapshot: { firstName: person.firstName, lastName: person.lastName }, formResponses: {} } });
      attendeeIds.push(attendee.id);
    }
    const token = createOpaqueToken();
    await prisma.registrationAccessToken.create({ data: { registrationId: registration.id, tokenHash: hashOpaqueToken(token), expiresAt: new Date(Date.now() + 86_400_000) } });
    registrations.push({ code, attendeeIds, token });
  }
  const startedAt = new Date(Date.now() - 1_000).toISOString();

  // 1. Sign in from four separate jars. The first enrols the authenticator; the
  //    other three sign in at the same moment with recovery codes (a 6-digit code
  //    can only be spent once, so a desk's second, third and fourth phone use
  //    recovery codes or wait for the next code). Their password steps overlap, so
  //    one device's sign-in must not retire another's second-step challenge.
  let secret = "";
  let recoveryCodes: string[] = [];
  await signIn(devices[0], async (challengeToken) => {
    const offer = await call(devices[0], "POST", "/api/auth/mfa/challenge", { challengeToken, action: "begin-enrollment" });
    secret = String(offer.json?.secret);
    const done = await call(devices[0], "POST", "/api/auth/mfa/challenge", { challengeToken, action: "verify", code: totpCode(secret, new Date()) });
    devices[0].cookie = sessionCookie(done.response);
    recoveryCodes = (done.json?.recoveryCodes as string[]) ?? [];
    return done.json ?? {};
  });
  assert.ok(recoveryCodes.length >= 3, "recovery codes were issued");
  const passwordSteps = await Promise.all(devices.slice(1).map((device) => call(device, "POST", "/api/auth/login", { email, password })));
  for (const [index, step] of passwordSteps.entries()) {
    assert.equal(step.status, 200, `${devices[index + 1].name} password step: ${step.text}`);
  }
  const secondSteps = await Promise.all(devices.slice(1).map((device, index) => {
    const challengeToken = (passwordSteps[index].json?.mfa as { challengeToken: string }).challengeToken;
    return call(device, "POST", "/api/auth/mfa/challenge", { challengeToken, action: "verify", code: recoveryCodes[index] });
  }));
  for (const [index, step] of secondSteps.entries()) {
    assert.equal(step.status, 200, `${devices[index + 1].name} second step survived the other sign-ins: ${step.text}`);
    devices[index + 1].cookie = sessionCookie(step.response);
  }
  assert.equal(new Set(devices.map((device) => device.cookie)).size, 4, "four distinct sessions");

  // 2. All four sessions are valid at once, and the account lists them.
  for (const device of devices) {
    const mine = await call(device, "GET", "/api/auth/sessions");
    assert.equal(mine.status, 200, `${device.name} session is valid`);
    assert.ok(((mine.json?.sessions as unknown[]) ?? []).length >= 4, "the account shows all four devices");
  }

  // 3. Everyone scans everyone at the same time, in different orders.
  const scanRound = async (registration: (typeof registrations)[number]) => Promise.all(devices.map(async (device, index) => {
    const resolved = await call(device, "POST", `/api/events/${eventId}/attendee-passes/resolve`, { kind: "confirmation", value: registration.code });
    assert.equal(resolved.status, 200, `${device.name} lookup: ${resolved.text}`);
    const order = index % 2 === 0 ? registration.attendeeIds : [...registration.attendeeIds].reverse();
    const results = await Promise.all(order.map((attendeeId) => call(device, "POST", `/api/events/${eventId}/attendees/${attendeeId}/check-in`, { idempotencyKey: randomUUID() })));
    return results;
  }));
  const rounds = await Promise.all(registrations.slice(0, 4).map(scanRound));
  const created = new Map<string, number>();
  for (const round of rounds.flat(2)) {
    assert.ok(!forbidden.has(round.status), `a scan answered ${round.status}: ${round.text}`);
    assert.equal(round.status, 200);
    const checkIn = round.json?.checkIn as { registrationAttendeeId: string };
    assert.equal(round.json?.checkedIn, true);
    if (round.json?.disposition === "CREATED") created.set(checkIn.registrationAttendeeId, (created.get(checkIn.registrationAttendeeId) ?? 0) + 1);
    if (round.json?.disposition === "ALREADY_CHECKED_IN") assert.equal(round.json?.checkedInBy, displayName, "the second device is told who checked them in");
  }
  for (const registration of registrations.slice(0, 4)) {
    for (const attendeeId of registration.attendeeIds) {
      assert.equal(created.get(attendeeId), 1, "exactly one device created each check-in");
      assert.equal(await prisma.checkIn.count({ where: { eventId, registrationAttendeeId: attendeeId } }), 1, "one check-in row");
      assert.equal(await prisma.checkIn.count({ where: { eventId, registrationAttendeeId: attendeeId, undoneAt: null } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { eventId, entityId: attendeeId, action: "ATTENDEE_CHECKED_IN" } }), 1, "one audit entry");
    }
  }

  // 4. A phone's address changes mid-session (cell handoff): still signed in, scans still work.
  devices[1].address = "198.51.100.77";
  devices[1].agent = `${devices[1].agent} (after a network change)`;
  const handoff = await call(devices[1], "POST", `/api/events/${eventId}/attendees/${registrations[4].attendeeIds[0]}/check-in`, { idempotencyKey: randomUUID() });
  assert.equal(handoff.status, 200, `a scan after an address change: ${handoff.text}`);
  assert.equal(handoff.json?.disposition, "CREATED");

  // 5. A timed-out scan re-sent with the same key, from two devices at once: one record, no error.
  const resentKey = randomUUID();
  const resent = await Promise.all([devices[0], devices[2], devices[0], devices[3]].map((device) => call(device, "POST", `/api/events/${eventId}/attendees/${registrations[4].attendeeIds[1]}/check-in`, { idempotencyKey: resentKey })));
  assert.ok(resent.every((answer) => answer.status === 200), `re-sent scans: ${resent.map((answer) => answer.text).join(" | ")}`);
  assert.equal(resent.filter((answer) => answer.json?.disposition === "CREATED").length, 1);
  assert.equal(await prisma.checkIn.count({ where: { eventId, registrationAttendeeId: registrations[4].attendeeIds[1] } }), 1);

  // 6. Check-in racing undo, over several attendees.
  const racing = registrations[5].attendeeIds;
  await Promise.all(racing.map((attendeeId) => call(devices[0], "POST", `/api/events/${eventId}/attendees/${attendeeId}/check-in`, { idempotencyKey: randomUUID() })));
  const raced = await Promise.all(racing.flatMap((attendeeId, index) => [
    call(devices[1], "DELETE", `/api/events/${eventId}/attendees/${attendeeId}/check-in`),
    call(devices[2], "POST", `/api/events/${eventId}/attendees/${attendeeId}/check-in`, { idempotencyKey: randomUUID() }),
    call(devices[3], "DELETE", `/api/events/${eventId}/attendees/${attendeeId}/check-in`),
    ...(index % 2 === 0 ? [call(devices[0], "POST", `/api/events/${eventId}/attendees/${attendeeId}/check-in`, { idempotencyKey: randomUUID() })] : []),
  ]));
  for (const answer of raced) {
    assert.ok(answer.status === 200 || answer.status === 404, `a racing undo or check-in answered ${answer.status}: ${answer.text}`);
    if (answer.status === 404) assert.equal(answer.json?.error, "ACTIVE_CHECK_IN_NOT_FOUND");
  }
  for (const attendeeId of racing) {
    const active = await prisma.checkIn.count({ where: { eventId, registrationAttendeeId: attendeeId, undoneAt: null } });
    const rows = await prisma.checkIn.count({ where: { eventId, registrationAttendeeId: attendeeId } });
    const ins = await prisma.auditLog.count({ where: { eventId, entityId: attendeeId, action: "ATTENDEE_CHECKED_IN" } });
    const outs = await prisma.auditLog.count({ where: { eventId, entityId: attendeeId, action: "ATTENDEE_CHECK_IN_UNDONE" } });
    assert.ok(active <= 1, "never two active rows");
    assert.equal(rows, ins, "one audit entry per check-in row");
    assert.equal(active, ins - outs, "audit entries add up to the final state");
  }

  // 7. Other devices' lists see it through the small live poll.
  const live = await call(devices[3], "GET", `/api/events/${eventId}/check-ins?since=${encodeURIComponent(startedAt)}`);
  assert.equal(live.status, 200);
  const changes = new Map((live.json?.changes as Array<[string, string | null]>).map(([id, at]) => [id, at]));
  for (const attendeeId of registrations[0].attendeeIds) assert.ok(changes.get(attendeeId), "the live poll shows other devices' check-ins");
  assert.ok(live.text.length < 10_000, `the live answer is small (${live.text.length} bytes)`);
  const quiet = await call(devices[3], "GET", `/api/events/${eventId}/check-ins?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`);
  assert.deepEqual(quiet.json?.changes, []);
  assert.ok(quiet.text.length < 100, "a quiet poll is a few dozen bytes");
  assert.equal((await call(devices[3], "GET", `/api/events/${eventId}/check-ins`)).status, 400, "since is required");

  // 8. Staff pass images and the live page, from all four, and attendees opening their own pass behind one shared address.
  await Promise.all(devices.map(async (device) => {
    const image = await call(device, "GET", `/api/events/${eventId}/attendee-passes/${registrations[0].attendeeIds[0]}/qr`);
    assert.equal(image.status, 200, `${device.name} staff pass image`);
  }));
  const pageLoads = await Promise.all(devices.map((device) => call(device, "GET", `/check-in?event=${eventId}`)));
  for (const [index, page] of pageLoads.entries()) assert.equal(page.status, 200, `${devices[index].name} check-in page: ${page.status}`);
  const attendeePassLoads = await Promise.all(Array.from({ length: 40 }, (_, index) => call(devices[index % 4], "GET", `/api/public/manage/${registrations[0].token}/attendee-passes/${registrations[0].attendeeIds[index % 4]}/qr`)));
  assert.ok(attendeePassLoads.every((answer) => answer.status === 200), `attendee pass images: ${[...new Set(attendeePassLoads.map((answer) => answer.status))].join(",")}`);

  // 9. After all of that, all four sessions are still valid, and a signed-out jar is refused.
  for (const device of devices) {
    assert.equal((await call(device, "GET", "/api/auth/sessions")).status, 200, `${device.name} is still signed in`);
  }
  assert.equal(await prisma.userSession.count({ where: { userId, revokedAt: null } }), 4, "no session was revoked by another sign-in");
  const anonymous = await call({ name: "anon", cookie: "", agent: "x", address: "203.0.113.99" }, "POST", `/api/events/${eventId}/attendees/${registrations[0].attendeeIds[0]}/check-in`, { idempotencyKey: randomUUID() });
  assert.equal(anonymous.status, 401);
  statuses.pop();

  const bad = statuses.filter((status) => forbidden.has(status));
  assert.deepEqual(bad, [], "no 401/403/429/500 answered to any signed-in device");
  console.log(`Multi-device check-in HTTP checks passed (${statuses.length} requests).`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    await prisma.event.deleteMany({ where: { id: eventId } });
    await prisma.person.deleteMany({ where: { lastName: { contains: key } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: userId }, { eventId }] } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });
