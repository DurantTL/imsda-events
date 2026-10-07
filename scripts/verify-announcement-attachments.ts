/**
 * Proves attachments, embedded images and button links in announcement emails (#824, part B) against a real
 * PostgreSQL database and a local stand-in for the email provider (no network, no real address):
 *
 * - staff upload files; the type comes from the bytes, the stored name is generated, and a set over 20 MB (or an
 *   image another event owns) is refused when a template version is published;
 * - a template version's attachments carry forward to the next published version unless the list is sent without
 *   them, and the audit trail holds file names and sizes only;
 * - an announcement with one attachment, sent through a template with a button, an uploaded picture and a check-in QR
 *   per attendee, reaches the provider adapter as real attachments: the announcement's file, the template's file, and
 *   one inline part (with a content id) for the picture and for each attendee's QR, with the HTML rewritten to cid:;
 * - the first attempt fails (503) and the retry sends exactly the same parts again;
 * - a staff test send and a staff-selected batch carry the same files and the seminar choices;
 * - the files are durable references on the outbox row, which survive a staff retry copy.
 *
 * Uses fictitious rows and a temporary storage directory it creates and removes itself.
 *
 *   npm run test:announcement-attachments
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";

loadEnvConfig(process.cwd());
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-announcement-attachments-synthetic-key-not-a-secret");
fillBlankSyntheticEnv("MANAGE_LINK_DERIVATION_SECRET", "verify-announcement-attachments-synthetic-derivation-secret-01");
fillBlankSyntheticEnv("ATTENDEE_PASS_SIGNING_SECRET", "verify-announcement-attachments-synthetic-pass-signing-secret-01");
fillBlankSyntheticEnv("APP_BASE_URL", "http://localhost:3000");

type ProviderPayload = {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{ filename: string; content: string; content_type: string; content_id?: string }>;
};

const prisma = new PrismaClient();
const P = `an824b_${randomUUID().slice(0, 8)}`;
const ids = {
  staff: `${P}_staff`,
  holder: `${P}_holder`,
  ann: `${P}_ann`,
  bo: `${P}_bo`,
  event: `${P}_event`,
  other: `${P}_other`,
  form: `${P}_form`,
  version: `${P}_version`,
};
const CONFIRMATION_CODE = `${P}-REG`.toUpperCase();
const CONTACT_EMAIL = `${P}.contact@example.test`;

const definition = {
  title: "Attachment verification",
  description: "Synthetic form.",
  confirmationMessage: "Received.",
  sections: [{
    id: "seminars",
    title: "Seminars",
    description: "",
    fields: [{
      id: "seminar_field",
      key: "seminar_preferences",
      label: "Seminar preferences",
      helpText: "",
      type: "RANKED_CHOICE",
      scope: "ATTENDEE",
      required: true,
      options: ["Prayer", "Service", "Music"],
      minSelections: 2,
      maxSelections: 2,
      availabilityMode: "RANKED_INTEREST",
      choiceLimits: {},
    }],
  }],
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

/** A PDF that is only a PDF to a signature check, padded to a size. */
function pdfOf(label: string, size = 600) {
  const head = Buffer.from(`%PDF-1.7\n% ${label}\n`);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x20)]);
}

function file(bytes: Buffer, name: string, type: string) {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** The provider stand-in: answers each POST /emails from a scripted list of statuses, and keeps what it was sent. */
function startProviderStub(statuses: number[]) {
  const received: ProviderPayload[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const status = statuses.shift() ?? 200;
      if (request.url === "/emails" && request.method === "POST") received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderPayload);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(status === 200
        ? JSON.stringify({ id: `stub_email_${received.length}` })
        : JSON.stringify({ name: "application_error", message: "The stand-in provider is busy." }));
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
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: [ids.event, ids.other] } }, { actorUserId: ids.staff }] } });
  await prisma.publicRegistrationSubmission.deleteMany({ where: { eventId: ids.event } });
  // The foreign keys to a message file are RESTRICT, so what refers to one goes first (as event deletion does).
  const inEvents = { eventId: { in: [ids.event, ids.other] } };
  await prisma.messageOutbox.deleteMany({ where: inEvents });
  await prisma.announcement.deleteMany({ where: inEvents });
  await prisma.eventMessageTemplate.deleteMany({ where: inEvents });
  await prisma.messageFile.deleteMany({ where: inEvents });
  await prisma.event.deleteMany({ where: { id: { in: [ids.event, ids.other] } } });
  await prisma.person.deleteMany({ where: { id: { in: [ids.holder, ids.ann, ids.bo] } } });
  await prisma.user.deleteMany({ where: { id: ids.staff } });
}

async function main() {
  const storageDir = await mkdtemp(path.join(tmpdir(), "imsda-message-files-"));
  process.env.ASSET_STORAGE_DIR = storageDir;
  const stub = await startProviderStub([503]);
  process.env.RESEND_API_KEY = "re_synthetic_stub_key";
  process.env.RESEND_API_URL = stub.url;
  try {
    await runChecks(stub, storageDir);
  } finally {
    await stub.close();
    await rm(storageDir, { recursive: true, force: true });
  }
}

async function runChecks(stub: Awaited<ReturnType<typeof startProviderStub>>, storageDir: string) {
  // Imported after the environment is set, as the delivery code reads it when it runs.
  const { createMessageFile, MessageFileError } = await import("@/modules/communications/message-files");
  const { createAnnouncement, publishAnnouncement } = await import("@/modules/communications/repository");
  const { broadcastPublishedAnnouncement, previewAnnouncementBroadcast } = await import("@/modules/communications/announcement-broadcast");
  const { processExternalEmailQueue } = await import("@/modules/communications/email-delivery");
  const {
    enqueueSelectedAudienceBatch,
    ensureEventMessagingDefaults,
    getMessagingWorkspace,
    getSelectedAudiencePreview,
    publishMessageTemplateVersion,
    retryMessage,
    sendTestMessage,
  } = await import("@/modules/communications/messaging-repository");
  const { renderAttendeePassQrPng } = await import("@/modules/checkin/pass-qr-image");

  await cleanup();
  await prisma.user.create({ data: { id: ids.staff, email: `${P}.staff@example.test`, displayName: "Synthetic Staff" } });
  await prisma.person.createMany({
    data: [
      { id: ids.holder, firstName: "Pat", lastName: "Party", normalizedEmail: CONTACT_EMAIL },
      { id: ids.ann, firstName: "Ann", lastName: "Synthetic" },
      { id: ids.bo, firstName: "Bo", lastName: "Synthetic" },
    ],
  });
  for (const [eventId, name] of [[ids.event, "Attachment Verification Retreat"], [ids.other, "Another Synthetic Event"]] as const) {
    await prisma.event.create({
      data: {
        id: eventId,
        slug: `${eventId}-slug`,
        name,
        startsAt: new Date("2027-10-08T21:00:00Z"),
        endsAt: new Date("2027-10-10T17:00:00Z"),
        location: "Synthetic Camp",
      },
    });
  }
  await prisma.registrationForm.create({
    data: { id: ids.form, eventId: ids.event, createdByUserId: ids.staff, name: "Verification form", slug: `${P}-form`, status: "PUBLISHED" },
  });
  await prisma.registrationFormVersion.create({
    data: { id: ids.version, formId: ids.form, createdByUserId: ids.staff, versionNumber: 1, status: "PUBLISHED", definition, publishedAt: new Date() },
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
  const annAttendee = await prisma.registrationAttendee.create({
    data: {
      eventId: ids.event, registrationId: registration.id, personId: ids.ann, attendeeType: "ADULT", position: 0,
      profileSnapshot: { firstName: "Ann", lastName: "Synthetic" },
      formResponses: { seminar_preferences: ["Service", "Prayer"] },
    },
    select: { id: true },
  });
  const boAttendee = await prisma.registrationAttendee.create({
    data: {
      eventId: ids.event, registrationId: registration.id, personId: ids.bo, attendeeType: "ADULT", position: 1,
      profileSnapshot: { firstName: "Bo", lastName: "Synthetic" },
      formResponses: { seminar_preferences: ["Music", "Service"] },
    },
    select: { id: true },
  });
  await prisma.publicRegistrationSubmission.create({
    data: {
      eventId: ids.event, formVersionId: ids.version, registrationId: registration.id,
      idempotencyKey: `${P}-submission`, requestHash: `${P}-hash`, responses: {}, pricingSnapshot: {},
    },
  });

  await ensureEventMessagingDefaults(ids.event);
  await prisma.eventMessageSettings.update({
    where: { eventId: ids.event },
    data: { deliveryMode: "EXTERNAL_EMAIL", senderEmail: "events@example.test", senderName: "Synthetic Events" },
  });
  const template = await prisma.eventMessageTemplate.findUniqueOrThrow({
    where: { eventId_key: { eventId: ids.event, key: "EVENT_ANNOUNCEMENT" } },
    select: { id: true },
  });

  // 1. Uploads: the bytes decide the type; the stored name is generated; wrong kinds and oversize files are refused.
  const agenda = pdfOf("agenda");
  const terms = pdfOf("terms");
  const agendaFile = await createMessageFile(ids.event, file(agenda, "Friday Agenda.pdf", "application/pdf"), ids.staff, "attachment", prisma);
  const termsFile = await createMessageFile(ids.event, file(terms, "../../Terms.exe", "application/x-msdownload"), ids.staff, "attachment", prisma);
  assert(agendaFile.filename === "Friday Agenda.pdf" && termsFile.filename === "Terms.pdf", `stored display names are clean: ${termsFile.filename}`);
  const mapPng = await renderAttendeePassQrPng("synthetic-map-image");
  const mapFile = await createMessageFile(ids.event, file(mapPng, "map.png", "image/png"), ids.staff, "inline-image", prisma);
  assert(mapFile.isInlineImage && mapFile.contentType === "image/png", "the picture is stored as an inline image");
  const stored = await prisma.messageFile.findMany({ where: { eventId: ids.event }, select: { storageKey: true, sha256: true, filename: true } });
  assert(stored.every((row) => /^message-files\/[^/]+\/[0-9a-f-]{36}\.(pdf|png)$/.test(row.storageKey.replaceAll("\\", "/"))), "files are stored under generated names");
  assert(stored.every((row) => !row.storageKey.includes("Agenda") && !row.storageKey.includes("Terms")), "no uploaded name reaches a path");
  for (const [name, bytes, claimed] of [
    ["script.pdf", Buffer.from("#!/bin/sh\necho hi\n"), "application/pdf"],
    ["logo.svg", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"), "image/svg+xml"],
    ["plain.zip", Buffer.from("PK\u0003\u0004notes.txt"), "application/zip"],
  ] as const) {
    let refused = false;
    try {
      await createMessageFile(ids.event, file(bytes, name, claimed), ids.staff, "attachment", prisma);
    } catch (error) {
      refused = error instanceof MessageFileError && error.code === "FILE_TYPE_NOT_ALLOWED";
    }
    assert(refused, `${name} is refused`);
  }
  let tooLarge = false;
  try {
    await createMessageFile(ids.event, file(pdfOf("big", 10 * 1024 * 1024 + 1), "big.pdf", "application/pdf"), ids.staff, "attachment", prisma);
  } catch (error) {
    tooLarge = error instanceof MessageFileError && error.code === "FILE_TOO_LARGE";
  }
  assert(tooLarge, "a file over 10 MB is refused");

  // 2. Publishing: limits, ownership, carry-forward, audit.
  const body = [
    "# {{announcement_title}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "{{announcement_body}}",
    "",
    `![Map of the grounds](msgfile:${mapFile.id})`,
    "",
    "### Your seminars",
    "",
    "{{seminar_preferences}}",
    "",
    "### Your check-in codes",
    "",
    "![Check-in QR code]({{checkin_qr_image}})",
    "",
    "[Open my check-in pass]({{checkin_qr_url}}){.button}",
  ].join("\n");
  const publish = (attachmentFileIds?: string[], text = body) => publishMessageTemplateVersion(ids.event, template.id, {
    subjectTemplate: "{{event_name}}: {{announcement_title}}",
    bodyTemplate: text,
    isEnabled: true,
    ...(attachmentFileIds ? { attachmentFileIds } : {}),
  }, ids.staff);
  const attachmentsOfPublished = async () => (await prisma.messageTemplateVersionFile.findMany({
    where: { templateVersion: { templateId: template.id, status: "PUBLISHED" } },
    orderBy: { position: "asc" },
    select: { file: { select: { filename: true } } },
  })).map((row) => row.file.filename);

  const big1 = await createMessageFile(ids.event, file(pdfOf("big1", 10 * 1024 * 1024), "big1.pdf", "application/pdf"), ids.staff, "attachment", prisma);
  const big2 = await createMessageFile(ids.event, file(pdfOf("big2", 10 * 1024 * 1024), "big2.pdf", "application/pdf"), ids.staff, "attachment", prisma);
  let overTotal = false;
  try {
    await publish([big1.id, big2.id, agendaFile.id]);
  } catch (error) {
    overTotal = error instanceof MessageFileError && error.code === "FILE_SET_INVALID";
  }
  assert(overTotal, "attachments over 20 MB together are refused");
  let foreignImage = false;
  try {
    await publish(undefined, body.replace(mapFile.id, "cm0nonexistentfile0"));
  } catch (error) {
    foreignImage = error instanceof MessageFileError;
  }
  assert(foreignImage, "a body picture that is not this event's own is refused");
  const foreign = await createMessageFile(ids.other, file(mapPng, "foreign.png", "image/png"), ids.staff, "inline-image", prisma);
  let foreignRefused = false;
  try {
    await publish(undefined, body.replace(mapFile.id, foreign.id));
  } catch (error) {
    foreignRefused = error instanceof MessageFileError;
  }
  assert(foreignRefused, "another event's picture is refused");
  let foreignAttachment = false;
  try {
    await publish([(await createMessageFile(ids.other, file(terms, "x.pdf", "application/pdf"), ids.staff, "attachment", prisma)).id]);
  } catch (error) {
    foreignAttachment = error instanceof MessageFileError;
  }
  assert(foreignAttachment, "another event's attachment is refused");

  await publish([termsFile.id]);
  assert((await attachmentsOfPublished()).join() === "Terms.pdf", "a published version holds the attachments it was given");
  await publish(undefined, `${body}\n\nSee you there.`);
  assert((await attachmentsOfPublished()).join() === "Terms.pdf", "the next version carries the attachments forward when none are sent");
  await publish([]);
  assert((await attachmentsOfPublished()).length === 0, "sending an empty list removes the attachments");
  await publish([termsFile.id]);
  assert((await attachmentsOfPublished()).join() === "Terms.pdf", "an attachment can be put back");
  const publishAudits = await prisma.auditLog.findMany({ where: { eventId: ids.event, action: { in: ["MESSAGE_TEMPLATE_PUBLISHED", "MESSAGE_FILE_UPLOADED"] } }, select: { metadata: true, summary: true } });
  const auditText = JSON.stringify(publishAudits);
  assert(auditText.includes("Terms.pdf"), "the audit trail names the file");
  assert(stored.every((row) => !auditText.includes(row.sha256) && !auditText.includes(row.storageKey.replaceAll("\\", "\\\\"))), "the audit trail holds no hash or storage path");

  // Picture limits are enforced when staff save, so delivery never has to drop one: 31 pictures, or over 6 MB together.
  const smallPng = (index: number, size: number) => Buffer.concat([mapPng.subarray(0, 8), Buffer.alloc(size - 8, index)]);
  const manyImages = [] as string[];
  for (let index = 0; index < 31; index += 1) {
    manyImages.push((await createMessageFile(ids.event, file(smallPng(index, 200), `p${index}.png`, "image/png"), ids.staff, "inline-image", prisma)).id);
  }
  let tooManyPictures = false;
  try {
    await publish(undefined, manyImages.map((id) => `![p](msgfile:${id})`).join("\n\n"));
  } catch (error) {
    tooManyPictures = error instanceof MessageFileError && error.code === "FILE_SET_INVALID";
  }
  assert(tooManyPictures, "a body with 31 pictures is refused when published");
  const bigPictures = [] as string[];
  for (let index = 0; index < 4; index += 1) {
    bigPictures.push((await createMessageFile(ids.event, file(smallPng(index, 1_700_000), `big${index}.png`, "image/png"), ids.staff, "inline-image", prisma)).id);
  }
  let picturesTooLarge = false;
  try {
    await publish(undefined, bigPictures.map((id) => `![p](msgfile:${id})`).join("\n\n"));
  } catch (error) {
    picturesTooLarge = error instanceof MessageFileError && error.code === "FILE_SET_INVALID";
  }
  assert(picturesTooLarge, "pictures over 6 MB together are refused when published");
  // An announcement's own files plus the template's must fit too: 20 MB of its own, plus Terms.pdf, is refused.
  let announcementTooLarge = false;
  try {
    await createAnnouncement(ids.event, ids.staff, { title: "Too many files", body: "Over the limit.", priority: "NORMAL", attachmentFileIds: [big1.id, big2.id] });
  } catch (error) {
    announcementTooLarge = error instanceof MessageFileError && error.code === "FILE_SET_INVALID";
  }
  assert(announcementTooLarge, "an announcement whose files and the template's together are over 20 MB is refused when saved");
  assert((await attachmentsOfPublished()).join() === "Terms.pdf", "the refused publishes left the published version alone");

  // 3. An announcement with one attachment, broadcast through the template.
  const announcement = await createAnnouncement(ids.event, ids.staff, {
    title: "Friday arrival information",
    body: "Doors open at 3 PM.\n\nBring a coat.",
    priority: "NORMAL",
    attachmentFileIds: [agendaFile.id],
  });
  assert(announcement.attachments.map((item) => item.filename).join() === "Friday Agenda.pdf", "the draft lists its attachment");
  await publishAnnouncement(ids.event, announcement.id, ids.staff);
  const preview = await previewAnnouncementBroadcast({ eventId: ids.event, announcementId: announcement.id });
  assert(
    preview.attachments.map((item) => item.filename).join() === "Friday Agenda.pdf,Terms.pdf",
    `the review lists both files: ${JSON.stringify(preview.attachments)}`,
  );
  assert(preview.attachmentProblem === null, "no attachment problem");
  const batchId = randomUUID();
  const sent = await broadcastPublishedAnnouncement({
    eventId: ids.event, announcementId: announcement.id, batchId, previewFingerprint: preview.fingerprint, actorUserId: ids.staff,
  });
  assert(sent.messageCount === 1, "one message is queued");
  const message = await prisma.messageOutbox.findFirstOrThrow({
    where: { eventId: ids.event, templateKey: "EVENT_ANNOUNCEMENT", correlationId: batchId },
    select: {
      id: true, status: true, attemptCount: true, bodyTextSnapshot: true, bodyHtmlSnapshot: true,
      files: { orderBy: [{ disposition: "asc" }, { position: "asc" }], select: { disposition: true, file: { select: { filename: true } } } },
    },
  });
  assert(
    message.files.map((link) => `${link.disposition}:${link.file.filename}`).join() === "ATTACHMENT:Friday Agenda.pdf,ATTACHMENT:Terms.pdf,INLINE:map.png",
    `the outbox row references its files durably: ${JSON.stringify(message.files)}`,
  );
  assert(!message.bodyTextSnapshot.includes("msgfile:") && !message.bodyTextSnapshot.includes("{.button}"), "the text part carries neither marker");
  assert(message.bodyTextSnapshot.includes("[Image: Map of the grounds]"), "the text part names the picture");
  assert(message.bodyHtmlSnapshot?.includes(`src="msgfile:${mapFile.id}"`) && message.bodyHtmlSnapshot.includes('bgcolor="#0f6f8c"'), "the stored HTML has the picture reference and the table button");

  // 4. A message with files is not sent inside the staff request: it waits for the outbox worker, which is the
  //    sweep's `processPendingMessages`. The first attempt meets a 503 and is rescheduled; the retry sends the same parts.
  const providerCalls = () => stub.received.length;
  assert(providerCalls() === 0, `the broadcast request did not send a message that carries files, got ${providerCalls()} provider calls`);
  const queued = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: message.id }, select: { status: true, attemptCount: true } });
  assert(queued.status === "PENDING" && queued.attemptCount === 0, `the message waits for the worker: ${JSON.stringify(queued)}`);
  const { processPendingMessages } = await import("@/modules/communications/messaging-repository");
  await processPendingMessages(ids.event, ids.staff);
  assert(providerCalls() === 1, `the worker's first pass called the provider once, got ${providerCalls()}`);
  const afterFirst = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: message.id }, select: { status: true, attemptCount: true } });
  assert(afterFirst.status === "PENDING" && afterFirst.attemptCount === 1, `the message waits for a retry: ${JSON.stringify(afterFirst)}`);
  await prisma.messageOutbox.update({ where: { id: message.id }, data: { availableAt: new Date(Date.now() - 1000) } });
  const retried = await processExternalEmailQueue(ids.event, { messageIds: [message.id] });
  assert(retried.sentIds.includes(message.id), "the retry is accepted");
  assert(providerCalls() === 2, "the provider was called again");
  const [first, second] = stub.received;
  const summarize = (payload: ProviderPayload) => (payload.attachments ?? []).map((part) => `${part.filename}|${part.content_type}|${part.content_id ? "inline" : "attachment"}|${part.content.length}`);
  assert(
    summarize(first).join("\n") === summarize(second).join("\n"),
    `the retry sends the same parts\nfirst:  ${summarize(first).join(", ")}\nsecond: ${summarize(second).join(", ")}`,
  );
  const parts = second.attachments ?? [];
  assert(parts.length === 5, `two attachments, the picture, and two QR codes reach the adapter: ${summarize(second).join(", ")}`);
  const named = (name: string) => parts.filter((part) => part.filename === name);
  assert(named("Friday Agenda.pdf").length === 1 && !named("Friday Agenda.pdf")[0].content_id, "the announcement's file is a plain attachment");
  assert(Buffer.from(named("Friday Agenda.pdf")[0].content, "base64").equals(agenda), "the attachment is the stored bytes");
  assert(named("Terms.pdf").length === 1 && !named("Terms.pdf")[0].content_id, "the template's file is a plain attachment");
  const map = named("map.png")[0];
  assert(map?.content_id && Buffer.from(map.content, "base64").equals(mapPng), "the picture is an inline part with a content id");
  const qrParts = named("check-in-qr.png");
  assert(qrParts.length === 2 && qrParts.every((part) => part.content_id && part.content_type === "image/png"), "each attendee's QR is an inline PNG part");
  assert(qrParts[0].content !== qrParts[1].content, "the two QR codes differ");
  assert(Buffer.from(qrParts[0].content, "base64").subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "a QR part is a PNG");
  const html = second.html ?? "";
  for (const part of [map, ...qrParts]) assert(html.includes(`src="cid:${part.content_id}"`), `the HTML refers to cid:${part.content_id}`);
  assert(!html.includes("msgfile:") && !html.includes("/attendee-passes/") && !html.includes("__IMSDA_PRIVATE"), "no stored reference or sentinel reaches the recipient");
  assert(html.includes('alt="Map of the grounds"') && html.includes('alt="Check-in QR code for Ann Synthetic"'), "alt text is kept");
  assert(/<table role="presentation"[^>]*>\s*<tr><td align="center" bgcolor="#0f6f8c"/.test(html.replace(/\n/g, "")), "the button is a table");
  assert(html.includes("/manage/") && html.includes(">Open my check-in pass</a>"), "the button links to the registration's private page");
  assert(second.text.includes("1st choice: Service"), "the seminar list is in the message");
  const sentRow = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: message.id }, select: { status: true, attemptCount: true } });
  assert(sentRow.status === "SENT" && sentRow.attemptCount === 2, "the message is SENT after the retry");

  // 5. A staff retry copy sends the same files, with the formatted part.
  await prisma.messageOutbox.update({ where: { id: message.id }, data: { status: "FAILED", failedAt: new Date() } });
  const workspace = await getMessagingWorkspace(ids.event);
  const record = workspace.messages.find((item) => item.id === message.id);
  assert(record && record.files.length === 3, "the delivery log lists the files");
  const retryOperation = await retryMessage(ids.event, message.id, { clientRequestId: randomUUID(), requestFingerprint: record.retryRequestFingerprint }, ids.staff);
  const copy = await prisma.messageOutbox.findUniqueOrThrow({
    where: { id: retryOperation.messageId },
    select: { bodyHtmlSnapshot: true, files: { select: { disposition: true, file: { select: { filename: true } } } } },
  });
  assert(copy.files.length === 3 && copy.bodyHtmlSnapshot === message.bodyHtmlSnapshot, "a staff retry copy keeps the files and the formatted body");
  assert(providerCalls() === 3 && summarize(stub.received[2]).join("\n") === summarize(second).join("\n"), "the copy was sent with the same parts");

  // 6. A test send shows the files the real message carries.
  await sendTestMessage(ids.event, template.id, {
    recipientEmail: `${P}.tester@example.test`,
    recipientName: "Synthetic Tester",
    realDelivery: false,
    confirmationCode: CONFIRMATION_CODE,
  } as never, ids.staff);
  const test = await prisma.messageOutbox.findFirstOrThrow({
    where: { eventId: ids.event, recipientKind: "TEST" },
    orderBy: { createdAt: "desc" },
    select: { id: true, files: { orderBy: [{ disposition: "asc" }, { position: "asc" }], select: { disposition: true, file: { select: { filename: true } } } } },
  });
  assert(
    test.files.map((link) => `${link.disposition}:${link.file.filename}`).join() === "ATTACHMENT:Friday Agenda.pdf,ATTACHMENT:Terms.pdf,INLINE:map.png",
    `the test send carries the announcement's and the template's files: ${JSON.stringify(test.files)}`,
  );
  const testAudit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: test.id, action: "MESSAGE_TEST_CREATED" }, select: { metadata: true } });
  assert(
    JSON.stringify((testAudit.metadata as { attachments?: unknown }).attachments) === JSON.stringify([
      { filename: "Friday Agenda.pdf", sizeBytes: agenda.length },
      { filename: "Terms.pdf", sizeBytes: terms.length },
    ]),
    "the test audit lists file names and sizes only",
  );

  // 7. A staff-selected batch reuses the batch seminar loader and carries the template's files.
  const selectedPreview = await getSelectedAudiencePreview(ids.event, "EVENT_ANNOUNCEMENT", [registration.id]);
  assert(selectedPreview.includedCount === 1, "the selected registration is included");
  const selected = await enqueueSelectedAudienceBatch(ids.event, {
    batchId: randomUUID(),
    templateKey: "EVENT_ANNOUNCEMENT",
    registrationIds: [registration.id],
    announcementTitle: "A note for you",
    announcementBody: "Please read the terms.",
    previewFingerprint: selectedPreview.fingerprint,
  }, ids.staff);
  const selectedMessage = await prisma.messageOutbox.findUniqueOrThrow({
    where: { id: selected.messageIds[0] },
    select: { bodyTextSnapshot: true, files: { select: { disposition: true, file: { select: { filename: true } } } } },
  });
  assert(selectedMessage.bodyTextSnapshot.includes("Ann Synthetic\n- 1st choice: Service\n- 2nd choice: Prayer"), "a selected-audience send lists the attendee's own seminar choices");
  assert(
    selectedMessage.files.map((link) => link.file.filename).sort().join() === "Terms.pdf,map.png",
    `a selected-audience send carries the template's file and picture: ${JSON.stringify(selectedMessage.files)}`,
  );
  assert(boAttendee.id !== annAttendee.id, "two attendees were used");

  // 8. A file referenced by a template, an announcement or a message cannot be deleted at all: the keys are RESTRICT.
  let deleteRefused = false;
  try {
    await prisma.messageFile.delete({ where: { id: agendaFile.id } });
  } catch {
    deleteRefused = true;
  }
  assert(deleteRefused, "the database refuses to delete a file an outbox row and an announcement refer to");
  let pictureDeleteRefused = false;
  try {
    await prisma.messageFile.delete({ where: { id: mapFile.id } });
  } catch {
    pictureDeleteRefused = true;
  }
  assert(pictureDeleteRefused, "the database refuses to delete a picture an outbox row refers to");
  assert((await prisma.messageFile.count({ where: { id: { in: [agendaFile.id, mapFile.id] } } })) === 2, "both files are still there");
  // A file referenced by a sent message is never deleted by the app either, and an unused attachment can be.
  const { deleteMessageFileIfUnused } = await import("@/modules/communications/message-files");
  assert(!(await deleteMessageFileIfUnused(ids.event, agendaFile.id, prisma)), "an attachment a message refers to stays");
  assert(await deleteMessageFileIfUnused(ids.event, big1.id, prisma), "an unused attachment is removed");
  assert((await prisma.messageFile.count({ where: { id: big1.id } })) === 0, "and its row goes with it");

  void storageDir;
  console.log("announcement attachment verification passed");
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
