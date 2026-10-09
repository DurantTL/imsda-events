/**
 * Proves the hosted "Pay on Square" link (#327) against a real PostgreSQL database and a fake
 * Square that stands in at the HTTP boundary (Sandbox-style: no network, no credentials, no money):
 *
 * - the link is quoted by the same checkout the embedded form uses, so its amount and fee match
 *   the Pay Later to Pay Now path (#317) for a pay-later, a card-priced, a fee-absorbed and a
 *   promoted-waitlist registration, and creating it never changes the registration total;
 * - creating a link is idempotent: the same key, or a new key for the same balance, returns the one
 *   link and makes one Square order; an unconfirmed creation is retried with the same Square key;
 * - only the verified webhook confirms payment: an approved payment is pending and moves no
 *   balance, a completed one is recorded once (one payment, the fee added once, one receipt), and a
 *   replay of the same event, or of the same payment under a new event id, changes nothing;
 * - a declined card on the hosted page leaves the link payable;
 * - the first recorded payment wins: starting an embedded payment withdraws the open link at
 *   Square, a hosted payment that arrives afterwards is kept as evidence (payment held PENDING,
 *   a duplicate-charge record, a high-priority audit entry and an urgent alert) and never counts
 *   toward the balance, adds a fee or sends a receipt, replays leave it alone, and a full refund
 *   in Square resolves it without touching the registration total; a hosted payment already
 *   recorded refuses another link and another embedded payment; an embedded payment in flight
 *   refuses a link; and an embedded payment racing a hosted webhook leaves exactly one valid payment;
 * - stale links: a payment staff record withdraws the link and a later replay of its key is
 *   refused, a payment on a withdrawn link is judged against the live balance (duplicate when it no
 *   longer fits, accepted when a refund made the balance grow), a cancelled registration's late
 *   payment is a duplicate, an expired link is refused and deleted at Square, a failed Square
 *   deletion is retried by the sweep, and a feature-off or church-billed event offers no link;
 * - a webhook amount that is not the quoted amount is ignored.
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:square-hosted-link
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";
import {
  parseSquareWebhookEvent,
  registrationBalanceCents,
  squareWebhookPayloadHash,
} from "../modules/payments/square-domain";
import type { SquareRuntimeConfiguration } from "../modules/payments/square-config";
import {
  createAttendeeSquarePayment,
  getAttendeeSquareCheckout,
  processSquareWebhook,
  SquarePaymentOperationError,
} from "../modules/payments/square-repository";
import { createAttendeeSquarePaymentLink } from "../modules/payments/square-hosted-repository";
import { sweepHostedCheckouts } from "../modules/payments/square-hosted-invalidation";
import { recordManualPayment, recordRefund } from "../modules/payments/repository";

loadEnvConfig(process.cwd());
// Local-only, before any Prisma client or connection exists.
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-square-hosted-link-synthetic-key-not-a-secret");
// An alert must be recorded here, never posted anywhere.
delete process.env.ALERT_WEBHOOK_URL;
// Code that reads Square's configuration from the environment (the flush after a staff payment)
// sees the same synthetic sandbox the checks pass in, whatever a developer's .env holds.
Object.assign(process.env, {
  SQUARE_ENVIRONMENT: "sandbox",
  SQUARE_APPLICATION_ID: "sandbox-sq0idb-synthetic",
  SQUARE_LOCATION_ID: "SHL-LOCATION",
  SQUARE_ACCESS_TOKEN: "synthetic-access-token",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "synthetic-signature-key",
  SQUARE_WEBHOOK_NOTIFICATION_URL: "https://events.imsda.test/api/webhooks/square",
});
delete process.env.SQUARE_API_URL;

const prisma = new PrismaClient();
const P = "shl";
const adminId = `${P}_admin`;
const events = {
  on: `${P}_event_on`,
  noFee: `${P}_event_nofee`,
  off: `${P}_event_off`,
  church: `${P}_event_church`,
};
const configuration: SquareRuntimeConfiguration = {
  environment: "sandbox",
  applicationId: "sandbox-sq0idb-synthetic",
  locationId: `${P.toUpperCase()}-LOCATION`,
  accessToken: "synthetic-access-token",
  apiUrl: "https://connect.squareupsandbox.com",
  apiVersion: "2026-07-15",
  scriptUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
  webhookSignatureKey: "synthetic-signature-key",
  webhookNotificationUrl: "https://events.imsda.test/api/webhooks/square",
  paymentConfigured: true,
  webhookConfigured: true,
  issue: null,
};
const appBaseUrl = "https://events.imsda.test";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function expectOperationError(promise: Promise<unknown>, code: string, message: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  assert(
    error instanceof SquarePaymentOperationError && error.code === code,
    `${message}: expected ${code}, got ${error instanceof Error ? `${error.name} ${(error as { code?: string }).code ?? error.message}` : String(error)}`,
  );
}

// ---------------------------------------------------------------------------------------------
// A fake Square at the HTTP boundary. Anything it does not know is refused, so nothing leaves the
// machine and nothing real can be charged.
// ---------------------------------------------------------------------------------------------
type FakeLink = { id: string; orderId: string; url: string; body: Record<string, unknown>; deleted: boolean };
const square = {
  links: new Map<string, FakeLink>(), // by idempotency key
  createRequests: 0,
  createMode: "OK" as "OK" | "UNAVAILABLE",
  deleteMode: "OK" as "OK" | "UNAVAILABLE",
  deleteCalls: [] as string[],
  embeddedMode: "COMPLETED" as "COMPLETED" | "UNAVAILABLE",
  embeddedCounter: 0,
  embeddedPayments: [] as Array<{ id: string; amount: number }>,
  seq: 0,
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  if (!url.startsWith("https://connect.squareupsandbox.com/")) {
    throw new Error(`The fake Square refused a request to ${url}.`);
  }
  assert(headers.get("authorization") === "Bearer synthetic-access-token", "Square calls carry the configured token");
  const path = new URL(url).pathname;
  if (method === "POST" && path === "/v2/online-checkout/payment-links") {
    square.createRequests += 1;
    if (square.createMode === "UNAVAILABLE") return jsonResponse(503, { errors: [{ code: "SERVICE_UNAVAILABLE", detail: "Try later." }] });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const key = String(body.idempotency_key);
    let link = square.links.get(key);
    if (!link) {
      square.seq += 1;
      link = {
        id: `${P}-LINK-${square.seq}`,
        orderId: `${P}-ORDER-${square.seq}`,
        url: `https://sandbox.square.link/u/${P}-${square.seq}`,
        body,
        deleted: false,
      };
      square.links.set(key, link);
    }
    return jsonResponse(200, { payment_link: { id: link.id, version: 1, order_id: link.orderId, url: link.url } });
  }
  if (method === "DELETE" && path.startsWith("/v2/online-checkout/payment-links/")) {
    const id = decodeURIComponent(path.split("/").pop()!);
    square.deleteCalls.push(id);
    if (square.deleteMode === "UNAVAILABLE") return jsonResponse(503, { errors: [{ code: "SERVICE_UNAVAILABLE", detail: "Try later." }] });
    const link = [...square.links.values()].find((candidate) => candidate.id === id);
    if (!link) return jsonResponse(404, { errors: [{ code: "NOT_FOUND", detail: "No such link." }] });
    link.deleted = true;
    return jsonResponse(200, { id, cancelled_order_id: link.orderId });
  }
  if (method === "POST" && path === "/v2/payments") {
    if (square.embeddedMode === "UNAVAILABLE") return jsonResponse(503, { errors: [{ code: "SERVICE_UNAVAILABLE", detail: "Try later." }] });
    const body = JSON.parse(String(init?.body)) as { amount_money: { amount: number; currency: string }; reference_id: string };
    square.embeddedCounter += 1;
    const id = `${P}-PAY-EMBEDDED-${square.embeddedCounter}`;
    square.embeddedPayments.push({ id, amount: body.amount_money.amount });
    const now = new Date().toISOString();
    return jsonResponse(200, {
      payment: { id, status: "COMPLETED", amount_money: body.amount_money, reference_id: body.reference_id, created_at: now, updated_at: now },
    });
  }
  throw new Error(`The fake Square does not know ${method} ${path}.`);
}) as typeof fetch;

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------
const startsWithP = { startsWith: `${P}_` };

function formDefinition(passFeeToRegistrant: boolean) {
  return {
    title: "Hosted link check",
    description: "",
    confirmationMessage: "Received.",
    payment: {
      enabled: true,
      currency: "USD",
      paymentMethodFieldKey: "payment_method",
      cardOptionValue: "Credit / debit card",
      percentageBasisPoints: 290,
      fixedFeeCents: 30,
      passFeeToRegistrant,
    },
    sections: [{
      id: "payment-section",
      title: "Payment",
      description: "",
      fields: [{
        id: "payment-method",
        key: "payment_method",
        label: "Payment method",
        helpText: "",
        type: "RADIO",
        scope: "REGISTRATION",
        required: true,
        options: ["Pay later", "Credit / debit card"],
      }],
    }],
  };
}

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    // The payment-choice ledger is append-only; event deletion is the one path allowed to remove it.
    await tx.$executeRaw`SELECT set_config('imsda.event_deletion', 'on', true)`;
    await tx.registrationPaymentChoiceOperation.deleteMany({ where: { eventId: startsWithP } });
    await tx.event.deleteMany({ where: { id: startsWithP } });
  });
  await prisma.person.deleteMany({ where: { id: startsWithP } });
  await prisma.squareWebhookEvent.deleteMany({ where: { providerEventId: startsWithP } });
  await prisma.alertNotification.deleteMany({ where: { key: { startsWith: `payments.duplicate-charge.${P}` } } });
  await prisma.user.deleteMany({ where: { id: adminId } });
}

let counter = 0;
async function createEvent(id: string, options: { hosted: boolean; passFee: boolean; church?: boolean }) {
  await prisma.event.create({
    data: {
      id,
      slug: `${id.replace(/_/g, "-")}-slug`,
      name: `Hosted link check ${id}`,
      startsAt: new Date("2028-10-13T15:00:00Z"),
      endsAt: new Date("2028-10-15T18:00:00Z"),
      isPublished: true,
      hostedPaymentLinkEnabled: options.hosted,
      billingMode: options.church ? "DEFERRED_ORGANIZATION_INVOICE" : "ATTENDEE_PAY",
    },
  });
  const form = await prisma.registrationForm.create({
    data: { eventId: id, createdByUserId: adminId, name: "Form", slug: `${id.replace(/_/g, "-")}-form` },
  });
  const version = await prisma.registrationFormVersion.create({
    data: {
      formId: form.id,
      createdByUserId: adminId,
      versionNumber: 1,
      status: "PUBLISHED",
      publishedAt: new Date(),
      definition: formDefinition(options.passFee),
    },
  });
  return version.id;
}

const formVersions = new Map<string, string>();

type Fixture = { registrationId: string; eventId: string; code: string };

/** A registration owing `totalCents`, optionally with a cash payment already recorded. */
async function createRegistration(
  eventId: string,
  options: {
    totalCents: number;
    method: "Pay later" | "Credit / debit card";
    cashPaidCents?: number;
    promoted?: "CARD" | "PAY_LATER";
    status?: "CONFIRMED" | "SUBMITTED";
  },
): Promise<Fixture> {
  counter += 1;
  const code = `SHL${String(counter).padStart(4, "0")}`;
  const person = await prisma.person.create({
    data: { id: `${P}_person_${counter}`, firstName: "Hosted", lastName: `Check${counter}`, normalizedEmail: `${P}-${counter}@example.test` },
  });
  const registration = await prisma.registration.create({
    data: {
      eventId,
      accountHolderPersonId: person.id,
      confirmationCode: code,
      totalAmount: options.totalCents / 100,
      status: options.status ?? "CONFIRMED",
      submittedAt: new Date(),
      contactSnapshot: { firstName: "Hosted", lastName: `Check${counter}`, email: `${P}-${counter}@example.test`, phone: "" },
    },
  });
  await prisma.publicRegistrationSubmission.create({
    data: {
      eventId,
      formVersionId: formVersions.get(eventId)!,
      registrationId: registration.id,
      idempotencyKey: randomUUID(),
      requestHash: "hash",
      responses: { payment_method: options.method },
      pricingSnapshot: { currency: "USD", subtotalCents: 10_000 },
    },
  });
  if (options.cashPaidCents) {
    await prisma.payment.create({
      data: {
        eventId,
        registrationId: registration.id,
        amount: options.cashPaidCents / 100,
        status: "SUCCEEDED",
        method: "CASH",
        receivedAt: new Date(),
      },
    });
  }
  if (options.promoted) {
    await prisma.registrationWaitlistEntry.create({
      data: { eventId, registrationId: registration.id, position: counter, attendeeCount: 1, status: "PROMOTED", promotedAt: new Date() },
    });
    const operationId = randomUUID();
    const fee = options.promoted === "CARD" ? 330 : 0;
    await prisma.registrationPaymentChoiceOperation.create({
      data: {
        id: operationId,
        eventId,
        registrationId: registration.id,
        sequence: 1,
        clientRequestId: randomUUID(),
        requestFingerprint: "fingerprint",
        choice: options.promoted,
        baseSubtotalCents: 10_000,
        processingFeeCents: fee,
        resultingTotalCents: 10_000 + fee,
        responseSnapshot: {},
      },
    });
  }
  return { registrationId: registration.id, eventId, code };
}

const access = (fixture: Fixture) => ({ registrationId: fixture.registrationId, eventId: fixture.eventId });
const newKey = () => randomUUID();

async function balanceCents(registrationId: string) {
  const registration = await prisma.registration.findUniqueOrThrow({
    where: { id: registrationId },
    select: {
      totalAmount: true,
      payments: {
        where: { status: "SUCCEEDED" },
        select: { amount: true, refunds: { where: { status: "SUCCEEDED" }, select: { amount: true } } },
      },
    },
  });
  return registrationBalanceCents(registration);
}

async function totalCents(registrationId: string) {
  const registration = await prisma.registration.findUniqueOrThrow({ where: { id: registrationId }, select: { totalAmount: true } });
  return Math.round(Number(registration.totalAmount) * 100);
}

async function hostedFor(registrationId: string) {
  return prisma.squareHostedCheckout.findMany({
    where: { registrationId },
    orderBy: { createdAt: "asc" },
    include: { paymentAttempt: true },
  });
}

async function cardPayments(registrationId: string) {
  return prisma.payment.findMany({ where: { registrationId, method: "CARD_REFERENCE" }, orderBy: { createdAt: "asc" } });
}

async function receiptCount(registrationId: string) {
  return prisma.messageOutbox.count({ where: { registrationId, templateKey: "PAYMENT_RECEIPT" } });
}

let webhookCounter = 0;
function paymentEvent(input: {
  eventId?: string;
  orderId: string;
  paymentId: string;
  status: "APPROVED" | "COMPLETED" | "FAILED";
  amountCents: number;
}) {
  webhookCounter += 1;
  const at = new Date(Date.UTC(2028, 9, 13, 16, 0, webhookCounter % 60, 0)).toISOString();
  return {
    event_id: input.eventId ?? `${P}_evt_${webhookCounter}_${randomUUID()}`,
    type: "payment.updated",
    created_at: at,
    data: {
      type: "payment",
      id: input.paymentId,
      object: {
        payment: {
          id: input.paymentId,
          status: input.status,
          order_id: input.orderId,
          location_id: configuration.locationId,
          amount_money: { amount: input.amountCents, currency: "USD" },
          created_at: at,
          updated_at: at,
        },
      },
    },
  };
}

async function sendWebhook(payload: ReturnType<typeof paymentEvent> | Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  const run = () => processSquareWebhook(
    parseSquareWebhookEvent(JSON.parse(raw)),
    squareWebhookPayloadHash(raw),
    { configuration },
  );
  // Square retries a webhook that was answered with an error; so does this.
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof SquarePaymentOperationError) || !error.retryable) throw error;
    return run();
  }
}

function refundEvent(input: { paymentId: string; refundId: string; amountCents: number }) {
  webhookCounter += 1;
  const at = new Date().toISOString();
  return {
    event_id: `${P}_evt_refund_${webhookCounter}_${randomUUID()}`,
    type: "refund.updated",
    created_at: at,
    data: {
      type: "refund",
      id: input.refundId,
      object: {
        refund: {
          id: input.refundId,
          status: "COMPLETED",
          payment_id: input.paymentId,
          location_id: configuration.locationId,
          amount_money: { amount: input.amountCents, currency: "USD" },
          created_at: at,
          updated_at: at,
        },
      },
    },
  };
}

async function waitFor(condition: () => Promise<boolean>, message: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`FAILED: ${message}`);
}

async function createLink(fixture: Fixture, key = newKey(), now?: Date) {
  return createAttendeeSquarePaymentLink(access(fixture), { idempotencyKey: key }, { configuration, appBaseUrl, now });
}

async function payEmbedded(fixture: Fixture) {
  return createAttendeeSquarePayment(access(fixture), { sourceId: "cnon:synthetic-card-nonce", idempotencyKey: newKey() }, { configuration });
}

async function openLinkFor(fixture: Fixture) {
  const link = await createLink(fixture);
  const [hosted] = (await hostedFor(fixture.registrationId)).filter((row) => row.status === "ACTIVE");
  assert(hosted?.providerOrderId, "the link has Square's order id stored");
  return { link, hosted, orderId: hosted.providerOrderId };
}

async function main() {
  await cleanup();
  await prisma.user.create({ data: { id: adminId, email: `${P}-admin@example.test`, displayName: "Hosted Link Check Admin", globalRole: "SYSTEM_ADMIN" } });
  formVersions.set(events.on, await createEvent(events.on, { hosted: true, passFee: true }));
  formVersions.set(events.noFee, await createEvent(events.noFee, { hosted: true, passFee: false }));
  formVersions.set(events.off, await createEvent(events.off, { hosted: false, passFee: true }));
  formVersions.set(events.church, await createEvent(events.church, { hosted: true, passFee: true, church: true }));

  // ---- The setting is off unless staff turn it on. ----
  const bare = await prisma.event.create({
    data: { id: `${P}_event_bare`, slug: `${P}-bare`, name: "Bare", startsAt: new Date("2028-10-13T15:00:00Z"), endsAt: new Date("2028-10-15T18:00:00Z") },
  });
  assert(bare.hostedPaymentLinkEnabled === false, "an event offers Pay on Square only when staff turn it on");

  // ---- 1. Amount and fee parity with the embedded path (#317); creation never changes the total. ----
  {
    const payLater = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later" });
    const checkout = await getAttendeeSquareCheckout(access(payLater), { configuration });
    assert(checkout && "hostedLink" in checkout && checkout.hostedLink === true, "the checkout offers Pay on Square on an enabled event");
    assert("amountCents" in checkout && checkout.amountCents === 10_330 && checkout.surchargeCents === 330, "the pay-later checkout is balance plus the grossed-up card fee");
    const before = square.createRequests;
    const link = await createLink(payLater);
    assert(link.amountCents === 10_330 && link.surchargeCents === 330 && link.balanceCents === 10_000, "the link is the same amount the embedded form would charge");
    assert(square.createRequests === before + 1, "one Square order is made");
    const [hosted] = await hostedFor(payLater.registrationId);
    assert(hosted?.status === "ACTIVE" && hosted.checkoutUrl === link.url && hosted.providerPaymentLinkId && hosted.providerOrderId, "the link is stored with Square's link and order ids");
    assert(hosted.paymentAttempt.channel === "HOSTED_LINK" && hosted.paymentAttempt.amountCents === 10_330 && hosted.paymentAttempt.surchargeCents === 330, "the attempt owns the quote");
    assert(hosted.paymentAttempt.activeRegistrationKey === null && hosted.paymentAttempt.status === "PROCESSING", "an unpaid link is an offer, not a payment in flight");
    assert(await totalCents(payLater.registrationId) === 10_000, "creating the link never adds the fee to the total");
    const sent = [...square.links.values()].find((candidate) => candidate.id === hosted.providerPaymentLinkId)!.body as {
      order: { location_id: string; reference_id: string; line_items: Array<{ base_price_money: { amount: number; currency: string }; quantity: string }> };
      checkout_options: { redirect_url: string };
    };
    assert(sent.order.line_items.length === 1 && sent.order.line_items[0]!.base_price_money.amount === 10_330 && sent.order.line_items[0]!.quantity === "1", "Square gets one line for the exact amount");
    assert(sent.order.reference_id === hosted.paymentAttemptId && sent.order.location_id === configuration.locationId, "the order carries our attempt id and the location");
    assert(sent.checkout_options.redirect_url === `${appBaseUrl}/account/registrations?pay=square`, "Square returns the registrant to their own page");
    assert(!/@example\.test|Hosted|Check\d/.test(JSON.stringify(sent)), "nothing identifying the payer is sent to Square");

    const cardPriced = await createRegistration(events.on, { totalCents: 10_330, method: "Credit / debit card" });
    const cardLink = await createLink(cardPriced);
    assert(cardLink.amountCents === 10_330 && cardLink.surchargeCents === 0, "a registration already priced for card gets no second fee");

    const absorbed = await createRegistration(events.noFee, { totalCents: 10_000, method: "Pay later" });
    const absorbedLink = await createLink(absorbed);
    assert(absorbedLink.amountCents === 10_000 && absorbedLink.surchargeCents === 0, "an event that absorbs the fee charges the balance only");

    const promotedCard = await createRegistration(events.on, { totalCents: 10_330, method: "Pay later", promoted: "CARD" });
    const promotedCardLink = await createLink(promotedCard);
    assert(promotedCardLink.amountCents === 10_330 && promotedCardLink.surchargeCents === 0, "a promoted waitlist registration that chose card already carries its fee");
    const promotedLater = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later", promoted: "PAY_LATER" });
    const promotedLaterLink = await createLink(promotedLater);
    assert(promotedLaterLink.amountCents === 10_000 && promotedLaterLink.surchargeCents === 0, "a promoted waitlist pay-later registration is not surcharged by the link");
    assert((await prisma.paymentAttempt.count({ where: { registrationId: promotedLater.registrationId, activeRegistrationKey: { not: null } } })) === 0, "an unpaid link locks nothing");
    const promotedView = await getAttendeeSquareCheckout(access(promotedLater), { configuration });
    assert(promotedView && "paymentChoice" in promotedView && promotedView.paymentChoice?.locked === false, "an unpaid link does not lock the payment choice");
  }

  // ---- 2. Idempotent creation. ----
  {
    const fixture = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later" });
    const key = newKey();
    const before = square.createRequests;
    const first = await createLink(fixture, key);
    const replay = await createLink(fixture, key);
    const another = await createLink(fixture, newKey());
    assert(first.url === replay.url && first.url === another.url, "the same balance gets the same link, by key or by new key");
    assert(square.createRequests === before + 1, "replays make no second Square order");
    assert((await hostedFor(fixture.registrationId)).length === 1, "one hosted link row for the balance");
    assert(await totalCents(fixture.registrationId) === 10_000, "replays never add the fee");

    const unconfirmed = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later" });
    const retryKey = newKey();
    square.createMode = "UNAVAILABLE";
    await expectOperationError(createLink(unconfirmed, retryKey), "PAYMENT_RESULT_UNCERTAIN", "an unconfirmed Square creation is retryable");
    square.createMode = "OK";
    const [pending] = await hostedFor(unconfirmed.registrationId);
    assert(pending?.status === "CREATING", "the unconfirmed link waits as CREATING");
    const retried = await createLink(unconfirmed, retryKey);
    assert(retried.url.startsWith("https://sandbox.square.link/"), "the retry gets the link");
    const keysSeen = [...square.links.keys()].filter((candidate) => candidate === pending.paymentAttempt.providerIdempotencyKey);
    assert(keysSeen.length === 1, "the retry reuses the same Square idempotency key");
  }

  // ---- 3. Only the verified webhook confirms payment; replays change nothing. ----
  {
    const fixture = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later" });
    const { orderId } = await openLinkFor(fixture);
    const paymentId = `${P}-PAY-HOSTED-1`;
    assert(await balanceCents(fixture.registrationId) === 10_000 && (await cardPayments(fixture.registrationId)).length === 0, "a link, and a registrant sent back from Square, prove nothing");

    await sendWebhook(paymentEvent({ orderId, paymentId, status: "APPROVED", amountCents: 10_330 }));
    let attempt = (await hostedFor(fixture.registrationId))[0]!.paymentAttempt;
    assert(attempt.status === "PENDING" && attempt.providerPaymentId === paymentId && attempt.activeRegistrationKey === fixture.registrationId, "an approved payment is pending and holds the one in-flight slot");
    assert(await balanceCents(fixture.registrationId) === 10_000 && await totalCents(fixture.registrationId) === 10_000, "pending money moves no balance and adds no fee");
    await expectOperationError(payEmbedded(fixture), "PAYMENT_IN_PROGRESS", "an embedded payment waits for the pending hosted one");

    const completed = paymentEvent({ orderId, paymentId, status: "COMPLETED", amountCents: 10_330 });
    const result = await sendWebhook(completed);
    assert(result.status === "PROCESSED" && "paymentStatus" in result && result.paymentStatus === "SUCCEEDED", "the completed payment is recorded");
    attempt = (await hostedFor(fixture.registrationId))[0]!.paymentAttempt;
    assert(attempt.status === "SUCCEEDED" && attempt.activeRegistrationKey === null && attempt.duplicateReason === null, "the attempt succeeded and released the slot");
    assert((await hostedFor(fixture.registrationId))[0]!.status === "PAID", "the link is PAID");
    assert(await totalCents(fixture.registrationId) === 10_330 && await balanceCents(fixture.registrationId) === 0, "the fee joined the total once and the balance is paid");
    const payments = await cardPayments(fixture.registrationId);
    assert(payments.length === 1 && payments[0]!.status === "SUCCEEDED" && Number(payments[0]!.amount) === 103.3 && payments[0]!.externalReference === paymentId, "one successful card payment");
    assert(await receiptCount(fixture.registrationId) === 1, "one receipt");

    const sameEvent = await sendWebhook(completed);
    assert(sameEvent.duplicate === true, "the same event id is a recognised duplicate");
    const newEvent = await sendWebhook(paymentEvent({ orderId, paymentId, status: "COMPLETED", amountCents: 10_330 }));
    assert(newEvent.status === "PROCESSED", "the same payment under a new event id is accepted without effect");
    assert((await cardPayments(fixture.registrationId)).length === 1, "still one payment");
    assert(await totalCents(fixture.registrationId) === 10_330, "the fee is not added twice on replay");
    assert(await receiptCount(fixture.registrationId) === 1, "still one receipt");
    await expectOperationError(payEmbedded(fixture), "PAYMENT_ALREADY_COMPLETE", "a paid balance refuses another embedded payment");
    await expectOperationError(createLink(fixture), "PAYMENT_ALREADY_COMPLETE", "a paid balance refuses another link");
  }

  // ---- 4. A declined card on the hosted page leaves the link payable. ----
  {
    const fixture = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later" });
    const { orderId } = await openLinkFor(fixture);
    await sendWebhook(paymentEvent({ orderId, paymentId: `${P}-PAY-DECLINED`, status: "FAILED", amountCents: 10_330 }));
    const [row] = await hostedFor(fixture.registrationId);
    assert(row!.status === "ACTIVE" && row!.paymentAttempt.status === "PROCESSING" && (await cardPayments(fixture.registrationId)).length === 0, "a decline records nothing and keeps the link");
    await sendWebhook(paymentEvent({ orderId, paymentId: `${P}-PAY-RETRY`, status: "COMPLETED", amountCents: 10_330 }));
    assert(await balanceCents(fixture.registrationId) === 0 && (await cardPayments(fixture.registrationId)).length === 1, "the payer's second try on the same page is recorded");
  }

  // ---- 5. First payment wins: embedded, then a hosted payment from the withdrawn link. ----
  {
    const fixture = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later" });
    const { orderId, hosted } = await openLinkFor(fixture);
    const embedded = await payEmbedded(fixture);
    assert(embedded.status === "SUCCEEDED", "the embedded payment succeeds");
    const [afterEmbedded] = await hostedFor(fixture.registrationId);
    assert(afterEmbedded!.status === "INVALIDATED" && afterEmbedded!.invalidationReason === "EMBEDDED_ATTEMPT_STARTED" && afterEmbedded!.paymentAttempt.status === "CANCELED", "starting an embedded payment withdraws the open link");
    await waitFor(async () => (await prisma.squareHostedCheckout.findUniqueOrThrow({ where: { id: hosted.id } })).providerDeletedAt !== null, "the withdrawn link is deleted at Square");
    assert(square.deleteCalls.includes(hosted.providerPaymentLinkId!), "Square was told to delete the link (which cancels its order)");
    assert(await totalCents(fixture.registrationId) === 10_330 && await balanceCents(fixture.registrationId) === 0, "the embedded payment settled the balance, fee once");

    // The payer had the hosted page open anyway, and Square took the money.
    const duplicatePaymentId = `${P}-PAY-DUPLICATE-1`;
    const duplicate = paymentEvent({ orderId, paymentId: duplicatePaymentId, status: "COMPLETED", amountCents: 10_330 });
    await sendWebhook(duplicate);
    const payments = await cardPayments(fixture.registrationId);
    const valid = payments.filter((payment) => payment.status === "SUCCEEDED");
    const held = payments.filter((payment) => payment.status === "PENDING");
    assert(valid.length === 1 && held.length === 1 && held[0]!.externalReference === duplicatePaymentId, "exactly one valid payment; the duplicate is held as evidence");
    assert(await balanceCents(fixture.registrationId) === 0 && await totalCents(fixture.registrationId) === 10_330, "the duplicate neither counts toward the balance nor adds a fee");
    assert(await receiptCount(fixture.registrationId) === 1, "the duplicate sends no receipt");
    const record = await prisma.squareDuplicateCharge.findUniqueOrThrow({ where: { providerPaymentId: duplicatePaymentId } });
    assert(record.status === "OPEN" && record.reason === "BALANCE_ALREADY_PAID" && record.amountCents === 10_330 && record.providerOrderId === orderId && record.winningPaymentId === valid[0]!.id, "the duplicate charge record names the reason, order and winning payment");
    assert(JSON.stringify(record.evidence).includes(duplicatePaymentId) && !/@example\.test|last_4|card_details/.test(JSON.stringify(record.evidence)), "the evidence keeps Square's identifiers and no payer or card details");
    const alert = await prisma.alertNotification.findUnique({ where: { key: `payments.duplicate-charge.${duplicatePaymentId}` } });
    assert(alert?.severity === "URGENT" && alert.resolvedAt === null, "staff get an urgent alert");
    const audit = await prisma.auditLog.findFirst({ where: { eventId: fixture.eventId, action: "SQUARE_DUPLICATE_CHARGE_DETECTED" } });
    assert((audit?.metadata as { priority?: string } | null)?.priority === "HIGH", "a high-priority audit entry preserves the detection");
    const webhookRow = await prisma.squareWebhookEvent.findUniqueOrThrow({ where: { providerEventId: duplicate.event_id } });
    assert(webhookRow.status === "PROCESSED" && /Duplicate charge/.test(webhookRow.reason ?? ""), "the webhook record says why");

    // Replays leave the evidence alone.
    await sendWebhook(duplicate);
    await sendWebhook(paymentEvent({ orderId, paymentId: duplicatePaymentId, status: "COMPLETED", amountCents: 10_330 }));
    assert((await prisma.squareDuplicateCharge.count({ where: { registrationId: fixture.registrationId } })) === 1, "one duplicate record however often Square repeats itself");
    assert((await cardPayments(fixture.registrationId)).filter((payment) => payment.status === "PENDING").length === 1, "the held payment is not promoted by a replay");
    assert(await balanceCents(fixture.registrationId) === 0 && await receiptCount(fixture.registrationId) === 1, "a replay still changes nothing");

    // Staff refund it in Square; the refund webhook resolves the record and leaves the total alone.
    await sendWebhook(refundEvent({ paymentId: duplicatePaymentId, refundId: `${P}-REFUND-1`, amountCents: 10_330 }));
    const resolved = await prisma.squareDuplicateCharge.findUniqueOrThrow({ where: { providerPaymentId: duplicatePaymentId } });
    assert(resolved.status === "RESOLVED" && resolved.resolvedAt !== null, "a full refund resolves the duplicate record");
    const voided = await prisma.payment.findFirstOrThrow({ where: { externalReference: duplicatePaymentId } });
    assert(voided.status === "VOIDED", "the held payment is voided");
    assert(await totalCents(fixture.registrationId) === 10_330 && await balanceCents(fixture.registrationId) === 0, "refunding the duplicate never reverses a fee it never added");

    // The embedded payment is untouched and still refundable by a human through the normal path.
    const winner = await prisma.payment.findUniqueOrThrow({ where: { id: valid[0]!.id } });
    assert(winner.status === "SUCCEEDED", "the first payment stays valid");
  }

  // ---- 5b. A hosted payment recorded first blocks the other paths; an embedded one in flight blocks a link. ----
  {
    const inFlight = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later" });
    square.embeddedMode = "UNAVAILABLE";
    await expectOperationError(payEmbedded(inFlight), "PAYMENT_RESULT_UNCERTAIN", "an unconfirmed embedded payment stays in flight");
    square.embeddedMode = "COMPLETED";
    await expectOperationError(createLink(inFlight), "PAYMENT_IN_PROGRESS", "a payment in flight refuses a link");
  }

  // ---- 6. An embedded payment racing a hosted webhook leaves exactly one valid payment. ----
  for (let round = 0; round < 5; round += 1) {
    const fixture = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later" });
    const { orderId } = await openLinkFor(fixture);
    const hostedPaymentId = `${P}-PAY-RACE-${round}`;
    const settled = await Promise.allSettled([
      sendWebhook(paymentEvent({ orderId, paymentId: hostedPaymentId, status: "COMPLETED", amountCents: 10_330 })),
      payEmbedded(fixture),
    ]);
    // A serialization conflict is answered with a retryable error, and the embedded caller retries.
    const embeddedSettled = settled[1]!;
    if (embeddedSettled.status === "rejected") {
      const reason = embeddedSettled.reason;
      assert(
        reason instanceof SquarePaymentOperationError
        && ["PAYMENT_ALREADY_COMPLETE", "PAYMENT_IN_PROGRESS", "PAYMENT_OPERATION_CONFLICT", "PAYMENT_RESULT_UNCERTAIN"].includes(reason.code),
        `the embedded side either wins or is refused cleanly (round ${round}): ${String(reason)}`,
      );
    }
    const hostedSettled = settled[0]!;
    assert(hostedSettled.status === "fulfilled", `the hosted webhook is processed (round ${round})`);
    const payments = await cardPayments(fixture.registrationId);
    const valid = payments.filter((payment) => payment.status === "SUCCEEDED");
    const held = payments.filter((payment) => payment.status === "PENDING");
    assert(valid.length === 1, `exactly one valid payment (round ${round}, got ${valid.length})`);
    assert(held.length === (await prisma.squareDuplicateCharge.count({ where: { registrationId: fixture.registrationId } })), `every extra charge is a duplicate record (round ${round})`);
    assert(await balanceCents(fixture.registrationId) === 0 && await totalCents(fixture.registrationId) === 10_330, `paid once, fee once (round ${round})`);
    assert(await receiptCount(fixture.registrationId) === 1, `one receipt (round ${round})`);
  }

  // ---- 7. A payment staff record withdraws the link; a late hosted payment no longer fits. ----
  {
    const fixture = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later" });
    const key = newKey();
    const first = await createLink(fixture, key);
    const { orderId, hosted } = await (async () => {
      const [row] = await hostedFor(fixture.registrationId);
      return { orderId: row!.providerOrderId!, hosted: row! };
    })();
    await recordManualPayment(fixture.eventId, fixture.registrationId, adminId, { amountCents: 3_000, method: "CASH", reference: "" });
    const [withdrawn] = await hostedFor(fixture.registrationId);
    assert(withdrawn!.status === "INVALIDATED" && withdrawn!.invalidationReason === "ANOTHER_PAYMENT_RECORDED", "recording a payment withdraws the open link");
    await waitFor(async () => (await prisma.squareHostedCheckout.findUniqueOrThrow({ where: { id: hosted.id } })).providerDeletedAt !== null, "the link is deleted at Square");
    await expectOperationError(createLink(fixture, key), "PAYMENT_ATTEMPT_FAILED", "replaying the withdrawn link's key is refused");
    const fresh = await createLink(fixture);
    assert(fresh.balanceCents === 7_000 && fresh.surchargeCents === 240 && fresh.amountCents === 7_240 && fresh.url !== first.url, "a new link is quoted on the new balance");

    await sendWebhook(paymentEvent({ orderId, paymentId: `${P}-PAY-LATE-1`, status: "COMPLETED", amountCents: 10_330 }));
    const record = await prisma.squareDuplicateCharge.findUniqueOrThrow({ where: { providerPaymentId: `${P}-PAY-LATE-1` } });
    assert(record.reason === "BALANCE_CHANGED", "a payment that no longer fits the balance is a duplicate");
    assert(await balanceCents(fixture.registrationId) === 7_000 && await totalCents(fixture.registrationId) === 10_000, "it counts for nothing and adds no fee");
  }

  // ---- 8. A cancelled registration's late hosted payment is held, not applied. ----
  {
    const fixture = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later" });
    const { orderId } = await openLinkFor(fixture);
    await prisma.registration.update({ where: { id: fixture.registrationId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    const swept = await sweepHostedCheckouts();
    assert(swept.withdrawn >= 1, "the sweep withdraws the cancelled registration's link");
    const [row] = await hostedFor(fixture.registrationId);
    assert(row!.status === "INVALIDATED" && row!.invalidationReason === "REGISTRATION_NOT_PAYABLE" && row!.providerDeletedAt !== null, "withdrawn and deleted at Square");
    await sendWebhook(paymentEvent({ orderId, paymentId: `${P}-PAY-CANCELLED`, status: "COMPLETED", amountCents: 10_330 }));
    const record = await prisma.squareDuplicateCharge.findUniqueOrThrow({ where: { providerPaymentId: `${P}-PAY-CANCELLED` } });
    assert(record.reason === "REGISTRATION_NOT_PAYABLE", "the late payment is held for staff");
    assert((await cardPayments(fixture.registrationId)).every((payment) => payment.status !== "SUCCEEDED"), "nothing is applied to a cancelled registration");
  }

  // ---- 9. Refund staleness: a growing balance still accepts the payment; a changed quote refuses a replay. ----
  {
    const replay = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later", cashPaidCents: 4_000 });
    const replayKey = newKey();
    const quoted = await createLink(replay, replayKey);
    assert(quoted.balanceCents === 6_000 && quoted.surchargeCents === 211 && quoted.amountCents === 6_211, "the link is quoted on what is owed after the cash payment");
    const cash = await prisma.payment.findFirstOrThrow({ where: { registrationId: replay.registrationId, method: "CASH" } });
    await recordRefund(replay.eventId, cash.id, adminId, { amountCents: 4_000, reason: "Synthetic refund", idempotencyKey: newKey() });
    await expectOperationError(createLink(replay, replayKey), "PAYMENT_ATTEMPT_FAILED", "after a refund the old quote is withdrawn on replay");
    const [stale] = await hostedFor(replay.registrationId);
    assert(stale!.status === "INVALIDATED" && stale!.invalidationReason === "BALANCE_CHANGED", "the stale link is withdrawn, not replayed");

    const accepted = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later", cashPaidCents: 4_000 });
    const { orderId } = await openLinkFor(accepted);
    const cashPayment = await prisma.payment.findFirstOrThrow({ where: { registrationId: accepted.registrationId, method: "CASH" } });
    await recordRefund(accepted.eventId, cashPayment.id, adminId, { amountCents: 4_000, reason: "Synthetic refund", idempotencyKey: newKey() });
    await sendWebhook(paymentEvent({ orderId, paymentId: `${P}-PAY-AFTER-REFUND`, status: "COMPLETED", amountCents: 6_211 }));
    const card = await cardPayments(accepted.registrationId);
    assert(card.length === 1 && card[0]!.status === "SUCCEEDED", "a payment that still fits the grown balance is recorded");
    assert(await totalCents(accepted.registrationId) === 10_211 && await balanceCents(accepted.registrationId) === 4_000, "the fee joined once and the rest is still owed");
  }

  // ---- 10. Expiry and provider-backed invalidation. ----
  {
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const expired = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later" });
    const key = newKey();
    await createLink(expired, key, longAgo);
    await expectOperationError(createLink(expired, key), "PAYMENT_ATTEMPT_FAILED", "an expired link's key is refused");
    const [row] = await hostedFor(expired.registrationId);
    assert(row!.status === "INVALIDATED" && row!.invalidationReason === "EXPIRED", "expired");
    await waitFor(async () => (await prisma.squareHostedCheckout.findUniqueOrThrow({ where: { id: row!.id } })).providerDeletedAt !== null, "an expired link is deleted at Square");

    const sweepOnly = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later" });
    await createLink(sweepOnly, newKey(), longAgo);
    square.deleteMode = "UNAVAILABLE";
    const failed = await sweepHostedCheckouts();
    assert(failed.withdrawn >= 1 && failed.failed >= 1, "a sweep withdraws the expired link and counts the Square failure");
    const [stuck] = await hostedFor(sweepOnly.registrationId);
    assert(stuck!.status === "INVALIDATED" && stuck!.providerDeletedAt === null && stuck!.providerDeleteError, "a failed deletion is remembered");
    square.deleteMode = "OK";
    const retried = await sweepHostedCheckouts();
    assert(retried.deleted >= 1, "the next sweep retries the deletion");
    const [done] = await hostedFor(sweepOnly.registrationId);
    assert(done!.providerDeletedAt !== null && done!.providerDeleteError === null, "and it clears");
    const calls = square.deleteCalls.length;
    await sweepHostedCheckouts();
    assert(square.deleteCalls.length === calls, "a deleted link is not deleted again");
  }

  // ---- 11. Not offered where it should not be. ----
  {
    const off = await createRegistration(events.off, { totalCents: 10_000, method: "Pay later" });
    const view = await getAttendeeSquareCheckout(access(off), { configuration });
    assert(view && "hostedLink" in view && view.hostedLink === false && view.state === "READY", "an event with the setting off shows only the embedded form");
    const before = square.createRequests;
    await expectOperationError(createLink(off), "PAYMENT_NOT_ELIGIBLE", "no link when the setting is off");
    assert(square.createRequests === before, "and Square is not asked");
    const church = await createRegistration(events.church, { totalCents: 10_000, method: "Pay later" });
    await expectOperationError(createLink(church), "PAYMENT_NOT_ELIGIBLE", "no link on a church-billed event");
  }

  // ---- 12. A webhook amount that is not the quote is ignored. ----
  {
    const fixture = await createRegistration(events.on, { totalCents: 10_000, method: "Pay later" });
    const { orderId } = await openLinkFor(fixture);
    const result = await sendWebhook(paymentEvent({ orderId, paymentId: `${P}-PAY-WRONG`, status: "COMPLETED", amountCents: 9_000 }));
    assert(result.status === "IGNORED", "a different amount is ignored");
    assert(await balanceCents(fixture.registrationId) === 10_000 && (await cardPayments(fixture.registrationId)).length === 0, "and applies nothing");
    assert((await prisma.auditLog.count({ where: { eventId: fixture.eventId, action: "SQUARE_WEBHOOK_AMOUNT_MISMATCH" } })) === 1, "with an audit entry");
  }

  console.log("Square hosted link verification passed.");
}

main()
  .then(async () => {
    await cleanup();
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    try {
      await cleanup();
    } finally {
      await prisma.$disconnect();
      process.exit(1);
    }
  });
