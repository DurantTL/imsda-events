/**
 * Proves the event-announcement email fixes (#824) against a real PostgreSQL database:
 *
 * - an announcement broadcast to a registration with two attendees lists each attendee's own seminar choices in ranked
 *   order, plus the seminar the seminar assignments module placed them in, and never another attendee's;
 * - the same message carries one QR image per attendee, labelled with the attendee's name, and delivery resolves each
 *   per-pass sentinel with the registration's private token (the pass route authorizes each attendee with that token);
 * - the formatted body has a separate paragraph per blank-line-separated block;
 * - a registrant-supplied name is escaped, so it never becomes a live link;
 * - a test send that names a registration shows no sample value for any token, and a test with no registration still
 *   uses the sample context.
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:announcement-email
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";
import { broadcastPublishedAnnouncement, previewAnnouncementBroadcast } from "@/modules/communications/announcement-broadcast";
import { prepareEmailBodyForDelivery } from "@/modules/communications/email-delivery";
import {
  ensureEventMessagingDefaults,
  publishMessageTemplateVersion,
  sendTestMessage,
} from "@/modules/communications/messaging-repository";
import { SAMPLE_MESSAGE_TEMPLATE_CONTEXT } from "@/modules/communications/templates";
import { createAuthorizedAttendeePass } from "@/modules/checkin/attendee-pass-repository";

loadEnvConfig(process.cwd());
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-announcement-email-synthetic-key-not-a-secret");
fillBlankSyntheticEnv("MANAGE_LINK_DERIVATION_SECRET", "verify-announcement-email-synthetic-derivation-secret-0001");
fillBlankSyntheticEnv("ATTENDEE_PASS_SIGNING_SECRET", "verify-announcement-email-synthetic-pass-signing-secret-01");
fillBlankSyntheticEnv("APP_BASE_URL", "http://localhost:3000");

const prisma = new PrismaClient();
const P = `an824_${randomUUID().slice(0, 8)}`;
const ids = {
  staff: `${P}_staff`,
  holder: `${P}_holder`,
  ann: `${P}_ann`,
  bo: `${P}_bo`,
  event: `${P}_event`,
  form: `${P}_form`,
  version: `${P}_version`,
  announcement: `${P}_announcement`,
};
const CONFIRMATION_CODE = `${P}-REG`.toUpperCase();
const CONTACT_EMAIL = `${P}.contact@example.test`;
const TRAP_NAME = "[Click here](https://malicious.example)";

const definition = {
  title: "Announcement verification",
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

const BODY = [
  "# {{announcement_title}}",
  "",
  "Hello {{recipient_name}},",
  "",
  "{{announcement_body}}",
  "",
  "### Your seminars",
  "",
  "{{seminar_preferences}}",
  "",
  "### Your check-in codes",
  "",
  "![Check-in QR code]({{checkin_qr_image}})",
  "",
  "Or open [your check-in page]({{checkin_qr_url}}).",
].join("\n");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: ids.event }, { actorUserId: ids.staff }] } });
  await prisma.publicRegistrationSubmission.deleteMany({ where: { eventId: ids.event } });
  await prisma.event.deleteMany({ where: { id: ids.event } });
  await prisma.person.deleteMany({ where: { id: { in: [ids.holder, ids.ann, ids.bo] } } });
  await prisma.user.deleteMany({ where: { id: ids.staff } });
}

async function main() {
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
      slug: `${P}-event`,
      name: "Announcement Verification Retreat",
      startsAt: new Date("2027-10-08T21:00:00Z"),
      endsAt: new Date("2027-10-10T17:00:00Z"),
      location: "Synthetic Camp",
    },
  });
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
      profileSnapshot: { firstName: "Bo", lastName: TRAP_NAME },
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
  // The seminar assignments module placed Ann in Prayer (her 2nd choice); Bo has no assignment.
  const run = await prisma.programAssignmentRun.create({
    data: {
      eventId: ids.event, formId: ids.form, formVersionId: ids.version, fieldId: "seminar_field",
      fieldKeySnapshot: "seminar_preferences", fieldLabelSnapshot: "Seminar preferences", formNameSnapshot: "Verification form",
      formVersionNumber: 1, optionsSnapshot: ["Prayer", "Service", "Music"], limitsSnapshot: {}, summarySnapshot: {},
      sourceFingerprint: `${P}-fingerprint`, sourceParticipantCount: 2, clientRequestId: `${P}-run`, appliedByNameSnapshot: "Synthetic Staff",
    },
    select: { id: true },
  });
  await prisma.programAttendeeAssignment.create({
    data: {
      runId: run.id, attendeeIdSnapshot: annAttendee.id, registrationIdSnapshot: registration.id, confirmationCodeSnapshot: CONFIRMATION_CODE,
      attendeePositionSnapshot: 0, stableOrder: 0, firstNameSnapshot: "Ann", lastNameSnapshot: "Synthetic", attendeeTypeSnapshot: "ADULT",
      preferencesSnapshot: ["Service", "Prayer"], optionValue: "Prayer", preferenceRank: 2, outcome: "ASSIGNED",
    },
  });
  await prisma.announcement.create({
    data: {
      id: ids.announcement, eventId: ids.event, createdByUserId: ids.staff, title: "Friday arrival information",
      body: "Doors open at 3 PM.\n\nBring a coat.", audience: { type: "ALL_ATTENDEES" }, placement: "HOME_BANNER",
      status: "PUBLISHED", publishedAt: new Date(),
    },
  });

  await ensureEventMessagingDefaults(ids.event);
  const template = await prisma.eventMessageTemplate.findUniqueOrThrow({
    where: { eventId_key: { eventId: ids.event, key: "EVENT_ANNOUNCEMENT" } },
    select: { id: true },
  });
  await publishMessageTemplateVersion(ids.event, template.id, {
    subjectTemplate: "{{event_name}}: {{announcement_title}}",
    bodyTemplate: BODY,
    isEnabled: true,
  }, ids.staff);

  // 1. The broadcast.
  const preview = await previewAnnouncementBroadcast({ eventId: ids.event, announcementId: ids.announcement });
  assert(preview.recipientCount === 1, `expected one recipient, got ${preview.recipientCount}`);
  const batchId = randomUUID();
  const sent = await broadcastPublishedAnnouncement({
    eventId: ids.event, announcementId: ids.announcement, batchId, previewFingerprint: preview.fingerprint, actorUserId: ids.staff,
  });
  assert(sent.messageCount === 1, "one announcement message is queued");
  const message = await prisma.messageOutbox.findFirstOrThrow({
    where: { eventId: ids.event, templateKey: "EVENT_ANNOUNCEMENT", correlationId: batchId },
    select: { id: true, registrationId: true, bodyTextSnapshot: true, bodyHtmlSnapshot: true },
  });
  const text = message.bodyTextSnapshot;
  const html = message.bodyHtmlSnapshot ?? "";

  // Seminar lists, per attendee, ranked, with the assignment first.
  assert(
    text.includes("**Ann Synthetic**\n- Assigned: Prayer\n- 1st choice: Service\n- 2nd choice: Prayer"),
    `Ann's seminar list is wrong:\n${text}`,
  );
  const boSection = text.slice(text.indexOf("- 1st choice: Music"));
  assert(boSection.startsWith("- 1st choice: Music\n- 2nd choice: Service"), "Bo's choices are ranked Music then Service");
  assert(!text.slice(text.indexOf("**Ann Synthetic**"), text.indexOf("Music")).includes("Music"), "Ann's list does not carry Bo's choices");
  assert(!text.slice(text.indexOf("Music")).includes("Assigned:"), "Bo has no assignment line");
  assert(!text.includes("Avery Johnson"), "no sample value in the sent text");
  assert(!html.includes("Avery Johnson"), "no sample value in the sent HTML");
  assert(/<li style="[^"]*">Assigned: Prayer<\/li>/.test(html), "HTML renders the seminar list as list items");

  // The registrant-supplied name is never a live link.
  assert(!html.includes("malicious.example\""), "the trap name is not a link target");
  assert(!html.includes("href=\"https://malicious.example"), "the trap name is not an anchor");

  // One QR image per attendee, each labelled.
  const annSrc = `__IMSDA_PRIVATE_MANAGE_API__/attendee-passes/${annAttendee.id}/qr?format=png`;
  const boSrc = `__IMSDA_PRIVATE_MANAGE_API__/attendee-passes/${boAttendee.id}/qr?format=png`;
  assert(html.includes(`src="${annSrc}"`) && html.includes(`src="${boSrc}"`), "HTML has each attendee's own QR image");
  assert((html.match(/<img /g) ?? []).length === 2, "exactly two QR images");
  assert(text.includes("**Ann Synthetic**\n\n![Check-in QR code for Ann Synthetic]("), "Ann's QR is labelled with her name");
  assert(html.includes("alt=\"Check-in QR code for Ann Synthetic\""), "the image alt names the attendee");

  // Paragraph spacing: every blank-line-separated block is its own paragraph.
  for (const paragraph of ["Hello Pat Party,", "Doors open at 3 PM.", "Bring a coat."]) {
    assert(new RegExp(`<p style="[^"]*">${paragraph.replace(/\./g, "\\.")}</p>`).test(html), `"${paragraph}" is its own <p>`);
  }
  assert(!html.includes("Doors open at 3 PM.<br />"), "paragraphs are not merged with a line break");

  // Delivery resolves both per-pass sentinels with the registration's token, and each pass authorizes.
  const prepared = await prepareEmailBodyForDelivery({
    messageId: message.id,
    registrationId: message.registrationId,
    templateKey: "EVENT_ANNOUNCEMENT",
    bodyText: message.bodyTextSnapshot,
    bodyHtml: message.bodyHtmlSnapshot,
    now: new Date(),
  });
  assert(!prepared.bodyHtml?.includes("__IMSDA_PRIVATE_MANAGE"), "no sentinel survives delivery preparation");
  assert(!prepared.bodyText.includes("__IMSDA_PRIVATE_MANAGE"), "no sentinel survives in the text part");
  const srcs = [...(prepared.bodyHtml ?? "").matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]);
  assert(srcs.length === 2, "two images after delivery preparation");
  for (const [src, attendeeId] of [[srcs[0], annAttendee.id], [srcs[1], boAttendee.id]] as const) {
    const match = /\/api\/public\/manage\/([^/]+)\/attendee-passes\/([^/]+)\/qr\?format=png$/.exec(src);
    assert(match && match[2] === attendeeId, `delivered URL targets attendee ${attendeeId}: ${src}`);
    const pass = await createAuthorizedAttendeePass(match[1], attendeeId);
    assert(pass, `the registration's token authorizes attendee ${attendeeId}'s own pass`);
  }
  await prepared.revokeOnDefinitiveFailure?.();

  // 2. A test send that names a registration never shows sample data.
  await sendTestMessage(ids.event, template.id, {
    recipientEmail: `${P}.tester@example.test`,
    recipientName: "Synthetic Tester",
    realDelivery: false,
    confirmationCode: CONFIRMATION_CODE,
  } as never, ids.staff);
  const real = await prisma.messageOutbox.findFirstOrThrow({
    where: { eventId: ids.event, recipientKind: "TEST", registrationId: registration.id },
    select: { bodyTextSnapshot: true, bodyHtmlSnapshot: true, subjectSnapshot: true },
  });
  for (const [token, sample] of Object.entries(SAMPLE_MESSAGE_TEMPLATE_CONTEXT)) {
    const firstLine = sample.split("\n").find((line) => line.trim().length > 12) ?? sample;
    if (sample.length < 8) continue;
    assert(!real.bodyTextSnapshot.includes(firstLine) && !(real.bodyHtmlSnapshot ?? "").includes(firstLine), `sample value of ${token} appears in a real test`);
  }
  assert(real.bodyTextSnapshot.includes("- 1st choice: Service"), "the real test shows the registration's own seminar choices");
  assert(real.bodyTextSnapshot.includes("![Check-in QR code for Bo"), "the real test shows each attendee's QR");
  assert(real.bodyTextSnapshot.includes("(none)"), "a required token with no real value renders (none)");
  assert(!real.bodyTextSnapshot.includes("Check-in opens at 3:00 PM"), "the sample announcement body is not used");

  // 3. A test with no registration is still a sample preview.
  await sendTestMessage(ids.event, template.id, {
    recipientEmail: `${P}.tester@example.test`,
    recipientName: "Synthetic Tester",
    realDelivery: false,
    confirmationCode: "",
  } as never, ids.staff);
  const sample = await prisma.messageOutbox.findFirstOrThrow({
    where: { eventId: ids.event, recipientKind: "TEST", registrationId: null },
    select: { bodyTextSnapshot: true },
  });
  assert(sample.bodyTextSnapshot.includes("Check-in opens at 3:00 PM"), "a test with no registration keeps the sample body");

  console.log("announcement email verification passed");
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
