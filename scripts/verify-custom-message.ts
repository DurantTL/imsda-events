/**
 * Proves the Custom message template and Email selected (#850) against a real PostgreSQL database and a local
 * stand-in for the email provider (no network, no real address):
 *
 * - the template is provisioned for an event that already had every other template, blank and unpublished, and for a
 *   brand-new event; every other template still ships published;
 * - while it is unpublished Email selected refuses to send it, and the review says so;
 * - an empty subject or body cannot be published, and a published blank-start template needs no tokens;
 * - a party of two attendees with seminar choices, sent through Email selected with the QR and seminar tokens, gets
 *   two labelled QR images and both attendees' sessions; a cancelled registration and another event's registration
 *   are skipped; a one-attendee registration gets its own single QR;
 * - the message carries formatted HTML, an uploaded picture and an attachment, is not sent inside the staff request,
 *   and the outbox worker then delivers the same parts to the provider adapter;
 * - Email selected -> Event announcement renders the same tokens per attendee from the published announcement
 *   template, and leaves them out when that template does not use them;
 * - Balance reminder through Email selected is unchanged.
 *
 * Uses fictitious rows and a temporary storage directory it creates and removes itself.
 *
 *   npm run test:custom-message
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
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-custom-message-synthetic-key-not-a-secret");
fillBlankSyntheticEnv("MANAGE_LINK_DERIVATION_SECRET", "verify-custom-message-synthetic-derivation-secret-01");
fillBlankSyntheticEnv("ATTENDEE_PASS_SIGNING_SECRET", "verify-custom-message-synthetic-pass-signing-secret-01");
fillBlankSyntheticEnv("APP_BASE_URL", "http://localhost:3000");

type ProviderPayload = {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{ filename: string; content: string; content_type: string; content_id?: string }>;
};

const prisma = new PrismaClient();
const P = `cm850_${randomUUID().slice(0, 8)}`;
const ids = {
  staff: `${P}_staff`,
  holderA: `${P}_holder_a`,
  holderB: `${P}_holder_b`,
  holderC: `${P}_holder_c`,
  ann: `${P}_ann`,
  bo: `${P}_bo`,
  cy: `${P}_cy`,
  dee: `${P}_dee`,
  event: `${P}_event`,
  other: `${P}_other`,
  fresh: `${P}_fresh`,
  scale: `${P}_scale`,
  form: `${P}_form`,
  version: `${P}_version`,
};
const EMAIL = (label: string) => `${P}.${label}@example.test`;

const definition = {
  title: "Custom message verification",
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

function pdfOf(label: string, size = 600) {
  const head = Buffer.from(`%PDF-1.7\n% ${label}\n`);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x20)]);
}

function file(bytes: Buffer, name: string, type: string) {
  return new File([new Uint8Array(bytes)], name, { type });
}

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

const eventIds = [ids.event, ids.other, ids.fresh, ids.scale];
const SCALE_COUNT = 250;

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: eventIds } }, { actorUserId: ids.staff }] } });
  await prisma.publicRegistrationSubmission.deleteMany({ where: { eventId: { in: eventIds } } });
  const inEvents = { eventId: { in: eventIds } };
  await prisma.messageOutbox.deleteMany({ where: inEvents });
  await prisma.eventMessageTemplate.deleteMany({ where: inEvents });
  await prisma.messageFile.deleteMany({ where: inEvents });
  await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_sc` } } });
  await prisma.person.deleteMany({ where: { id: { in: [ids.holderA, ids.holderB, ids.holderC, ids.ann, ids.bo, ids.cy, ids.dee] } } });
  await prisma.user.deleteMany({ where: { id: ids.staff } });
}

async function main() {
  const storageDir = await mkdtemp(path.join(tmpdir(), "imsda-custom-message-"));
  process.env.ASSET_STORAGE_DIR = storageDir;
  const stub = await startProviderStub();
  process.env.RESEND_API_KEY = "re_synthetic_stub_key";
  process.env.RESEND_API_URL = stub.url;
  try {
    await runChecks(stub);
  } finally {
    await stub.close();
    await rm(storageDir, { recursive: true, force: true });
  }
}

async function runChecks(stub: Awaited<ReturnType<typeof startProviderStub>>) {
  const { createMessageFile } = await import("@/modules/communications/message-files");
  const {
    enqueueSelectedAudienceBatch,
    ensureEventMessagingDefaults,
    getMessagingWorkspace,
    getSelectedAudiencePreview,
    processPendingMessages,
    publishMessageTemplateVersion,
  } = await import("@/modules/communications/messaging-repository");
  const { messageTemplateInputSchema } = await import("@/modules/communications/schemas");
  const { MESSAGE_TEMPLATE_KEYS } = await import("@/modules/communications/templates");
  const { renderAttendeePassQrPng } = await import("@/modules/checkin/pass-qr-image");

  await cleanup();
  await prisma.user.create({ data: { id: ids.staff, email: EMAIL("staff"), displayName: "Synthetic Staff" } });
  await prisma.person.createMany({
    data: [
      { id: ids.holderA, firstName: "Pat", lastName: "Party", normalizedEmail: EMAIL("pat") },
      { id: ids.holderB, firstName: "Gone", lastName: "Cancelled", normalizedEmail: EMAIL("gone") },
      { id: ids.holderC, firstName: "Cy", lastName: "Solo", normalizedEmail: EMAIL("cy") },
      { id: ids.ann, firstName: "Ann", lastName: "Synthetic" },
      { id: ids.bo, firstName: "Bo", lastName: "Synthetic" },
      { id: ids.cy, firstName: "Cy", lastName: "Solo" },
      { id: ids.dee, firstName: "Dee", lastName: "Gone" },
    ],
  });
  for (const [eventId, name] of [[ids.event, "Custom Message Retreat"], [ids.other, "Another Synthetic Event"], [ids.fresh, "Brand New Synthetic Event"], [ids.scale, "Scale Synthetic Event"]] as const) {
    await prisma.event.create({
      data: { id: eventId, slug: `${eventId}-slug`, name, startsAt: new Date("2027-10-08T21:00:00Z"), endsAt: new Date("2027-10-10T17:00:00Z"), location: "Synthetic Camp" },
    });
  }
  await prisma.registrationForm.create({
    data: { id: ids.form, eventId: ids.event, createdByUserId: ids.staff, name: "Verification form", slug: `${P}-form`, status: "PUBLISHED" },
  });
  await prisma.registrationFormVersion.create({
    data: { id: ids.version, formId: ids.form, createdByUserId: ids.staff, versionNumber: 1, status: "PUBLISHED", definition, publishedAt: new Date() },
  });
  const makeRegistration = async (
    eventId: string,
    holderId: string,
    code: string,
    status: "CONFIRMED" | "CANCELLED",
    attendees: Array<{ id: string; personId: string; first: string; last: string; seminars: string[] }>,
    withForm: boolean,
  ) => {
    const registration = await prisma.registration.create({
      data: {
        eventId,
        accountHolderPersonId: holderId,
        confirmationCode: code,
        status,
        totalAmount: "50.00",
        submittedAt: new Date("2027-09-01T10:00:00Z"),
        contactSnapshot: { firstName: "Contact", lastName: code, email: (await prisma.person.findUniqueOrThrow({ where: { id: holderId }, select: { normalizedEmail: true } })).normalizedEmail },
      },
      select: { id: true },
    });
    for (const [position, attendee] of attendees.entries()) {
      await prisma.registrationAttendee.create({
        data: {
          id: attendee.id,
          eventId,
          registrationId: registration.id,
          personId: attendee.personId,
          attendeeType: "ADULT",
          position,
          profileSnapshot: { firstName: attendee.first, lastName: attendee.last },
          formResponses: { seminar_preferences: attendee.seminars },
        },
      });
    }
    if (withForm) {
      await prisma.publicRegistrationSubmission.create({
        data: { eventId, formVersionId: ids.version, registrationId: registration.id, idempotencyKey: `${P}-${code}`, requestHash: `${P}-${code}-hash`, responses: {}, pricingSnapshot: {} },
      });
    }
    return registration.id;
  };
  const party = await makeRegistration(ids.event, ids.holderA, `${P}-PARTY`.toUpperCase(), "CONFIRMED", [
    { id: `${P}_att_ann`, personId: ids.ann, first: "Ann", last: "Synthetic", seminars: ["Service", "Prayer"] },
    { id: `${P}_att_bo`, personId: ids.bo, first: "Bo", last: "Synthetic", seminars: ["Music", "Service"] },
  ], true);
  const cancelled = await makeRegistration(ids.event, ids.holderB, `${P}-GONE`.toUpperCase(), "CANCELLED", [
    { id: `${P}_att_dee`, personId: ids.dee, first: "Dee", last: "Gone", seminars: ["Prayer", "Music"] },
  ], false);
  const solo = await makeRegistration(ids.event, ids.holderC, `${P}-SOLO`.toUpperCase(), "CONFIRMED", [
    { id: `${P}_att_cy`, personId: ids.cy, first: "Cy", last: "Solo", seminars: ["Prayer", "Music"] },
  ], false);
  const foreignRegistration = await makeRegistration(ids.other, ids.holderA, `${P}-OTHER`.toUpperCase(), "CONFIRMED", [], false);

  // 1. Provisioning. An event that already had every template (an existing event) gets the custom message without
  //    losing or rewriting anything; a brand-new event gets it with the rest; it is blank and unpublished.
  await ensureEventMessagingDefaults(ids.event);
  await prisma.eventMessageTemplate.deleteMany({ where: { eventId: ids.event, key: "CUSTOM_MESSAGE" } });
  const beforeVersions = await prisma.messageTemplateVersion.count({ where: { template: { eventId: ids.event } } });
  await ensureEventMessagingDefaults(ids.event);
  await ensureEventMessagingDefaults(ids.fresh);
  for (const eventId of [ids.event, ids.fresh]) {
    const custom = await prisma.eventMessageTemplate.findUniqueOrThrow({
      where: { eventId_key: { eventId, key: "CUSTOM_MESSAGE" } },
      select: { isEnabled: true, versions: { select: { id: true } } },
    });
    assert(custom.isEnabled && custom.versions.length === 0, `the custom message exists, enabled, with nothing published (${eventId})`);
    const others = await prisma.eventMessageTemplate.findMany({
      where: { eventId, key: { not: "CUSTOM_MESSAGE" } },
      select: { key: true, versions: { where: { status: "PUBLISHED" }, select: { id: true } } },
    });
    assert(others.length === MESSAGE_TEMPLATE_KEYS.length - 1, `every other template is provisioned (${others.length})`);
    assert(others.every((template) => template.versions.length === 1), "every other template still ships one published version");
  }
  assert(
    (await prisma.messageTemplateVersion.count({ where: { template: { eventId: ids.event } } })) === beforeVersions,
    "provisioning the custom message adds no version and rewrites none",
  );
  const workspace = await getMessagingWorkspace(ids.event);
  const listed = workspace.templates.find((template) => template.key === "CUSTOM_MESSAGE");
  assert(listed && listed.name === "Custom message" && listed.activeVersion === null && listed.versions.length === 0, "the editor lists it blank, with no published version");

  // 2. Unpublished: the review says so and a send is refused.
  const unpublishedPreview = await getSelectedAudiencePreview(ids.event, "CUSTOM_MESSAGE", [party]);
  assert(unpublishedPreview.templatePublished === false && unpublishedPreview.templateId === listed.id, "the review reports an unpublished template, with its id for the link");
  let refusedUnpublished = false;
  try {
    await enqueueSelectedAudienceBatch(ids.event, {
      batchId: randomUUID(), templateKey: "CUSTOM_MESSAGE", registrationIds: [party], announcementTitle: "", announcementBody: "",
      previewFingerprint: unpublishedPreview.fingerprint,
    }, ids.staff);
  } catch (error) {
    refusedUnpublished = (error as { code?: string }).code === "TEMPLATE_NOT_PUBLISHED";
  }
  assert(refusedUnpublished, "an unpublished custom message cannot be sent");
  assert((await prisma.messageOutbox.count({ where: { eventId: ids.event } })) === 0, "nothing was queued");

  // 3. Publishing needs a subject and a body, and no tokens.
  assert(!messageTemplateInputSchema.safeParse({ subjectTemplate: "", bodyTemplate: "", isEnabled: true }).success, "a blank subject and body cannot be published");
  assert(!messageTemplateInputSchema.safeParse({ subjectTemplate: "Hello", bodyTemplate: "  ", isEnabled: true }).success, "a blank body cannot be published");
  assert(messageTemplateInputSchema.safeParse({ subjectTemplate: "Hello", bodyTemplate: "Just words.", isEnabled: true }).success, "a body with no tokens can be published");

  // 4. Publish a formatted custom message with a picture, an attachment, QR codes and seminar choices.
  const agenda = pdfOf("agenda");
  const agendaFile = await createMessageFile(ids.event, file(agenda, "Friday Agenda.pdf", "application/pdf"), ids.staff, "attachment", prisma);
  const mapPng = await renderAttendeePassQrPng("synthetic-map-image");
  const mapFile = await createMessageFile(ids.event, file(mapPng, "map.png", "image/png"), ids.staff, "inline-image", prisma);
  const customBody = [
    "Hello {{recipient_name}},",
    "",
    "**Please bring this to check-in.** *Thank you.*",
    "",
    `![Map of the grounds](msgfile:${mapFile.id})`,
    "",
    "- Doors open at 3 PM",
    "- Dinner is at 6 PM",
    "",
    "### Your check-in codes",
    "",
    "![Check-in QR code]({{checkin_qr_image}})",
    "",
    "### Your sessions",
    "",
    "{{seminar_preferences}}",
    "",
    "[Open my registration]({{portal_url}}){.button}",
  ].join("\n");
  await publishMessageTemplateVersion(ids.event, listed.id, {
    subjectTemplate: "Welcome to {{event_name}}",
    bodyTemplate: customBody,
    isEnabled: true,
    attachmentFileIds: [agendaFile.id],
  }, ids.staff);
  await prisma.eventMessageSettings.update({
    where: { eventId: ids.event },
    data: { deliveryMode: "EXTERNAL_EMAIL", senderEmail: "events@example.test", senderName: "Synthetic Events" },
  });

  // 5. Email selected: active registrations only, the same review, files and worker-delivery rule.
  const selection = [party, cancelled, solo, foreignRegistration];
  const preview = await getSelectedAudiencePreview(ids.event, "CUSTOM_MESSAGE", selection);
  assert(preview.templatePublished && preview.templateVersionNumber === 1, "the published version is what the review reads");
  assert(preview.includedCount === 2 && preview.skippedCount === 2, `two active registrations are included: ${JSON.stringify(preview.recipients.map((r) => r.confirmationCode))}`);
  assert(
    preview.skipped.map((entry) => entry.code).sort().join() === "INACTIVE_REGISTRATION,NOT_FOUND",
    `the cancelled and the other event's registration are skipped by name: ${JSON.stringify(preview.skipped)}`,
  );
  assert(preview.attachments.map((item) => item.filename).join() === "Friday Agenda.pdf" && preview.carriesFiles && preview.attachmentProblem === null, "the review lists the attachment and says the send carries files");
  const batchId = randomUUID();
  const sent = await enqueueSelectedAudienceBatch(ids.event, {
    batchId, templateKey: "CUSTOM_MESSAGE", registrationIds: selection, announcementTitle: "", announcementBody: "",
    previewFingerprint: preview.fingerprint,
  }, ids.staff);
  assert(sent.includedCount === 2 && sent.skippedCount === 2 && sent.queuedCount === 2 && !sent.replayed, `two messages are queued: ${JSON.stringify(sent)}`);
  const messages = await prisma.messageOutbox.findMany({
    where: { eventId: ids.event, templateKey: "CUSTOM_MESSAGE", correlationId: batchId },
    orderBy: { recipientEmail: "asc" },
    select: {
      id: true, registrationId: true, recipientEmail: true, status: true, attemptCount: true, subjectSnapshot: true, bodyTextSnapshot: true, bodyHtmlSnapshot: true,
      files: { orderBy: [{ disposition: "asc" }, { position: "asc" }], select: { disposition: true, file: { select: { filename: true } } } },
    },
  });
  assert(messages.length === 2 && messages.map((message) => message.registrationId).sort().join() === [party, solo].sort().join(), "only the active registrations have a message");
  const partyMessage = messages.find((message) => message.registrationId === party)!;
  const soloMessage = messages.find((message) => message.registrationId === solo)!;
  const partyHtml = partyMessage.bodyHtmlSnapshot ?? "";
  assert(partyMessage.subjectSnapshot === "Welcome to Custom Message Retreat", "the subject is the template's");
  assert(
    partyMessage.bodyTextSnapshot.includes("![Check-in QR code for Ann Synthetic](") && partyMessage.bodyTextSnapshot.includes("![Check-in QR code for Bo Synthetic]("),
    "the party's single image token became one labelled QR per attendee",
  );
  assert(partyHtml.match(/src="[^"]*\/attendee-passes\/[^"]*\/qr/g)?.length === 2 || partyHtml.match(/\/attendee-passes\//g)?.length === 2, "two QR images in the party's HTML");
  assert(partyMessage.bodyTextSnapshot.includes("Ann Synthetic\n- 1st choice: Service\n- 2nd choice: Prayer"), "Ann's sessions are listed");
  assert(partyMessage.bodyTextSnapshot.includes("Bo Synthetic\n- 1st choice: Music\n- 2nd choice: Service"), "Bo's sessions are listed");
  assert(partyHtml.includes("<strong>Please bring this to check-in.</strong>") && partyHtml.includes("<em>Thank you.</em>") && /<li[^>]*>Doors open at 3 PM<\/li>/.test(partyHtml), "the body is formatted HTML");
  assert(partyHtml.includes('bgcolor="#0f6f8c"'), "the button link is a table button");
  assert(
    partyMessage.files.map((link) => `${link.disposition}:${link.file.filename}`).join() === "ATTACHMENT:Friday Agenda.pdf,INLINE:map.png",
    `the party's message carries the attachment and the picture: ${JSON.stringify(partyMessage.files)}`,
  );
  const soloHtml = soloMessage.bodyHtmlSnapshot ?? "";
  assert((soloHtml.match(/\/attendee-passes\//g) ?? []).length === 1 && soloMessage.bodyTextSnapshot.includes("![Check-in QR code]("), "a one-attendee registration keeps its single QR");
  assert(!soloMessage.bodyTextSnapshot.includes("Your sessions"), "a registration with no seminar choices drops the empty heading");
  assert(!partyMessage.bodyTextSnapshot.includes("Cy Solo") && !soloMessage.bodyTextSnapshot.includes("Ann Synthetic"), "each message holds only its own registration's attendees");

  // The real-email message carries files, so it waits for the outbox worker rather than being sent in the request.
  const providerCalls = () => stub.received.length;
  assert(providerCalls() === 0, `no message was sent inside the staff request, got ${providerCalls()}`);
  assert(messages.every((message) => message.status === "PENDING" && message.attemptCount === 0), "both messages wait for the worker");
  await processPendingMessages(ids.event, ids.staff);
  assert(providerCalls() === 2, `the worker delivered both, got ${providerCalls()}`);
  const partyPayload = stub.received.find((payload) => payload.to.includes(EMAIL("pat")))!;
  const parts = partyPayload.attachments ?? [];
  assert(parts.filter((part) => part.filename === "check-in-qr.png" && part.content_id).length === 2, "the adapter gets two inline QR images for the party");
  assert(parts.filter((part) => part.filename === "Friday Agenda.pdf" && !part.content_id).length === 1, "the adapter gets the attachment");
  assert(parts.filter((part) => part.filename === "map.png" && part.content_id).length === 1, "the adapter gets the picture inline");
  const deliveredHtml = partyPayload.html ?? "";
  assert(!deliveredHtml.includes("__IMSDA_PRIVATE") && !deliveredHtml.includes("msgfile:") && deliveredHtml.includes("cid:"), "no sentinel or stored reference reaches the recipient");
  assert(partyPayload.text.includes("2nd choice: Prayer"), "the plain-text part lists the sessions");
  const delivered = await prisma.messageOutbox.findMany({ where: { id: { in: messages.map((message) => message.id) } }, select: { status: true } });
  assert(delivered.every((row) => row.status === "SENT"), "both messages are SENT");

  // 6. A re-post of the same batch sends nothing twice.
  const replay = await enqueueSelectedAudienceBatch(ids.event, {
    batchId, templateKey: "CUSTOM_MESSAGE", registrationIds: selection, announcementTitle: "", announcementBody: "",
    previewFingerprint: preview.fingerprint,
  }, ids.staff);
  assert(replay.replayed && (await prisma.messageOutbox.count({ where: { eventId: ids.event, correlationId: batchId } })) === 2, "the same batch id does not queue anything twice");

  // 7. Today's workaround: Email selected -> Event announcement renders the same tokens per attendee from the
  //    published announcement template, but only if that template uses them (the shipped default does not).
  const announcement = await prisma.eventMessageTemplate.findUniqueOrThrow({
    where: { eventId_key: { eventId: ids.event, key: "EVENT_ANNOUNCEMENT" } },
    select: { id: true },
  });
  const announcePreview = async () => getSelectedAudiencePreview(ids.event, "EVENT_ANNOUNCEMENT", [party]);
  const announce = async (fingerprint: string) => {
    const result = await enqueueSelectedAudienceBatch(ids.event, {
      batchId: randomUUID(), templateKey: "EVENT_ANNOUNCEMENT", registrationIds: [party],
      announcementTitle: "A note", announcementBody: "Doors open at three.", previewFingerprint: fingerprint,
    }, ids.staff);
    return prisma.messageOutbox.findUniqueOrThrow({ where: { id: result.messageIds[0] }, select: { bodyTextSnapshot: true } });
  };
  const defaultAnnouncement = await announce((await announcePreview()).fingerprint);
  assert(!defaultAnnouncement.bodyTextSnapshot.includes("Check-in QR code for") && !defaultAnnouncement.bodyTextSnapshot.includes("1st choice"), "the shipped announcement template has no QR or seminar tokens, so none appear");
  await publishMessageTemplateVersion(ids.event, announcement.id, {
    subjectTemplate: "{{event_name}}: {{announcement_title}}",
    bodyTemplate: "# {{announcement_title}}\n\n{{announcement_body}}\n\n{{checkin_qr_images}}\n\n{{seminar_preferences}}",
    isEnabled: true,
  }, ids.staff);
  const withTokens = await announce((await announcePreview()).fingerprint);
  assert(
    withTokens.bodyTextSnapshot.includes("![Check-in QR code for Ann Synthetic](") && withTokens.bodyTextSnapshot.includes("![Check-in QR code for Bo Synthetic]("),
    "Event announcement through Email selected fills {{checkin_qr_images}} per attendee once the template uses it",
  );
  assert(withTokens.bodyTextSnapshot.includes("Ann Synthetic\n- 1st choice: Service") && withTokens.bodyTextSnapshot.includes("Bo Synthetic\n- 1st choice: Music"), "and {{seminar_preferences}} per attendee");

  // 7b. Tokens outside the custom message's own list cannot be published: they would render stock text or fail a send.
  for (const token of ["refund_amount", "club_assignments_block", "payment_instructions"]) {
    let refusal = "";
    try {
      await publishMessageTemplateVersion(ids.event, listed.id, {
        subjectTemplate: "Hello", bodyTemplate: `Text {{${token}}}`, isEnabled: true,
      }, ids.staff);
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      refusal = failure.code === "INVALID_TEMPLATE" ? failure.message ?? "" : "";
    }
    assert(refusal.includes(`{{${token}}}`), `publishing {{${token}}} in a custom message is refused, naming the token: "${refusal}"`);
  }
  const stillPublished = await prisma.messageTemplateVersion.findFirstOrThrow({
    where: { templateId: listed.id, status: "PUBLISHED" }, select: { versionNumber: true },
  });
  assert(stillPublished.versionNumber === 1, "the refused publishes left the published version alone");

  // 8. Balance reminder through Email selected is unchanged.
  const reminderPreview = await getSelectedAudiencePreview(ids.event, "BALANCE_REMINDER", [party]);
  assert(reminderPreview.templatePublished && reminderPreview.templateId === null && reminderPreview.attachments.length === 0 && !reminderPreview.carriesFiles, "a balance reminder review is unchanged by the new fields");
  assert(reminderPreview.includedCount === 1 && reminderPreview.recipients[0].resolvedTemplateKey === "BALANCE_REMINDER", "a balance reminder still goes to the registration with a balance");

  // 9. Scale: 250 recipients, each with the template's one attachment, in one serializable transaction.
  const scaleIds = Array.from({ length: SCALE_COUNT }, (_, index) => `${P}_sc${index}`);
  await prisma.person.createMany({
    data: scaleIds.flatMap((id, index) => [
      { id: `${id}h`, firstName: `Holder${index}`, lastName: "Scale", normalizedEmail: EMAIL(`scale${index}`) },
      { id: `${id}a`, firstName: `Guest${index}`, lastName: "Scale" },
    ]),
  });
  await prisma.registration.createMany({
    data: scaleIds.map((id, index) => ({
      id: `${id}r`, eventId: ids.scale, accountHolderPersonId: `${id}h`, confirmationCode: `${P}-SC${index}`.toUpperCase(),
      status: "CONFIRMED" as const, totalAmount: "50.00", submittedAt: new Date("2027-09-01T10:00:00Z"),
      contactSnapshot: { firstName: `Holder${index}`, lastName: "Scale", email: EMAIL(`scale${index}`) },
    })),
  });
  await prisma.registrationAttendee.createMany({
    data: scaleIds.map((id, index) => ({
      id: `${id}t`, eventId: ids.scale, registrationId: `${id}r`, personId: `${id}a`, attendeeType: "ADULT" as const, position: 0,
      profileSnapshot: { firstName: `Guest${index}`, lastName: "Scale" },
    })),
  });
  await ensureEventMessagingDefaults(ids.scale);
  const scaleTemplate = await prisma.eventMessageTemplate.findUniqueOrThrow({
    where: { eventId_key: { eventId: ids.scale, key: "CUSTOM_MESSAGE" } }, select: { id: true },
  });
  const scaleFile = await createMessageFile(ids.scale, file(pdfOf("scale-agenda"), "Agenda.pdf", "application/pdf"), ids.staff, "attachment", prisma);
  await publishMessageTemplateVersion(ids.scale, scaleTemplate.id, {
    subjectTemplate: "Hello {{recipient_name}}", bodyTemplate: "**Hi** {{recipient_name}}\n\n![QR]({{checkin_qr_image}})\n\n{{seminar_preferences}}", isEnabled: true,
    attachmentFileIds: [scaleFile.id],
  }, ids.staff);
  const scaleRegistrationIds = scaleIds.map((id) => `${id}r`);
  const scalePreview = await getSelectedAudiencePreview(ids.scale, "CUSTOM_MESSAGE", scaleRegistrationIds);
  assert(scalePreview.includedCount === SCALE_COUNT, `all ${SCALE_COUNT} are included`);
  const scaleStart = Date.now();
  const scaleSent = await enqueueSelectedAudienceBatch(ids.scale, {
    batchId: randomUUID(), templateKey: "CUSTOM_MESSAGE", registrationIds: scaleRegistrationIds, announcementTitle: "", announcementBody: "",
    previewFingerprint: scalePreview.fingerprint,
  }, ids.staff);
  const scaleMs = Date.now() - scaleStart;
  assert(scaleSent.includedCount === SCALE_COUNT, "all 250 are queued");
  assert(
    (await prisma.messageOutboxFile.count({ where: { message: { eventId: ids.scale }, disposition: "ATTACHMENT" } })) === SCALE_COUNT,
    "every message links its attachment",
  );
  console.log(`scale: ${SCALE_COUNT} recipients with 1 attachment queued in ${scaleMs} ms (transaction timeout 120000 ms)`);
  assert(scaleMs < 60_000, `the 250-recipient send stays well inside the transaction timeout, took ${scaleMs} ms`);

  console.log("custom message verification passed");
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
