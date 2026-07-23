import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import {
  createOpaqueToken,
  hashOpaqueToken,
} from "../modules/access/tokens";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const baseUrl = process.env.PUBLIC_REGISTRATION_TEST_URL
  ?? "http://localhost:3000";
const fixtureKey = randomUUID().replaceAll("-", "").slice(0, 16);
const eventSlug = `private-access-${fixtureKey}`;
const email = `private-access-${fixtureKey}@example.test`;
const holdVisualFixture = process.env.PUBLIC_ACCESS_VISUAL_HOLD === "1";

let eventId: string | null = null;
let personId: string | null = null;

async function cleanup() {
  if (eventId) {
    await prisma.event.deleteMany({ where: { id: eventId } });
  }
  if (personId) {
    await prisma.person.deleteMany({ where: { id: personId } });
  }
}

async function main() {
  await cleanup();
  const event = await prisma.event.create({
    data: {
      slug: eventSlug,
      name: "Private access verification event",
      startsAt: new Date("2026-10-09T21:00:00.000Z"),
      endsAt: new Date("2026-10-11T17:00:00.000Z"),
      timezone: "America/Chicago",
      location: "Fictitious verification venue",
      publicInfoUrl: "https://imsda.org/events/",
      supportContact: "registration@imsda.org",
      isPublished: true,
    },
  });
  eventId = event.id;
  const person = await prisma.person.create({
    data: {
      firstName: "Original",
      lastName: "Contact",
      normalizedEmail: email,
      phone: "555-0100",
    },
  });
  personId = person.id;
  const registration = await prisma.registration.create({
    data: {
      eventId: event.id,
      accountHolderPersonId: person.id,
      confirmationCode: `VERIFY-${fixtureKey.toUpperCase()}`,
      status: "SUBMITTED",
      totalAmount: 125,
      submittedAt: new Date("2026-07-23T12:00:00.000Z"),
      attendees: {
        create: {
          eventId: event.id,
          personId: person.id,
          attendeeType: "ATTENDEE",
          position: 0,
          profileSnapshot: {
            firstName: "Original",
            lastName: "Contact",
            email,
            phone: "555-0100",
            source: "INTEGRATION_VERIFICATION",
          },
        },
      },
    },
  });
  const token = holdVisualFixture
    ? "v".repeat(43)
    : createOpaqueToken();
  const stored = await prisma.registrationAccessToken.create({
    data: {
      registrationId: registration.id,
      tokenHash: hashOpaqueToken(token),
      expiresAt: new Date("2026-11-10T17:00:00.000Z"),
    },
  });
  assert.notEqual(stored.tokenHash, token, "the database must not store the raw token");

  const apiUrl = new URL(`/api/public/manage/${token}`, baseUrl);
  const pageUrl = new URL(`/manage/${token}`, baseUrl);
  const origin = new URL(baseUrl).origin;

  const getResponse = await fetch(apiUrl, { cache: "no-store" });
  assert.equal(getResponse.status, 200, "an active token should resolve");
  assert.match(
    getResponse.headers.get("cache-control") ?? "",
    /no-store/,
    "private API responses must not be cached",
  );
  assert.match(
    getResponse.headers.get("x-robots-tag") ?? "",
    /noindex/,
    "private API responses must not be indexed",
  );
  const getPayload = await getResponse.json() as {
    registration: {
      registration: { status: string };
      payment: { amountDueCents: number };
    };
  };
  assert.equal(getPayload.registration.registration.status, "SUBMITTED");
  assert.equal(getPayload.registration.payment.amountDueCents, 12_500);

  const pageResponse = await fetch(pageUrl, {
    cache: "no-store",
    redirect: "manual",
  });
  assert.equal(pageResponse.status, 200, "the private manage page should render");
  assert.match(
    pageResponse.headers.get("cache-control") ?? "",
    /no-store|no-cache/,
    "dynamic private pages must not be served as publicly cacheable content",
  );
  assert.equal(pageResponse.headers.get("referrer-policy"), "no-referrer");
  const pageHtml = await pageResponse.text();
  assert.match(pageHtml, /Private access verification event/);
  assert.match(pageHtml, new RegExp(registration.confirmationCode));

  const unsafeResponse = await fetch(apiUrl, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify({
      firstName: "Unsafe",
      lastName: "Attempt",
      email: "unsafe@example.test",
      phone: "",
      status: "CONFIRMED",
    }),
  });
  assert.equal(unsafeResponse.status, 400, "status updates must be rejected");
  assert.equal(
    (await prisma.registration.findUniqueOrThrow({
      where: { id: registration.id },
      select: { status: true },
    })).status,
    "SUBMITTED",
  );

  const updateResponse = await fetch(apiUrl, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify({
      firstName: "Updated",
      lastName: "Contact",
      email: `updated-${email}`,
      phone: "",
    }),
  });
  assert.equal(updateResponse.status, 200, "safe contact details should update");
  const updatedRegistration = await prisma.registration.findUniqueOrThrow({
    where: { id: registration.id },
    select: { contactSnapshot: true, status: true, totalAmount: true },
  });
  assert.deepEqual(updatedRegistration.contactSnapshot, {
    firstName: "Updated",
    lastName: "Contact",
    email: `updated-${email}`,
    phone: "",
  });
  assert.equal(updatedRegistration.status, "SUBMITTED");
  assert.equal(updatedRegistration.totalAmount.toString(), "125");
  const unchangedPerson = await prisma.person.findUniqueOrThrow({
    where: { id: person.id },
    select: { firstName: true, normalizedEmail: true },
  });
  assert.deepEqual(unchangedPerson, {
    firstName: "Original",
    normalizedEmail: email,
  });

  if (holdVisualFixture) {
    console.log(
      "Private registration visual fixture is ready. Press Enter after browser verification to revoke and clean it up.",
    );
    await new Promise<void>((resolve) => {
      process.stdin.once("data", () => {
        process.stdin.pause();
        resolve();
      });
    });
  }

  await prisma.registrationAccessToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });
  const revokedResponse = await fetch(apiUrl, { cache: "no-store" });
  assert.equal(
    revokedResponse.status,
    404,
    "a revoked token must use the generic unavailable response",
  );

  console.log(
    "Private registration access verification passed: hash-only storage, active page/API resolution, contact-only updates, and revocation.",
  );
}

main()
  .catch((error) => {
    console.error("Private registration access verification failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
