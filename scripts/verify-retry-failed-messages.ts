/**
 * Proves "Retry failed" (#860) against a real PostgreSQL database and a local stand-in for the email provider
 * (no network, no real address). It replays the Women's Retreat incident: a bulk "Email selected" send hit the
 * provider's daily quota partway through, so some recipients got the email and the rest ended as FAILED.
 *
 * - the provider's 429 `daily_quota_exceeded` is recorded as PROVIDER_QUOTA with the staff-readable reason, and a
 *   quota backs off in hours (a message with attempts left is rescheduled 2 hours out, not 1 minute);
 * - the preview of the batch lists only the failed messages and names every skip (an invoice email, a registration
 *   cancelled since), and a batch id from another event is not found;
 * - confirming queues exactly one new copy for each failed recipient and none for anyone who was sent the email;
 *   the request itself contacts no provider (the outbox worker sends the copies afterwards);
 * - a re-post of the same request, and a double click sent at the same moment, never add a second copy;
 * - after the worker sends the copies every recipient has received exactly one email, and a fresh preview offers
 *   nothing more to retry;
 * - the audit trail holds ids and counts only (no address).
 *
 * Uses fictitious rows only.
 *
 *   npm run test:retry-failed
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";

loadEnvConfig(process.cwd());
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-retry-failed-synthetic-key-not-a-secret");
fillBlankSyntheticEnv("MANAGE_LINK_DERIVATION_SECRET", "verify-retry-failed-synthetic-derivation-secret-01");
fillBlankSyntheticEnv("ATTENDEE_PASS_SIGNING_SECRET", "verify-retry-failed-synthetic-pass-signing-secret-01");
fillBlankSyntheticEnv("APP_BASE_URL", "http://localhost:3000");

const prisma = new PrismaClient();
const P = `rf860_${randomUUID().slice(0, 8)}`;
const ids = {
  staff: `${P}_staff`,
  event: `${P}_event`,
  other: `${P}_other`,
};
const EMAIL = (label: string) => `${P}.${label}@example.test`;
const eventIds = [ids.event, ids.other];
const GUEST_COUNT = 8;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

type StubState = { quotaExhausted: boolean; acceptLimit?: number; accepted: string[]; rejected: number };

/** Accepts every request while the quota is open and answers 429 daily_quota_exceeded once it is exhausted. */
function startProviderStub(state: StubState) {
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url !== "/emails" || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { to: string[] };
      if (state.quotaExhausted || (state.acceptLimit !== undefined && state.accepted.length >= state.acceptLimit)) {
        state.rejected += 1;
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ name: "daily_quota_exceeded", message: "You have reached your daily email sending quota." }));
        return;
      }
      state.accepted.push(...payload.to);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `stub_email_${state.accepted.length}` }));
    });
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => { server.close(() => done()); }) });
    });
  });
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: eventIds } }, { actorUserId: ids.staff }] } });
  await prisma.messageOutbox.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.eventMessageTemplate.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_p` } } });
  await prisma.user.deleteMany({ where: { id: ids.staff } });
}

async function main() {
  const state: StubState = { quotaExhausted: false, accepted: [], rejected: 0 };
  const stub = await startProviderStub(state);
  process.env.RESEND_API_KEY = "re_synthetic_stub_key";
  process.env.RESEND_API_URL = stub.url;
  try {
    await runChecks(state);
  } finally {
    await stub.close();
  }
}

async function runChecks(state: StubState) {
  const {
    enqueueSelectedAudienceBatch,
    ensureEventMessagingDefaults,
    getSelectedAudiencePreview,
    processPendingMessages,
  } = await import("@/modules/communications/messaging-repository");
  const { previewFailedMessagesRetry, retryFailedMessages } = await import("@/modules/communications/retry-failed");
  const { emailRetryDelayMs, PROVIDER_QUOTA_ERROR_CODE } = await import("@/modules/communications/email-delivery");

  await cleanup();
  await prisma.user.create({ data: { id: ids.staff, email: EMAIL("staff"), displayName: "Synthetic Staff" } });
  for (const [eventId, name] of [[ids.event, "Women's Retreat Verification"], [ids.other, "Another Synthetic Event"]] as const) {
    await prisma.event.create({
      data: { id: eventId, slug: `${eventId}-slug`, name, startsAt: new Date("2027-10-08T21:00:00Z"), endsAt: new Date("2027-10-10T17:00:00Z"), location: "Synthetic Camp" },
    });
  }
  await ensureEventMessagingDefaults(ids.event);
  await ensureEventMessagingDefaults(ids.other);
  await prisma.eventMessageSettings.update({
    where: { eventId: ids.event },
    data: { deliveryMode: "EXTERNAL_EMAIL", senderName: "IMSDA Events", senderEmail: EMAIL("sender") },
  });

  const registrationIds: string[] = [];
  for (let index = 1; index <= GUEST_COUNT; index += 1) {
    const personId = `${P}_p${index}`;
    await prisma.person.create({ data: { id: personId, firstName: `Guest${index}`, lastName: "Synthetic", normalizedEmail: EMAIL(`guest${index}`) } });
    const registration = await prisma.registration.create({
      data: {
        eventId: ids.event,
        accountHolderPersonId: personId,
        confirmationCode: `${P}-G${index}`.toUpperCase(),
        status: "CONFIRMED",
        totalAmount: "50.00",
        submittedAt: new Date("2027-09-01T10:00:00Z"),
        contactSnapshot: { firstName: `Guest${index}`, lastName: "Synthetic", email: EMAIL(`guest${index}`) },
      },
      select: { id: true },
    });
    registrationIds.push(registration.id);
  }

  // 1. The send: Email selected, welcome letter, every registration, in one batch.
  const batchId = randomUUID();
  const preview = await getSelectedAudiencePreview(ids.event, "EVENT_ANNOUNCEMENT", registrationIds);
  const queued = await enqueueSelectedAudienceBatch(ids.event, {
    batchId,
    templateKey: "EVENT_ANNOUNCEMENT",
    registrationIds,
    announcementTitle: "Welcome to the retreat",
    announcementBody: "We are glad you are coming.",
    previewFingerprint: preview.fingerprint,
  }, ids.staff);
  assert(queued.messageIds.length === GUEST_COUNT, `the welcome letter was queued for every guest (${queued.messageIds.length})`);

  // 2. The provider's daily quota runs out after four emails. One run of the worker: the fifth call is refused, the
  //    run stops there, and the three messages behind it are never tried (no attempt burned).
  const { processExternalEmailQueue } = await import("@/modules/communications/email-delivery");
  state.acceptLimit = 4;
  await processExternalEmailQueue(ids.event, {});
  state.acceptLimit = undefined;
  const afterRun = await prisma.messageOutbox.findMany({
    where: { eventId: ids.event, correlationId: batchId },
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true, attemptCount: true, availableAt: true, lastError: true, attempts: { select: { errorCode: true } } },
  });
  assert(state.accepted.length === 4 && state.rejected === 1, `four accepted and exactly one refused call, got ${state.accepted.length}/${state.rejected}`);
  const deferred = afterRun.filter((message) => message.attempts.length > 0 && message.status === "PENDING");
  const untouched = afterRun.filter((message) => message.attempts.length === 0 && message.status === "PENDING");
  assert(deferred.length === 1 && untouched.length === GUEST_COUNT - 5, `one message deferred and ${GUEST_COUNT - 5} untouched after the quota, got ${deferred.length}/${untouched.length}`);
  assert(untouched.every((message) => message.attemptCount === 0), "the queue behind the quota burned no attempt");
  assert(
    deferred[0]!.attempts[0]!.errorCode === PROVIDER_QUOTA_ERROR_CODE && deferred[0]!.attemptCount === 0
      && deferred[0]!.lastError === "The email provider's sending limit was reached. The message will be tried again later; staff can also retry it from the delivery log once the limit resets.",
    "the deferred message says, in words staff can read, that the provider's limit was reached, and the quota used no attempt",
  );
  const deferral = deferred[0]!.availableAt.getTime() - Date.now();
  assert(deferral > 2 * 60 * 60 * 1000 - 120_000 && deferral < 2 * 60 * 60 * 1000 + 120_000, `the quota backs off about two hours, got ${Math.round(deferral / 60_000)} minutes`);
  // The four messages the quota left unsent are marked FAILED, as the earlier worker version left them after its
  // five quick attempts (the state the incident left in production).
  await prisma.messageOutbox.updateMany({
    where: { id: { in: [deferred[0]!.id, ...untouched.map((message) => message.id)] } },
    data: { status: "FAILED", failedAt: new Date(), attemptCount: 5, lastError: "The email provider's sending limit was reached." },
  });
  const afterSend = await prisma.messageOutbox.findMany({
    where: { eventId: ids.event, correlationId: batchId },
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true, recipientEmail: true, lastError: true, registrationId: true },
  });
  const sent = afterSend.filter((message) => message.status === "SENT");
  const failed = afterSend.filter((message) => message.status === "FAILED");
  assert(sent.length === 4 && failed.length === GUEST_COUNT - 4, `four sent and four failed, got ${sent.length}/${failed.length}`);

  // 2b. A message on what used to be its last attempt survives a quota: it is rescheduled hours out, not failed.
  const retryLater = await prisma.messageOutbox.create({
    data: {
      eventId: ids.event, registrationId: registrationIds[0], templateKey: "CUSTOM_MESSAGE", recipientKind: "REGISTRANT",
      recipientEmail: EMAIL("guest1"), senderNameSnapshot: "IMSDA Events", senderEmailSnapshot: EMAIL("sender"),
      subjectSnapshot: "Backoff check", bodyTextSnapshot: "Backoff check", idempotencyKey: `${P}-backoff`, correlationId: `${P}-backoff`,
      attemptCount: 4,
    },
    select: { id: true },
  });
  state.quotaExhausted = true;
  const before = Date.now();
  await processExternalEmailQueue(ids.event, { messageIds: [retryLater.id], limit: 1 });
  const backedOff = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: retryLater.id }, select: { status: true, availableAt: true, attemptCount: true } });
  const delay = backedOff.availableAt.getTime() - before;
  assert(backedOff.status === "PENDING" && backedOff.attemptCount === 4, "a quota never ends a message, even on its last attempt");
  assert(delay >= 2 * 60 * 60 * 1000 - 60_000 && delay <= 2 * 60 * 60 * 1000 + 60_000, `a quota backs off about two hours, got ${Math.round(delay / 60_000)} minutes`);
  assert(emailRetryDelayMs(1) === 60_000, "another error still backs off one minute");
  await prisma.messageOutbox.delete({ where: { id: retryLater.id } });

  // 3. Things the retry must skip: an invoice email in the same batch, and a guest who cancelled since.
  await prisma.messageOutbox.create({
    data: {
      eventId: ids.event, templateKey: "INVOICE_DELIVERY", recipientKind: "REGISTRANT", recipientEmail: EMAIL("treasurer"),
      senderNameSnapshot: "IMSDA Events", senderEmailSnapshot: EMAIL("sender"), subjectSnapshot: "Invoice", bodyTextSnapshot: "Invoice",
      status: "FAILED", metadata: { batchId }, idempotencyKey: `${P}-invoice`, correlationId: batchId,
    },
  });
  const cancelledMessage = failed[failed.length - 1]!;
  await prisma.registration.update({ where: { id: cancelledMessage.registrationId! }, data: { status: "CANCELLED" } });

  // 4. Preview: only the failed ones, with the skips named. Another event cannot see this batch.
  const review = await previewFailedMessagesRetry(ids.event, { type: "BATCH", batchId });
  assert(review.failedCount === 5, `five failed in the batch, got ${review.failedCount}`);
  assert(review.eligibleCount === 3 && review.queueCount === 3 && review.remainingCount === 0, `three can be retried, got ${review.eligibleCount}`);
  const skipReasons = Object.fromEntries(review.skipped.map((item) => [item.reason, item.count]));
  assert(skipReasons.INVOICE === 1 && skipReasons.REGISTRATION_NOT_ACTIVE === 1, `the invoice and the cancelled guest are skipped: ${JSON.stringify(skipReasons)}`);
  assert(review.batches.length === 1 && review.batches[0]!.batchId === batchId, "the failed batch is listed for the picker");
  assert(!review.blocker, "nothing blocks a confirmation");
  let crossEvent = "";
  try {
    await previewFailedMessagesRetry(ids.other, { type: "BATCH", batchId });
  } catch (error) {
    crossEvent = (error as { code?: string }).code ?? "";
  }
  assert(crossEvent === "MESSAGE_NOT_FOUND", `another event's staff cannot reach this batch, got "${crossEvent}"`);
  assert((await previewFailedMessagesRetry(ids.other, { type: "EVENT" })).failedCount === 0, "another event has nothing to retry");

  // 5. Confirm. The provider has recovered, but the request itself must not send anything.
  state.quotaExhausted = false;
  const acceptedBefore = state.accepted.length;
  const clientRequestId = randomUUID();
  const input = { clientRequestId, scope: { type: "BATCH" as const, batchId }, previewFingerprint: review.fingerprint };
  const result = await retryFailedMessages(ids.event, input, ids.staff);
  assert(result.queuedCount === 3 && result.skippedCount === 2 && !result.replayed, `three queued and two skipped, got ${JSON.stringify(result)}`);
  assert(state.accepted.length === acceptedBefore, "the request itself contacted the provider zero times");
  const copies = await prisma.messageOutbox.findMany({
    where: { eventId: ids.event, retryOfMessageId: { not: null } },
    select: { id: true, status: true, retryOfMessageId: true, recipientEmail: true, subjectSnapshot: true, bodyTextSnapshot: true, registrationId: true, idempotencyKey: true },
  });
  assert(copies.length === 3 && copies.every((copy) => copy.status === "PENDING"), `three pending copies, got ${copies.length}`);
  const retriedSourceIds = new Set(copies.map((copy) => copy.retryOfMessageId));
  const failedWithActiveRegistration = failed.filter((message) => message.id !== cancelledMessage.id);
  assert(
    failedWithActiveRegistration.every((message) => retriedSourceIds.has(message.id)),
    "each failed guest with an active registration has a copy",
  );
  assert(!sent.some((message) => retriedSourceIds.has(message.id)), "no copy exists for anyone who was sent the email");
  assert(!retriedSourceIds.has(cancelledMessage.id), "no copy exists for the cancelled registration");
  const sourceById = new Map(afterSend.map((message) => [message.id, message]));
  assert(copies.every((copy) => copy.recipientEmail === sourceById.get(copy.retryOfMessageId!)!.recipientEmail), "each copy goes to its source's own recipient");
  assert(copies.every((copy) => copy.idempotencyKey.startsWith(`message-retry-failed:${ids.event}:${clientRequestId}:`)), "each copy has its own idempotency key under the request");

  // 6. A re-post of the same request and a double click made at the same moment add nothing.
  const replay = await retryFailedMessages(ids.event, input, ids.staff);
  assert(replay.replayed && replay.queuedCount === 3, "a re-post is answered from the record");
  const concurrentId = randomUUID();
  const concurrentInput = { ...input, clientRequestId: concurrentId };
  const settled = await Promise.allSettled([
    retryFailedMessages(ids.event, concurrentInput, ids.staff),
    retryFailedMessages(ids.event, concurrentInput, ids.staff),
  ]);
  assert(
    settled.every((outcome) => outcome.status === "rejected"
      ? ["PREVIEW_CHANGED", "EMPTY_AUDIENCE", "MESSAGE_NOT_RETRYABLE"].includes((outcome.reason as { code?: string }).code ?? "")
      : true),
    `a double click ends in a replay or a clean refusal: ${JSON.stringify(settled.map((outcome) => outcome.status === "rejected" ? (outcome.reason as { code?: string }).code : "ok"))}`,
  );
  const afterDouble = await prisma.messageOutbox.count({ where: { eventId: ids.event, retryOfMessageId: { not: null } } });
  assert(afterDouble === 3, `still exactly three copies after the re-post and the double click, got ${afterDouble}`);
  let stale = "";
  try {
    await retryFailedMessages(ids.event, { ...input, clientRequestId: randomUUID() }, ids.staff);
  } catch (error) {
    stale = (error as { code?: string }).code ?? "";
  }
  assert(stale === "PREVIEW_CHANGED", `an old preview cannot be confirmed again, got "${stale}"`);

  // 7. The outbox worker sends the copies: each recipient ends with exactly one email.
  await processPendingMessages(ids.event, ids.staff);
  const delivered = new Map<string, number>();
  for (const address of state.accepted) delivered.set(address, (delivered.get(address) ?? 0) + 1);
  const expectedRecipients = [...Array(GUEST_COUNT).keys()].map((index) => EMAIL(`guest${index + 1}`))
    .filter((address) => address !== cancelledMessage.recipientEmail);
  assert(
    expectedRecipients.every((address) => delivered.get(address) === 1),
    `each guest with an active registration got exactly one email: ${JSON.stringify([...delivered.entries()])}`,
  );
  assert(!delivered.has(cancelledMessage.recipientEmail), "the guest who cancelled got nothing");
  assert(state.accepted.length === GUEST_COUNT - 1, `${GUEST_COUNT - 1} emails in all, got ${state.accepted.length}`);
  const finished = await prisma.messageOutbox.count({ where: { eventId: ids.event, retryOfMessageId: { not: null }, status: "SENT" } });
  assert(finished === 3, `the three copies were sent, got ${finished}`);

  // 8. Nothing is left to retry in the batch except what was skipped.
  const after = await previewFailedMessagesRetry(ids.event, { type: "BATCH", batchId });
  const afterReasons = Object.fromEntries(after.skipped.map((item) => [item.reason, item.count]));
  assert(after.eligibleCount === 0 && afterReasons.ALREADY_RETRIED === 3, `a fresh preview offers nothing: ${JSON.stringify(afterReasons)}`);
  let empty = "";
  try {
    await retryFailedMessages(ids.event, { clientRequestId: randomUUID(), scope: { type: "BATCH", batchId }, previewFingerprint: after.fingerprint }, ids.staff);
  } catch (error) {
    empty = (error as { code?: string }).code ?? "";
  }
  assert(empty === "EMPTY_AUDIENCE", `confirming an empty retry is refused, got "${empty}"`);
  assert((await prisma.messageOutbox.count({ where: { eventId: ids.event, retryOfMessageId: { not: null } } })) === 3, "still exactly three copies");

  // 9. The audit rows hold ids and counts only.
  const audits = await prisma.auditLog.findMany({ where: { eventId: ids.event, action: "MESSAGE_RETRY_FAILED_ENQUEUED" } });
  assert(audits.length === 1, `one audit row for the confirmed retry, got ${audits.length}`);
  assert(!JSON.stringify(audits).includes("@example.test"), "the audit row holds no address");

  // 9b. Retry trees and the recipient guard, against the real tables. A fails; B is a bulk copy of A that also failed;
  //     C is a single retry of A that was sent: nothing in the tree may be retried. A separate later send to the same
  //     person also blocks a failed message of that template.
  const treeBatch = `${P}-tree-batch`;
  const treeRow = (key: string, extra: Record<string, unknown>) => ({
    eventId: ids.event, registrationId: registrationIds[0], templateKey: "CUSTOM_MESSAGE" as const, recipientKind: "REGISTRANT" as const,
    recipientEmail: EMAIL("guest1"), senderNameSnapshot: "IMSDA Events", senderEmailSnapshot: EMAIL("sender"),
    subjectSnapshot: "Tree check", bodyTextSnapshot: "Tree check", idempotencyKey: `${P}-tree-${key}`, correlationId: `${P}-tree-${key}`,
    metadata: { batchId: treeBatch }, ...extra,
  });
  const treeA = await prisma.messageOutbox.create({ data: treeRow("a", { status: "FAILED", failedAt: new Date(), createdAt: new Date(Date.now() - 3 * 3600_000) }), select: { id: true } });
  await prisma.messageOutbox.create({ data: treeRow("b", { status: "FAILED", failedAt: new Date(), retryOfMessageId: treeA.id, createdAt: new Date(Date.now() - 2 * 3600_000) }) });
  await prisma.messageOutbox.create({ data: treeRow("c", { status: "SENT", sentAt: new Date(), retryOfMessageId: treeA.id, createdAt: new Date(Date.now() - 3600_000) }) });
  const sibling = await previewFailedMessagesRetry(ids.event, { type: "BATCH", batchId: treeBatch });
  assert(sibling.failedCount === 2 && sibling.eligibleCount === 0, `a failed sibling of a sent single retry is not retried: ${JSON.stringify(sibling.skipped)}`);
  const laterBatch = `${P}-later-batch`;
  await prisma.messageOutbox.create({ data: treeRow("later-failed", { status: "FAILED", failedAt: new Date(), registrationId: registrationIds[1], recipientEmail: EMAIL("guest2"), metadata: { batchId: laterBatch }, createdAt: new Date(Date.now() - 4 * 3600_000) }) });
  await prisma.messageOutbox.create({ data: treeRow("later-sent", { status: "SENT", sentAt: new Date(), registrationId: registrationIds[1], recipientEmail: EMAIL("guest2").toUpperCase(), metadata: { batchId: `${P}-another-send` }, createdAt: new Date(Date.now() - 3600_000) }) });
  const later = await previewFailedMessagesRetry(ids.event, { type: "BATCH", batchId: laterBatch });
  assert(later.eligibleCount === 0 && later.skipped.some((item) => item.reason === "LATER_DELIVERY"), `a later separate send blocks the retry: ${JSON.stringify(later.skipped)}`);

  // 9c. Two simultaneous confirmations of one fresh preview, two ways: the same request id twice (a double click) and
  //     two different ids (two tabs). Either way every source message ends with exactly one copy.
  for (const [label, sameId] of [["double click", true], ["two tabs", false]] as const) {
    const group = `${P}-concurrent-${sameId ? "same" : "different"}`;
    const sources: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const created = await prisma.messageOutbox.create({
        data: treeRow(`${group}-${index}`, { status: "FAILED", failedAt: new Date(), registrationId: registrationIds[2 + index], recipientEmail: EMAIL(`guest${3 + index}`), metadata: { batchId: group } }),
        select: { id: true },
      });
      sources.push(created.id);
    }
    const fresh = await previewFailedMessagesRetry(ids.event, { type: "BATCH", batchId: group });
    assert(fresh.eligibleCount === 4, `the ${label} preview offers four, got ${fresh.eligibleCount}`);
    const sharedId = randomUUID();
    const outcomes = await Promise.allSettled([0, 1].map(() => retryFailedMessages(
      ids.event,
      { clientRequestId: sameId ? sharedId : randomUUID(), scope: { type: "BATCH", batchId: group }, previewFingerprint: fresh.fingerprint },
      ids.staff,
    )));
    const refusals = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [(outcome.reason as { code?: string }).code ?? "ERROR"] : []);
    assert(refusals.every((code) => ["PREVIEW_CHANGED", "EMPTY_AUDIENCE", "MESSAGE_NOT_RETRYABLE"].includes(code)), `the ${label} refusal is clean: ${JSON.stringify(refusals)}`);
    assert(outcomes.some((outcome) => outcome.status === "fulfilled"), `one of the two ${label} requests succeeded: ${JSON.stringify(refusals)}`);
    for (const sourceId of sources) {
      const count = await prisma.messageOutbox.count({ where: { retryOfMessageId: sourceId } });
      assert(count === 1, `exactly one copy of each source after the ${label}, got ${count}`);
    }
  }

  // 10. Delivery turned off: the preview says so and a confirmation is refused.
  await prisma.eventMessageSettings.update({ where: { eventId: ids.event }, data: { deliveryMode: "DISABLED" } });
  const off = await previewFailedMessagesRetry(ids.event, { type: "EVENT" });
  assert(off.blocker?.code === "DELIVERY_DISABLED", "with delivery off the preview blocks a retry");

  console.log(`Retry failed verification passed: ${state.accepted.length} emails, ${state.rejected} quota rejections, ${copies.length} retry copies.`);
}

main()
  .then(async () => {
    await cleanup();
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(1);
  });
