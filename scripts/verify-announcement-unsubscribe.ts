/**
 * Proves unsubscribe and email preferences for event announcements (#838) against a real PostgreSQL database and a
 * local stand-in for the email provider (no network, no real address):
 *
 * - an opt-out recorded through the public one-click endpoint (RFC 8058: no login, no CSRF token) or the page's
 *   buttons skips that address in the broadcast review and in the send, for this event or for all events, and the
 *   review counts who is skipped and why; an opt-out for another event changes nothing;
 * - an address that opts out after the broadcast was queued is still skipped at delivery, with a recorded reason and
 *   an audit row that never holds the address;
 * - an announcement an event manager marked essential (audited, with the actor) reaches opted-out addresses, and the
 *   review says how many;
 * - registration messages (a payment receipt) are never affected by an opt-out, and carry no unsubscribe link;
 * - announcements reach the provider with List-Unsubscribe and List-Unsubscribe-Post headers, and an unsubscribe link
 *   in the body, whose signed token names the recipient and the event and nothing else;
 * - an altered token is refused and records nothing, a GET records nothing, and re-subscribing clears the opt-out;
 * - staff can list who opted out of an event.
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:announcement-unsubscribe
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
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-announcement-unsubscribe-synthetic-key-not-a-secret");
fillBlankSyntheticEnv("MANAGE_LINK_DERIVATION_SECRET", "verify-announcement-unsubscribe-synthetic-derivation-secret-01");
fillBlankSyntheticEnv("ATTENDEE_PASS_SIGNING_SECRET", "verify-announcement-unsubscribe-synthetic-pass-signing-secret-01");
process.env.APP_BASE_URL = "https://events.example.test";

type ProviderPayload = {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
};

const prisma = new PrismaClient();
const P = `an838_${randomUUID().slice(0, 8)}`;
const ids = {
  staff: `${P}_staff`,
  manager: `${P}_manager`,
  event: `${P}_event`,
  other: `${P}_other`,
  announcement: `${P}_announcement`,
};
const people = ["a", "b", "c", "d"].map((letter) => ({
  letter,
  personId: `${P}_p${letter}`,
  email: `${P}.${letter}@example.test`,
  code: `${P}-${letter}`.toUpperCase(),
}));
const [A, B, C, D] = people;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

/** The provider stand-in: accepts every POST /emails and keeps what it was sent. */
function startProviderStub() {
  const received: ProviderPayload[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url === "/emails" && request.method === "POST") received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderPayload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `stub_email_${received.length}` }));
    });
  });
  return new Promise<{ url: string; received: ProviderPayload[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, received, close: () => new Promise((done) => { server.close(() => done()); }) });
    });
  });
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: [ids.event, ids.other] } }, { actorUserId: { in: [ids.staff, ids.manager] } }] } });
  await prisma.emailAnnouncementOptOut.deleteMany({ where: { normalizedEmail: { in: people.map((person) => person.email) } } });
  await prisma.messageOutbox.deleteMany({ where: { eventId: { in: [ids.event, ids.other] } } });
  await prisma.announcement.deleteMany({ where: { eventId: { in: [ids.event, ids.other] } } });
  await prisma.eventMessageTemplate.deleteMany({ where: { eventId: { in: [ids.event, ids.other] } } });
  await prisma.event.deleteMany({ where: { id: { in: [ids.event, ids.other] } } });
  await prisma.person.deleteMany({ where: { id: { in: people.map((person) => person.personId) } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.staff, ids.manager] } } });
}

async function main() {
  const stub = await startProviderStub();
  process.env.RESEND_API_KEY = "re_synthetic_stub_key";
  process.env.RESEND_API_URL = stub.url;
  try {
    await runChecks(stub);
  } finally {
    await stub.close();
  }
}

async function runChecks(stub: Awaited<ReturnType<typeof startProviderStub>>) {
  // Imported after the environment is set, as the delivery code reads it when it runs.
  const { broadcastPublishedAnnouncement, previewAnnouncementBroadcast } = await import("@/modules/communications/announcement-broadcast");
  const { setAnnouncementEssential } = await import("@/modules/communications/announcement-essential");
  const { processExternalEmailQueue } = await import("@/modules/communications/email-delivery");
  const { issueUnsubscribeToken, listEventAnnouncementOptOuts, resolveUnsubscribeToken } = await import("@/modules/communications/email-preferences-repository");
  const { createMessageRetryCopy } = await import("@/modules/communications/messaging-repository");
  const { deriveUnsubscribeToken } = await import("@/modules/communications/email-preferences");
  const { ensureEventMessagingDefaults } = await import("@/modules/communications/messaging-repository");
  const { enqueuePaymentReceiptMessage } = await import("@/modules/communications/transactional-messages");
  const route = await import("@/app/api/public/unsubscribe/[token]/route");

  await cleanup();
  await prisma.user.createMany({
    data: [
      { id: ids.staff, email: `${P}.staff@example.test`, displayName: "Synthetic Staff" },
      { id: ids.manager, email: `${P}.manager@example.test`, displayName: "Synthetic Manager" },
    ],
  });
  await prisma.person.createMany({
    data: people.map((person) => ({ id: person.personId, firstName: `Person ${person.letter.toUpperCase()}`, lastName: "Synthetic", normalizedEmail: person.email })),
  });
  for (const [eventId, slug] of [[ids.event, "event"], [ids.other, "other"]] as const) {
    await prisma.event.create({
      data: {
        id: eventId, slug: `${P}-${slug}`, name: `Unsubscribe Verification ${slug}`,
        startsAt: new Date("2027-10-08T21:00:00Z"), endsAt: new Date("2027-10-10T17:00:00Z"), location: "Synthetic Camp",
      },
    });
  }
  const registrationIds: Record<string, string> = {};
  for (const person of people) {
    const registration = await prisma.registration.create({
      data: {
        eventId: ids.event, accountHolderPersonId: person.personId, confirmationCode: person.code, status: "CONFIRMED",
        totalAmount: "50.00", submittedAt: new Date("2027-09-01T10:00:00Z"),
        contactSnapshot: { firstName: `Person ${person.letter.toUpperCase()}`, lastName: "Synthetic", email: person.email },
      },
      select: { id: true },
    });
    registrationIds[person.letter] = registration.id;
    await prisma.registrationAttendee.create({
      data: {
        eventId: ids.event, registrationId: registration.id, personId: person.personId, attendeeType: "ADULT", position: 0,
        profileSnapshot: { firstName: `Person ${person.letter.toUpperCase()}`, lastName: "Synthetic" },
      },
    });
  }
  await prisma.announcement.create({
    data: {
      id: ids.announcement, eventId: ids.event, createdByUserId: ids.staff, title: "Saturday schedule update",
      body: "Doors open at 3 PM.", audience: { type: "ALL_ATTENDEES" }, placement: "HOME_BANNER", status: "PUBLISHED", publishedAt: new Date(),
    },
  });
  await ensureEventMessagingDefaults(ids.event);
  await prisma.eventMessageSettings.update({
    where: { eventId: ids.event },
    data: { deliveryMode: "EXTERNAL_EMAIL", senderEmail: "events@example.test", senderName: "Synthetic Events" },
  });

  const call = (token: string, body: string) => route.POST(
    // No Origin header, no cookie, no CSRF token: what a mail client's one-click POST looks like.
    new Request(`https://events.example.test/api/public/unsubscribe/${token}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
    }),
    { params: Promise.resolve({ token }) },
  );
  // An issued token, as delivery issues one: opaque, and recorded so it can be looked up.
  const tokenFor = (email: string, eventId = ids.event) => issueUnsubscribeToken(prisma, { email, eventId });
  const optOutCount = () => prisma.emailAnnouncementOptOut.count({ where: { normalizedEmail: { in: people.map((person) => person.email) } } });

  // 1. Opt-outs through the public endpoint, with no login. A: one-click (this event). B: the page's "all" button.
  // D: one-click for ANOTHER event, which must not affect this one.
  const oneClick = await call(await tokenFor(A.email), "List-Unsubscribe=One-Click");
  assert(oneClick.status === 200, `one-click POST is accepted without a login: ${oneClick.status}`);
  const all = await call(await tokenFor(B.email), "action=all");
  assert(all.status === 303, "the page's all-announcements button redirects back to the page");
  await call(await tokenFor(D.email, ids.other), "List-Unsubscribe=One-Click");
  assert((await optOutCount()) === 3, "three opt-outs recorded");
  const rows = await prisma.emailAnnouncementOptOut.findMany({ where: { normalizedEmail: A.email }, select: { scope: true, eventId: true, source: true } });
  assert(rows.length === 1 && rows[0].scope === "EVENT" && rows[0].eventId === ids.event && rows[0].source === "ONE_CLICK", `A's opt-out is for this event: ${JSON.stringify(rows)}`);

  // An unknown or altered token and a GET record nothing. C's token has not been issued yet (no mail has gone to C).
  const issuedForA = await tokenFor(A.email);
  const neverIssued = deriveUnsubscribeToken({ email: C.email, eventId: ids.event });
  const flipped = `${issuedForA.slice(0, 42)}${issuedForA.endsWith("A") ? "B" : "A"}`;
  for (const bad of [neverIssued, flipped, "garbage", issuedForA.slice(1)]) {
    const refused = await call(bad, "List-Unsubscribe=One-Click");
    assert(refused.status === 404, `an unknown or altered token is refused: ${refused.status}`);
  }
  assert(!issuedForA.includes(A.email) && !issuedForA.includes(ids.event) && !issuedForA.includes("."), "the token is opaque");
  assert((await prisma.emailUnsubscribeToken.count({ where: { tokenHash: issuedForA } })) === 0, "the stored value is a hash, never the token");
  const got = await route.GET(new Request("https://events.example.test/x"), { params: Promise.resolve({ token: issuedForA }) });
  assert(got.status === 303, "a GET on a valid link only redirects to the page");
  const gotBad = await route.GET(new Request("https://events.example.test/x"), { params: Promise.resolve({ token: neverIssued }) });
  assert(gotBad.status === 404, "a GET on an unknown token is a 404");
  // RFC 8058 allows multipart/form-data as well as urlencoded.
  const multipart = new FormData();
  multipart.set("List-Unsubscribe", "One-Click");
  const viaMultipart = await route.POST(
    new Request(`https://events.example.test/api/public/unsubscribe/${issuedForA}`, { method: "POST", body: multipart }),
    { params: Promise.resolve({ token: issuedForA }) },
  );
  assert(viaMultipart.status === 200, `a multipart one-click POST is accepted: ${viaMultipart.status}`);
  assert((await optOutCount()) === 3, "an unknown token and a GET recorded nothing, and the repeat for A added nothing");

  // 2. The review counts who is skipped and why; D (another event's opt-out) is still a recipient.
  const preview = await previewAnnouncementBroadcast({ eventId: ids.event, announcementId: ids.announcement });
  assert(
    preview.activeRegistrationCount === 4 && preview.recipientCount === 2
      && preview.skippedOptedOutCount === 2 && preview.skippedOptedOutEventCount === 1 && preview.skippedOptedOutAllCount === 1
      && !preview.essential,
    `the review counts the opt-outs: ${JSON.stringify(preview)}`,
  );
  const listed = await listEventAnnouncementOptOuts(ids.event);
  assert(
    listed.length === 2 && listed.some((row) => row.email === A.email && row.scope === "EVENT") && listed.some((row) => row.email === B.email && row.scope === "ALL"),
    `staff can list who opted out: ${JSON.stringify(listed)}`,
  );

  // 3. The send queues only C and D, and says which were skipped.
  const batch1 = randomUUID();
  const sent1 = await broadcastPublishedAnnouncement({
    eventId: ids.event, announcementId: ids.announcement, batchId: batch1, previewFingerprint: preview.fingerprint, actorUserId: ids.staff,
  });
  assert(sent1.messageCount === 2 && sent1.skippedCount === 2 && sent1.optedOutCount === 2, `two queued, two skipped: ${JSON.stringify(sent1)}`);
  const queued = await prisma.messageOutbox.findMany({ where: { eventId: ids.event, templateKey: "EVENT_ANNOUNCEMENT", correlationId: batch1 }, select: { id: true, recipientEmail: true, status: true, metadata: true } });
  assert(queued.map((row) => row.recipientEmail).sort().join() === [C.email, D.email].sort().join(), "only C and D were queued");
  const broadcastAudit = await prisma.auditLog.findFirstOrThrow({ where: { eventId: ids.event, action: "EVENT_ANNOUNCEMENT_BROADCAST_ENQUEUED", correlationId: batch1 }, select: { metadata: true } });
  const auditMeta = broadcastAudit.metadata as Record<string, unknown>;
  assert(auditMeta.skippedOptedOutCount === 2 && auditMeta.skippedOptedOutEventCount === 1 && auditMeta.skippedOptedOutAllCount === 1, "the audit row records the skipped opt-outs");
  assert(!JSON.stringify(broadcastAudit.metadata).includes("@example.test"), "the audit row holds no address");

  // The broadcast sends inline for a real-email event with no files: C and D were delivered, each with the headers.
  assert(stub.received.length === 2 && stub.received.map((payload) => payload.to[0]).sort().join() === [C.email, D.email].sort().join(), "the provider got exactly C and D");

  // 4. A message still waiting when its recipient opts out (a worker backlog) is skipped at delivery, with a reason.
  const source = await prisma.messageOutbox.findFirstOrThrow({ where: { eventId: ids.event, recipientEmail: D.email, templateKey: "EVENT_ANNOUNCEMENT" } });
  const copy: Record<string, unknown> = { ...source };
  for (const key of ["id", "createdAt", "updatedAt"]) delete copy[key];
  const waiting = await prisma.messageOutbox.create({
    data: {
      ...(copy as Omit<typeof source, "id" | "createdAt" | "updatedAt">),
      metadata: source.metadata ?? undefined,
      idempotencyKey: `${P}-waiting`,
      providerMessageId: null,
      status: "PENDING",
      attemptCount: 0,
      availableAt: new Date(Date.now() - 1000),
      sentAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      providerDeliveryStatus: null,
      providerStatusAt: null,
      deliveredAt: null,
      capturedAt: null,
      provider: null,
    },
    select: { id: true },
  });
  await call(await tokenFor(D.email), "List-Unsubscribe=One-Click");
  const run1 = await processExternalEmailQueue(ids.event, { messageIds: [waiting.id] });
  assert(run1.sentIds.length === 0 && stub.received.length === 2, `nothing was sent to D: ${JSON.stringify(run1)}`);
  const skippedRow = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: waiting.id }, select: { id: true, status: true, lastError: true } });
  assert(skippedRow.status === "SUPPRESSED" && /opted out/i.test(skippedRow.lastError ?? ""), `D's waiting message is suppressed with a reason: ${JSON.stringify(skippedRow)}`);
  const skipAudit = await prisma.auditLog.findFirstOrThrow({ where: { eventId: ids.event, action: "EVENT_ANNOUNCEMENT_SKIPPED_OPTED_OUT", entityId: skippedRow.id }, select: { metadata: true, summary: true } });
  assert(!JSON.stringify(skipAudit).includes("@example.test"), "the skip audit row holds no address");

  // 5. Headers and body link on the announcement that was sent.
  const first = stub.received.find((payload) => payload.to[0] === C.email);
  assert(first, "C's message reached the provider");
  assert(first.headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click", `one-click post header: ${JSON.stringify(first.headers)}`);
  const listUnsubscribe = first.headers?.["List-Unsubscribe"] ?? "";
  const urlMatch = /^<(https:\/\/events\.example\.test\/api\/public\/unsubscribe\/([^>]+))>$/.exec(listUnsubscribe);
  assert(urlMatch, `List-Unsubscribe header carries the signed https URL: ${listUnsubscribe}`);
  assert(JSON.stringify(await resolveUnsubscribeToken(urlMatch[2])) === JSON.stringify({ email: C.email, eventId: ids.event }), "the issued token resolves to C and this event");
  assert(/^[A-Za-z0-9_-]{43}$/.test(urlMatch[2]) && !urlMatch[2].includes(C.email) && !urlMatch[2].includes(ids.event) && !urlMatch[2].includes(registrationIds.c), "the token is opaque: no address, event or registration data");
  assert(!first.headers?.["List-Unsubscribe"]?.includes("@"), "no address in the header");
  assert(first.text.includes(`https://events.example.test/unsubscribe/${urlMatch[2]}`), "the text body links to the unsubscribe page");
  assert((first.html ?? "").includes(`/unsubscribe/${urlMatch[2]}`), "the HTML body links to the unsubscribe page");
  const stored = await prisma.messageOutbox.findFirstOrThrow({ where: { recipientEmail: C.email, templateKey: "EVENT_ANNOUNCEMENT" }, select: { bodyTextSnapshot: true, bodyHtmlSnapshot: true } });
  assert(!stored.bodyTextSnapshot.includes("/unsubscribe/") && !(stored.bodyHtmlSnapshot ?? "").includes("/unsubscribe/"), "the stored snapshot never holds the link");
  // The one-click POST to that header URL opts C out of this event only.
  const viaHeader = await call(urlMatch[2], "List-Unsubscribe=One-Click");
  assert(viaHeader.status === 200, "the header URL accepts the one-click POST");
  assert((await prisma.emailAnnouncementOptOut.count({ where: { normalizedEmail: C.email, scope: "EVENT", eventId: ids.event } })) === 1, "C is opted out of this event");

  // 6. Essential: marked by an event manager, audited, it reaches everyone who opted out.
  const marked = await setAnnouncementEssential(ids.event, ids.announcement, ids.manager, true);
  assert(marked?.isEssential === true && marked.changed, "the announcement is marked essential");
  const essentialAudit = await prisma.auditLog.findFirstOrThrow({ where: { eventId: ids.event, action: "ANNOUNCEMENT_MARKED_ESSENTIAL", entityId: ids.announcement }, select: { actorUserId: true } });
  assert(essentialAudit.actorUserId === ids.manager, "marking essential is audited with who did it");
  const essentialPreview = await previewAnnouncementBroadcast({ eventId: ids.event, announcementId: ids.announcement });
  assert(
    essentialPreview.essential && essentialPreview.recipientCount === 4 && essentialPreview.skippedOptedOutCount === 0 && essentialPreview.essentialOptedOutReachedCount === 4,
    `the review says it reaches the opted-out: ${JSON.stringify(essentialPreview)}`,
  );
  assert(essentialPreview.fingerprint !== preview.fingerprint, "marking essential changes the review fingerprint");
  const beforeEssential = stub.received.length;
  const batch2 = randomUUID();
  await broadcastPublishedAnnouncement({
    eventId: ids.event, announcementId: ids.announcement, batchId: batch2, previewFingerprint: essentialPreview.fingerprint, actorUserId: ids.staff,
  });
  // Sent inline by the broadcast, as for any real-email event with no files.
  const before = beforeEssential;
  assert(stub.received.length === before + 4, `the essential broadcast sent four messages: ${stub.received.length - before}`);
  const essentialTo = stub.received.slice(before).map((payload) => payload.to[0]).sort().join();
  assert(essentialTo === people.map((person) => person.email).sort().join(), `essential reached everyone: ${essentialTo}`);
  assert(stub.received.slice(before).every((payload) => payload.headers?.["List-Unsubscribe"]), "essential announcements still carry the unsubscribe headers");

  // 6b. The decision is made at delivery from the announcement as it is now, and a retry copy keeps its announcement id.
  const sentToD = await prisma.messageOutbox.findFirstOrThrow({ where: { eventId: ids.event, correlationId: batch2, recipientEmail: D.email } });
  assert((sentToD.metadata as Record<string, unknown>).announcementId === ids.announcement, "the message is tied to its announcement");
  const settings = { deliveryMode: "EXTERNAL_EMAIL", senderName: "Synthetic Events", senderEmail: "events@example.test", replyToEmail: null };
  const copyOf = (key: string) => prisma.$transaction((tx) => createMessageRetryCopy(tx, {
    eventId: ids.event, source: sentToD, settings, repairMissingSenderSnapshot: false,
    idempotencyKey: `${P}-${key}`, correlationId: randomUUID(), requestFingerprint: `${P}-${key}`,
  }));
  const copy1 = await copyOf("copy1");
  assert(
    ((await prisma.messageOutbox.findUniqueOrThrow({ where: { id: copy1.id }, select: { metadata: true } })).metadata as Record<string, unknown>).announcementId === ids.announcement,
    "the retry copy keeps the announcement id",
  );
  const beforeCopies = stub.received.length;
  await setAnnouncementEssential(ids.event, ids.announcement, ids.manager, false);
  await processExternalEmailQueue(ids.event, { messageIds: [copy1.id] });
  const cleared = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: copy1.id }, select: { status: true } });
  assert(cleared.status === "SUPPRESSED" && stub.received.length === beforeCopies, `clearing the mark applies to a message already queued: ${cleared.status}`);
  await setAnnouncementEssential(ids.event, ids.announcement, ids.manager, true);
  const copy2 = await copyOf("copy2");
  const run2b = await processExternalEmailQueue(ids.event, { messageIds: [copy2.id] });
  assert(run2b.sentIds.includes(copy2.id) && stub.received.length === beforeCopies + 1 && stub.received[beforeCopies].to[0] === D.email, "a retry of an essential announcement reaches the opted-out address");

  // 7. Registration messages are never affected: a payment receipt to B, who opted out of everything.
  await prisma.$transaction(async (tx) => {
    await enqueuePaymentReceiptMessage(tx, {
      eventId: ids.event, registrationId: registrationIds.b, paymentId: `${P}_payment`, amountCents: 5000, providerPaymentId: `${P}_provider_payment`,
    });
  });
  const receipt = await prisma.messageOutbox.findFirstOrThrow({ where: { eventId: ids.event, recipientEmail: B.email, templateKey: "PAYMENT_RECEIPT" }, select: { id: true } });
  const beforeReceipt = stub.received.length;
  const run3 = await processExternalEmailQueue(ids.event, { messageIds: [receipt.id] });
  assert(run3.sentIds.includes(receipt.id) && stub.received.length === beforeReceipt + 1, "the receipt reached B, who opted out of all announcements");
  const receiptPayload = stub.received[beforeReceipt];
  assert(!receiptPayload.headers?.["List-Unsubscribe"] && !receiptPayload.text.includes("/unsubscribe/") && !(receiptPayload.html ?? "").includes("/unsubscribe/"), `a receipt carries no unsubscribe link or header: ${JSON.stringify(receiptPayload).slice(0, 600)}`);

  // 8. Re-subscribe from the page clears the opt-outs; a later review counts them as recipients again.
  const resub = await call(await tokenFor(B.email), "action=resubscribe");
  assert(resub.status === 303, "re-subscribing redirects back to the page");
  assert((await prisma.emailAnnouncementOptOut.count({ where: { normalizedEmail: B.email } })) === 0, "B's opt-out is gone");
  await setAnnouncementEssential(ids.event, ids.announcement, ids.manager, false);
  const finalPreview = await previewAnnouncementBroadcast({ eventId: ids.event, announcementId: ids.announcement });
  assert(finalPreview.recipientCount === 1 && finalPreview.skippedOptedOutCount === 3, `after re-subscribing B: ${JSON.stringify(finalPreview)}`);

  console.log("announcement unsubscribe verification passed");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch((error: unknown) => {
      console.error("cleanup failed", error);
      process.exitCode = 1;
    });
    await prisma.$disconnect();
  });
