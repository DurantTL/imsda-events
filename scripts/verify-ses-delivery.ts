/**
 * Proves email delivery through Amazon SES over SMTP (#861) against a real PostgreSQL database and a local SMTP
 * stand-in for SES (no network, no AWS, no real address). `EMAIL_PROVIDER=ses` is set for the whole run:
 *
 * - an announcement with a file attachment, an uploaded picture, and one check-in QR per attendee goes through the
 *   outbox worker as one MIME message: the attachment, the inline picture and each attendee's QR (with Content-IDs the
 *   HTML refers to as cid:), the reply-to, and a stable X-IMSDA-Message-Id;
 * - the first attempt meets SES throttling (454) and is rescheduled as PROVIDER_RATE_LIMITED, the second the daily quota
 *   (454) and is rescheduled as PROVIDER_QUOTA, and the third is accepted, with the provider recorded as SES;
 * - a 554 "Email address is not verified" fails the message for good with a staff-readable error and no retry;
 * - an authentication failure (535) is a configuration error, and a server that offers no STARTTLS is refused
 *   (retryable) with nothing sent.
 *
 * Uses fictitious rows and a temporary storage directory it creates and removes itself. The stand-in's certificate is
 * self-signed, so this process (and only this process) turns certificate checking off.
 *
 *   npm run test:ses-delivery
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { SMTPServer } from "smtp-server";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";

loadEnvConfig(process.cwd());
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-ses-delivery-synthetic-key-not-a-secret");
fillBlankSyntheticEnv("MANAGE_LINK_DERIVATION_SECRET", "verify-ses-delivery-synthetic-derivation-secret-0001");
fillBlankSyntheticEnv("ATTENDEE_PASS_SIGNING_SECRET", "verify-ses-delivery-synthetic-pass-signing-secret-0001");
fillBlankSyntheticEnv("APP_BASE_URL", "http://localhost:3000");
// The stand-in presents a self-signed certificate. Local to this verification process.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const SMTP_USER = "synthetic-smtp-user";
const SMTP_PASSWORD = "synthetic-smtp-password";

type Reply = { code: number; text: string } | "accept";
type ReceivedMessage = { raw: string; from: string; to: string[] };

const prisma = new PrismaClient();
const P = `ses861_${randomUUID().slice(0, 8)}`;
const ids = {
  staff: `${P}_staff`,
  holder: `${P}_holder`,
  ann: `${P}_ann`,
  bo: `${P}_bo`,
  event: `${P}_event`,
  form: `${P}_form`,
  version: `${P}_version`,
};
const CONFIRMATION_CODE = `${P}-REG`.toUpperCase();
const CONTACT_EMAIL = `${P}.contact@example.test`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

/** A PDF that is only a PDF to a signature check. */
function pdfOf(label: string) {
  return Buffer.from(`%PDF-1.7\n% ${label}\n${" ".repeat(400)}`);
}

/** The SES stand-in: STARTTLS offered, credentials checked, and each message answered from a scripted list. */
function startSmtpStub(options: { starttls?: boolean } = {}) {
  const received: ReceivedMessage[] = [];
  const script: Reply[] = [];
  /** Per AUTH: "fail" answers 535; anything else (or an empty list) accepts. */
  const authReplies: Array<"ok" | "fail"> = [];
  let accepted = 0;
  let authCount = 0;
  const server = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: false,
    disabledCommands: options.starttls === false ? ["STARTTLS", "AUTH"] : [],
    logger: false,
    onAuth(auth, _session, callback) {
      authCount += 1;
      if (authReplies.shift() === "fail") {
        return callback(Object.assign(new Error("Authentication Credentials Invalid"), { responseCode: 535 }));
      }
      if (auth.username === SMTP_USER && auth.password === SMTP_PASSWORD) return callback(null, { user: auth.username });
      return callback(Object.assign(new Error("Authentication Credentials Invalid"), { responseCode: 535 }));
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        const reply = script.shift() ?? "accept";
        if (reply !== "accept") {
          return callback(Object.assign(new Error(reply.text), { responseCode: reply.code }));
        }
        received.push({
          raw: Buffer.concat(chunks).toString("utf8"),
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
        });
        accepted += 1;
        // SES answers `250 Ok <message id>`.
        return callback(null, `Ok 0100synthetic${String(accepted).padStart(4, "0")}-000000`);
      });
    },
  });
  return new Promise<{
    port: number;
    received: ReceivedMessage[];
    script: Reply[];
    authReplies: Array<"ok" | "fail">;
    logins: () => number;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.server.address() as AddressInfo;
      resolve({ port, received, script, authReplies, logins: () => authCount, close: () => new Promise((done) => { server.close(() => done()); }) });
    });
  });
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: ids.event }, { actorUserId: ids.staff }] } });
  await prisma.publicRegistrationSubmission.deleteMany({ where: { eventId: ids.event } });
  await prisma.messageOutbox.deleteMany({ where: { eventId: ids.event } });
  await prisma.announcement.deleteMany({ where: { eventId: ids.event } });
  await prisma.eventMessageTemplate.deleteMany({ where: { eventId: ids.event } });
  await prisma.messageFile.deleteMany({ where: { eventId: ids.event } });
  await prisma.event.deleteMany({ where: { id: ids.event } });
  await prisma.person.deleteMany({ where: { id: { in: [ids.holder, ids.ann, ids.bo] } } });
  await prisma.user.deleteMany({ where: { id: ids.staff } });
}

async function main() {
  const storageDir = await mkdtemp(path.join(tmpdir(), "imsda-ses-files-"));
  process.env.ASSET_STORAGE_DIR = storageDir;
  const stub = await startSmtpStub();
  process.env.EMAIL_PROVIDER = "ses";
  process.env.SES_REGION = "us-east-2";
  process.env.SES_SMTP_USERNAME = SMTP_USER;
  process.env.SES_SMTP_PASSWORD = SMTP_PASSWORD;
  process.env.SES_SMTP_HOST = "127.0.0.1";
  process.env.SES_SMTP_PORT = String(stub.port);
  process.env.SES_MAX_SEND_RATE = "50";
  try {
    await runChecks(stub);
  } finally {
    await stub.close();
    await rm(storageDir, { recursive: true, force: true });
  }
}

async function runChecks(stub: Awaited<ReturnType<typeof startSmtpStub>>) {
  // Imported after the environment is set, as the delivery code reads it when it runs.
  const { createMessageFile } = await import("@/modules/communications/message-files");
  const { createAnnouncement, publishAnnouncement } = await import("@/modules/communications/repository");
  const { broadcastPublishedAnnouncement, previewAnnouncementBroadcast } = await import("@/modules/communications/announcement-broadcast");
  const {
    enqueueSelectedAudienceBatch,
    ensureEventMessagingDefaults,
    getSelectedAudiencePreview,
    processPendingMessages,
    publishMessageTemplateVersion,
  } = await import("@/modules/communications/messaging-repository");
  const { renderAttendeePassQrPng } = await import("@/modules/checkin/pass-qr-image");
  const { sendEmailWithSes, getSesEmailConfiguration } = await import("@/integrations/email/ses");
  const { resetEmailPreflightCache } = await import("@/integrations/email/provider");
  const { EmailProviderConfigurationError, EmailProviderRequestError } = await import("@/integrations/email/types");

  await cleanup();
  await prisma.user.create({ data: { id: ids.staff, email: `${P}.staff@example.test`, displayName: "Synthetic Staff" } });
  await prisma.person.createMany({
    data: [
      { id: ids.holder, firstName: "Pat", lastName: "Party", normalizedEmail: CONTACT_EMAIL },
      { id: ids.ann, firstName: "Ann", lastName: "Synthetic" },
      { id: ids.bo, firstName: "Bo", lastName: "Synthetic" },
    ],
  });
  await prisma.event.create({
    data: {
      id: ids.event,
      slug: `${ids.event}-slug`,
      name: "SES Verification Retreat",
      startsAt: new Date("2027-10-08T21:00:00Z"),
      endsAt: new Date("2027-10-10T17:00:00Z"),
      location: "Synthetic Camp",
    },
  });
  await prisma.registrationForm.create({
    data: { id: ids.form, eventId: ids.event, createdByUserId: ids.staff, name: "Verification form", slug: `${P}-form`, status: "PUBLISHED" },
  });
  await prisma.registrationFormVersion.create({
    data: {
      id: ids.version, formId: ids.form, createdByUserId: ids.staff, versionNumber: 1, status: "PUBLISHED", publishedAt: new Date(),
      definition: { title: "SES verification", description: "Synthetic form.", confirmationMessage: "Received.", sections: [] },
    },
  });
  const registration = await prisma.registration.create({
    data: {
      eventId: ids.event,
      accountHolderPersonId: ids.holder,
      confirmationCode: CONFIRMATION_CODE,
      status: "CONFIRMED",
      totalAmount: "50.00",
      submittedAt: new Date("2027-09-01T10:00:00Z"),
      contactSnapshot: { firstName: "Pat", lastName: "Party", email: CONTACT_EMAIL },
    },
    select: { id: true },
  });
  for (const [index, personId, first] of [[0, ids.ann, "Ann"], [1, ids.bo, "Bo"]] as const) {
    await prisma.registrationAttendee.create({
      data: {
        eventId: ids.event, registrationId: registration.id, personId, attendeeType: "ADULT", position: index,
        profileSnapshot: { firstName: first, lastName: "Synthetic" },
        formResponses: {},
      },
    });
  }
  await prisma.publicRegistrationSubmission.create({
    data: {
      eventId: ids.event, formVersionId: ids.version, registrationId: registration.id,
      idempotencyKey: `${P}-submission`, requestHash: `${P}-hash`, responses: {}, pricingSnapshot: {},
    },
  });

  await ensureEventMessagingDefaults(ids.event);
  await prisma.eventMessageSettings.update({
    where: { eventId: ids.event },
    data: {
      deliveryMode: "EXTERNAL_EMAIL",
      senderEmail: "events@example.test",
      senderName: "Synthetic Events",
      replyToEmail: "help@example.test",
    },
  });
  const template = await prisma.eventMessageTemplate.findUniqueOrThrow({
    where: { eventId_key: { eventId: ids.event, key: "EVENT_ANNOUNCEMENT" } },
    select: { id: true },
  });

  const agenda = pdfOf("agenda");
  const agendaFile = await createMessageFile(ids.event, new File([new Uint8Array(agenda)], "Friday Agenda.pdf", { type: "application/pdf" }), ids.staff, "attachment", prisma);
  const mapPng = await renderAttendeePassQrPng("synthetic-map-image");
  const mapFile = await createMessageFile(ids.event, new File([new Uint8Array(mapPng)], "map.png", { type: "image/png" }), ids.staff, "inline-image", prisma);
  await publishMessageTemplateVersion(ids.event, template.id, {
    subjectTemplate: "{{event_name}}: {{announcement_title}}",
    bodyTemplate: [
      "# {{announcement_title}}",
      "",
      "Hello {{recipient_name}},",
      "",
      "{{announcement_body}}",
      "",
      `![Map of the grounds](msgfile:${mapFile.id})`,
      "",
      "![Check-in QR code]({{checkin_qr_image}})",
      "",
      "[Open my check-in pass]({{checkin_qr_url}}){.button}",
    ].join("\n"),
    isEnabled: true,
  }, ids.staff);

  const announcement = await createAnnouncement(ids.event, ids.staff, {
    title: "Friday arrival information",
    body: "Doors open at 3 PM.",
    priority: "NORMAL",
    attachmentFileIds: [agendaFile.id],
  });
  await publishAnnouncement(ids.event, announcement.id, ids.staff);
  const preview = await previewAnnouncementBroadcast({ eventId: ids.event, announcementId: announcement.id });
  const batchId = randomUUID();
  await broadcastPublishedAnnouncement({
    eventId: ids.event, announcementId: announcement.id, batchId, previewFingerprint: preview.fingerprint, actorUserId: ids.staff,
  });
  const message = await prisma.messageOutbox.findFirstOrThrow({
    where: { eventId: ids.event, templateKey: "EVENT_ANNOUNCEMENT", correlationId: batchId },
    select: { id: true, status: true },
  });
  assert(stub.received.length === 0, "a message that carries files waits for the worker; nothing was sent yet");

  const makeAvailable = (messageId: string) => prisma.messageOutbox.update({ where: { id: messageId }, data: { availableAt: new Date(Date.now() - 1000) } });
  const state = (messageId: string) => prisma.messageOutbox.findUniqueOrThrow({
    where: { id: messageId },
    select: { status: true, attemptCount: true, provider: true, providerMessageId: true, lastError: true },
  });
  const attempts = (messageId: string) => prisma.messageDeliveryAttempt.findMany({
    where: { messageOutboxId: messageId },
    orderBy: { attemptNumber: "asc" },
    select: { attemptNumber: true, provider: true, status: true, errorCode: true, errorMessage: true, providerMessageId: true, providerMetadata: true },
  });

  // 1. Throttled, then over the daily quota, then accepted.
  stub.script.push(
    { code: 454, text: "Throttling failure: Maximum sending rate exceeded." },
    { code: 454, text: "Throttling failure: Daily message quota exceeded." },
  );
  await processPendingMessages(ids.event, ids.staff);
  let current = await state(message.id);
  assert(current.status === "PENDING" && current.attemptCount === 1, `a throttled send is rescheduled: ${JSON.stringify(current)}`);
  await makeAvailable(message.id);
  await processPendingMessages(ids.event, ids.staff);
  current = await state(message.id);
  assert(current.status === "PENDING" && current.attemptCount === 2, `a send over the daily quota is rescheduled: ${JSON.stringify(current)}`);
  await makeAvailable(message.id);
  await processPendingMessages(ids.event, ids.staff);
  current = await state(message.id);
  assert(current.status === "SENT" && current.attemptCount === 3, `the third attempt is accepted: ${JSON.stringify(current)}`);
  assert(current.provider === "SES", `the outbox row records SES: ${current.provider}`);
  assert(current.providerMessageId === "0100synthetic0001-000000", `the SES message id is recorded: ${current.providerMessageId}`);
  const history = await attempts(message.id);
  assert(history.map((row) => `${row.provider}:${row.status}:${row.errorCode ?? ""}`).join() === "SES:FAILED:PROVIDER_RATE_LIMITED,SES:FAILED:PROVIDER_QUOTA,SES:SENT:", `attempt history: ${JSON.stringify(history)}`);
  assert(history.slice(0, 2).every((row) => (row.providerMetadata as { retryable?: boolean }).retryable === true), "both failures were retryable");
  assert(Number(stub.received.length) === 1, `only the accepted attempt reached the stub: ${stub.received.length}`);

  // 2. The accepted message is one MIME message with the attachment, the inline picture and a QR per attendee.
  const mime = stub.received[0];
  const flat = mime.raw.replace(/\r?\n/g, "\n");
  const unfolded = flat.replace(/\n[ \t]+/g, " ");
  assert(mime.from === "events@example.test" && mime.to.join() === CONTACT_EMAIL.toLowerCase(), `envelope: ${mime.from} -> ${mime.to.join()}`);
  assert(/^Reply-To: help@example\.test$/im.test(unfolded), "the reply-to is set");
  assert(new RegExp(`^X-IMSDA-Message-Id: ${message.id}$`, "im").test(unfolded), "the stable X-IMSDA-Message-Id carries the outbox id");
  assert(new RegExp(`^Message-ID: <${message.id}@example\\.test>$`, "im").test(unfolded), "the Message-ID is stable too");
  assert(/^Subject: SES Verification Retreat: Friday arrival information$/im.test(unfolded), "the subject is set");
  assert(/text\/plain/i.test(flat) && /text\/html/i.test(flat), "text and HTML parts are both present");
  assert(flat.replace(/\n/g, "").includes(agenda.toString("base64")), "the announcement's attachment bytes are in the message");
  assert(/filename="?Friday Agenda\.pdf"?/i.test(unfolded), "the attachment has its file name");
  const contentIds = [...unfolded.matchAll(/^Content-ID: <([^>]+)>$/gim)].map((match) => match[1]);
  assert(contentIds.length === 3, `one inline picture and one QR per attendee: ${contentIds.join(",")}`);
  const html = flat.includes("quoted-printable") ? flat.replace(/=\n/g, "").replace(/=3D/g, "=") : flat;
  for (const contentId of contentIds) assert(html.includes(`cid:${contentId}`), `the HTML refers to cid:${contentId}`);
  assert(!/msgfile:|__IMSDA_PRIVATE/.test(flat), `no stored reference or sentinel reaches the recipient: ${/.{40}(msgfile:|__IMSDA_PRIVATE).{40}/.exec(flat)?.[0]}`);
  assert(!/^Bcc:/im.test(unfolded), "no Bcc header");

  // 3. A 554 "Email address is not verified" is final.
  const selectedPreview = await getSelectedAudiencePreview(ids.event, "EVENT_ANNOUNCEMENT", [registration.id]);
  const selected = await enqueueSelectedAudienceBatch(ids.event, {
    batchId: randomUUID(),
    templateKey: "EVENT_ANNOUNCEMENT",
    registrationIds: [registration.id],
    announcementTitle: "A note for you",
    announcementBody: "Please read the terms.",
    previewFingerprint: selectedPreview.fingerprint,
  }, ids.staff);
  const rejectedId = selected.messageIds[0];
  stub.script.push({ code: 554, text: "Message rejected: Email address is not verified. The following identities failed the check in region US-EAST-2: events@example.test" });
  await processPendingMessages(ids.event, ids.staff);
  const rejected = await state(rejectedId);
  assert(rejected.status === "FAILED" && rejected.attemptCount === 1 && rejected.provider === "SES", `a 554 is final and recorded as SES: ${JSON.stringify(rejected)}`);
  const rejectedAttempts = await attempts(rejectedId);
  assert(rejectedAttempts.length === 1 && rejectedAttempts[0].errorCode === "SES_IDENTITY_NOT_VERIFIED", `the error code is staff-readable: ${JSON.stringify(rejectedAttempts)}`);
  assert(/verified domain/.test(rejectedAttempts[0].errorMessage ?? ""), "the message tells staff to verify the sender");
  assert(!(rejected.lastError ?? "").includes(SMTP_PASSWORD) && !JSON.stringify(rejectedAttempts).includes(SMTP_PASSWORD), "no credential is logged");
  assert(Number(stub.received.length) === 1, "the rejected message was not delivered");

  // 3b. Bad credentials stop a batch before any message is claimed; credentials that fail mid-batch hand the claimed
  //     message back untouched. Either way nothing is counted as an attempt, and the error is raised once.
  const queueAgain = async () => {
    const again = await getSelectedAudiencePreview(ids.event, "EVENT_ANNOUNCEMENT", [registration.id]);
    const batch = await enqueueSelectedAudienceBatch(ids.event, {
      batchId: randomUUID(),
      templateKey: "EVENT_ANNOUNCEMENT",
      registrationIds: [registration.id],
      announcementTitle: "Another note",
      announcementBody: "Second batch.",
      previewFingerprint: again.fingerprint,
    }, ids.staff);
    return batch.messageIds[0];
  };
  const pendingId = await queueAgain();
  const receivedBefore = stub.received.length;
  process.env.SES_SMTP_PASSWORD = "wrong-password";
  let preflightError: unknown;
  try {
    await processPendingMessages(ids.event, ids.staff);
  } catch (error) {
    preflightError = error;
  }
  process.env.SES_SMTP_PASSWORD = SMTP_PASSWORD;
  assert(preflightError instanceof Error && /SES_SMTP_USERNAME/.test(preflightError.message), `wrong credentials raise one configuration error: ${String(preflightError)}`);
  assert(!String((preflightError as Error).message).includes("wrong-password"), "the error does not echo the password");
  let untouched = await state(pendingId);
  assert(untouched.status === "PENDING" && untouched.attemptCount === 0, `wrong credentials leave the message PENDING with no attempt: ${JSON.stringify(untouched)}`);
  assert((await attempts(pendingId)).length === 0 && stub.received.length === receivedBefore, "no attempt row was written and nothing was sent");

  // Nothing due: the pre-flight does not even log in (a queued failure is left unused).
  await prisma.messageOutbox.update({ where: { id: pendingId }, data: { availableAt: new Date(Date.now() + 3_600_000) } });
  let logins = stub.logins();
  stub.authReplies.push("fail");
  await processPendingMessages(ids.event, ids.staff);
  assert(stub.logins() === logins && stub.authReplies.length === 1, "a run with nothing due opens no SMTP login");
  stub.authReplies.length = 0;
  await prisma.messageOutbox.update({ where: { id: pendingId }, data: { availableAt: new Date(Date.now() - 1000) } });

  // An unreachable provider ends the run quietly: nothing claimed, nothing counted.
  const goodPort = process.env.SES_SMTP_PORT;
  process.env.SES_SMTP_PORT = "1";
  const unreachableStarted = Date.now();
  await processPendingMessages(ids.event, ids.staff);
  process.env.SES_SMTP_PORT = goodPort;
  assert(Date.now() - unreachableStarted < 10_000, "an unreachable provider is detected once, not after repeated timeouts");
  untouched = await state(pendingId);
  assert(untouched.status === "PENDING" && untouched.attemptCount === 0 && (await attempts(pendingId)).length === 0, `an unreachable provider leaves the message untouched: ${JSON.stringify(untouched)}`);

  // The pre-flight passes, then the send itself is refused with 535.
  resetEmailPreflightCache();
  stub.authReplies.push("ok", "fail");
  let midBatchError: unknown;
  try {
    await processPendingMessages(ids.event, ids.staff);
  } catch (error) {
    midBatchError = error;
  }
  assert(midBatchError instanceof Error && /SES_SMTP_USERNAME/.test(midBatchError.message), `a mid-batch 535 raises one configuration error: ${String(midBatchError)}`);
  untouched = await state(pendingId);
  assert(untouched.status === "PENDING" && untouched.attemptCount === 0, `the claim was released without counting an attempt: ${JSON.stringify(untouched)}`);
  assert((await attempts(pendingId)).length === 0 && stub.received.length === receivedBefore, "no attempt row and nothing sent");
  resetEmailPreflightCache();
  logins = stub.logins();
  await processPendingMessages(ids.event, ids.staff);
  const recovered = await state(pendingId);
  assert(recovered.status === "SENT" && recovered.attemptCount === 1 && recovered.provider === "SES", `with good credentials the same message goes out: ${JSON.stringify(recovered)}`);

  // A pre-flight that worked is trusted for five minutes: the next run logs in once (to send), not twice.
  assert(stub.logins() - logins === 2, `the first run verifies and sends: ${stub.logins() - logins} logins`);
  const cachedId = await queueAgain();
  logins = stub.logins();
  await processPendingMessages(ids.event, ids.staff);
  assert((await state(cachedId)).status === "SENT" && stub.logins() - logins === 1, `a cached pre-flight is not repeated: ${stub.logins() - logins} logins`);

  // 4. Authentication failure is a configuration error; a server without STARTTLS is refused and nothing is sent.
  const input = {
    fromName: "Synthetic Events", fromEmail: "events@example.test", toEmail: CONTACT_EMAIL, subject: "Probe",
    bodyText: "Probe", idempotencyKey: "outbox:probe", messageId: "probe",
  };
  const configuration = getSesEmailConfiguration();
  let authError: unknown;
  try {
    await sendEmailWithSes(input, { ...configuration, password: "wrong-password" });
  } catch (error) {
    authError = error;
  }
  assert(authError instanceof EmailProviderConfigurationError, `a 535 is a configuration error: ${String(authError)}`);
  assert(!String((authError as Error).message).includes("wrong-password"), "the configuration error does not echo the password");
  const plain = await startSmtpStub({ starttls: false });
  try {
    let tlsError: unknown;
    try {
      await sendEmailWithSes(input, { ...configuration, smtpPort: plain.port });
    } catch (error) {
      tlsError = error;
    }
    assert(tlsError instanceof EmailProviderRequestError && tlsError.retryable, `a server without STARTTLS is refused, retryably: ${String(tlsError)}`);
    assert(plain.received.length === 0, "nothing was sent without TLS");
  } finally {
    await plain.close();
  }

  console.log("SES delivery verification passed");
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
