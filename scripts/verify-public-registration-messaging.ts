import { loadEnvConfig } from "@next/env";
import { PrismaClient, RegistrationFormStatus } from "@prisma/client";
import { registrationFormDefinitionSchema } from "../modules/forms/definition";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const baseUrl = process.env.PUBLIC_REGISTRATION_TEST_URL ?? "http://localhost:3000";
const origin = new URL(baseUrl).origin;

const actorId = "usr_public_messaging_verification";
const actorEmail = "messaging.actor@example.test";
const eventId = "evt_public_messaging_verification";
const eventSlug = "public-messaging-verification-2026";
const formId = "form_public_messaging_verification";
const formVersionId = "formver_public_messaging_verification_1";
const formSlug = "public-messaging-verification";
const settingsId = "msgset_public_messaging_verification";
const idempotencyKey = "9d527f52-5ccb-43a8-a1b5-7c3176b5188e";
const registrantEmail = "messaging.registrant@example.test";
const internalEmails = [
  "messaging.internal.one@example.test",
  "messaging.internal.two@example.test",
] as const;

const definition = registrationFormDefinitionSchema.parse({
  title: "Public messaging verification",
  description: "Temporary fictitious form used only by the local messaging integration check.",
  confirmationMessage: "The messaging verification registration was received.",
  sections: [{
    id: "messaging_contact",
    title: "Contact details",
    description: "",
    fields: [
      {
        id: "messaging_first_name",
        key: "first_name",
        label: "First name",
        helpText: "",
        type: "TEXT",
        scope: "REGISTRATION",
        required: true,
        options: [],
      },
      {
        id: "messaging_last_name",
        key: "last_name",
        label: "Last name",
        helpText: "",
        type: "TEXT",
        scope: "REGISTRATION",
        required: true,
        options: [],
      },
      {
        id: "messaging_email",
        key: "email",
        label: "Email",
        helpText: "",
        type: "EMAIL",
        scope: "REGISTRATION",
        required: true,
        options: [],
      },
      {
        id: "messaging_fee",
        key: "registration_fee",
        label: "Registration fee",
        helpText: "",
        type: "CALCULATED",
        scope: "REGISTRATION",
        required: false,
        options: [],
        priceCents: 12500,
      },
    ],
  }],
});

type JsonRecord = Record<string, unknown>;

function assert(condition: unknown, message: string, details?: unknown): asserts condition {
  if (condition) return;
  const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

async function cleanup() {
  await prisma.messageOutbox.deleteMany({ where: { eventId } });
  await prisma.auditLog.deleteMany({ where: { eventId } });
  await prisma.registration.deleteMany({ where: { eventId } });
  await prisma.registrationForm.deleteMany({ where: { eventId } });
  await prisma.eventMessageTemplate.deleteMany({ where: { eventId } });
  await prisma.eventMessageSettings.deleteMany({ where: { eventId } });
  await prisma.event.deleteMany({ where: { id: eventId } });
  await prisma.person.deleteMany({
    where: {
      normalizedEmail: registrantEmail,
      heldRegistrations: { none: {} },
      registrationEvents: { none: {} },
    },
  });
  await prisma.user.deleteMany({ where: { id: actorId } });
}

async function postRegistration() {
  const response = await fetch(
    `${baseUrl}/api/public/events/${eventSlug}/forms/${formSlug}/registrations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        versionId: formVersionId,
        idempotencyKey,
        responses: {
          first_name: "Messaging",
          last_name: "Registrant",
          email: registrantEmail,
        },
        website: "",
      }),
    },
  );
  const body = await response.json() as JsonRecord;
  return { status: response.status, body };
}

async function loadMessages() {
  return prisma.messageOutbox.findMany({
    where: { eventId },
    include: { attempts: { orderBy: { attemptNumber: "asc" } } },
    orderBy: [{ recipientKind: "asc" }, { recipientEmail: "asc" }],
  });
}

async function waitForLocalCapture(expectedCount: number) {
  const deadline = Date.now() + 5_000;
  let messages = await loadMessages();
  while (
    Date.now() < deadline
    && (
      messages.length !== expectedCount
      || messages.some((message) => message.status !== "CAPTURED" || message.attempts.length !== 1)
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    messages = await loadMessages();
  }
  return messages;
}

function confirmationCodeFrom(body: JsonRecord) {
  const confirmation = body.confirmation;
  assert(
    confirmation && typeof confirmation === "object" && !Array.isArray(confirmation),
    "The public response did not include a confirmation object.",
    body,
  );
  const code = (confirmation as JsonRecord).confirmationCode;
  assert(typeof code === "string" && code.length > 0, "The confirmation code was missing.", body);
  assert(
    (confirmation as JsonRecord).notificationStatus === "CAPTURED",
    "The public response must report the committed local confirmation capture.",
    body,
  );
  assert(
    (confirmation as JsonRecord).emailSent === false,
    "Local capture must never report a real email as sent.",
    body,
  );
  return code;
}

async function main() {
  await cleanup();

  const actor = await prisma.user.create({
    data: {
      id: actorId,
      email: actorEmail,
      displayName: "Messaging Verification Actor",
    },
  });
  const event = await prisma.event.create({
    data: {
      id: eventId,
      slug: eventSlug,
      name: "Public Messaging Verification 2026",
      startsAt: new Date("2026-11-06T21:00:00.000Z"),
      endsAt: new Date("2026-11-08T18:00:00.000Z"),
      timezone: "America/Chicago",
      location: "Fictitious Local Test Venue",
      capacity: 25,
      isPublished: true,
    },
  });
  await prisma.eventMessageSettings.create({
    data: {
      id: settingsId,
      eventId: event.id,
      deliveryMode: "LOCAL_CAPTURE",
      senderName: "IMSDA Messaging Verification",
      senderEmail: "messaging.sender@example.test",
      replyToEmail: "messaging.reply@example.test",
      internalNotificationEmails: [...internalEmails],
    },
  });
  await prisma.registrationForm.create({
    data: {
      id: formId,
      eventId: event.id,
      createdByUserId: actor.id,
      name: definition.title,
      slug: formSlug,
      status: RegistrationFormStatus.PUBLISHED,
      versions: {
        create: {
          id: formVersionId,
          createdByUserId: actor.id,
          versionNumber: 1,
          status: RegistrationFormStatus.PUBLISHED,
          publishedAt: new Date(),
          definition,
        },
      },
    },
  });

  const first = await postRegistration();
  assert(first.status === 201, "The first public registration did not succeed.", first);
  const confirmationCode = confirmationCodeFrom(first.body);

  const expectedMessageCount = 1 + internalEmails.length;
  const firstMessages = await waitForLocalCapture(expectedMessageCount);
  assert(
    firstMessages.length === expectedMessageCount,
    "The registration did not queue one registrant message plus every configured internal message.",
    firstMessages,
  );

  const registrantMessages = firstMessages.filter((message) => message.recipientKind === "REGISTRANT");
  const internalMessages = firstMessages.filter((message) => message.recipientKind === "INTERNAL");
  assert(registrantMessages.length === 1, "Expected exactly one registrant message.", firstMessages);
  assert(
    registrantMessages[0].recipientEmail === registrantEmail,
    "The registrant message used the wrong recipient.",
    registrantMessages[0],
  );
  assert(
    registrantMessages[0].templateKey === "REGISTRATION_CONFIRMATION_UNPAID",
    "A positive unpaid balance must use the unpaid confirmation template.",
    registrantMessages[0],
  );
  assert(
    internalMessages.length === internalEmails.length,
    "Expected one internal message per configured internal recipient.",
    internalMessages,
  );
  assert(
    internalMessages.map((message) => message.recipientEmail).sort().join("|")
      === [...internalEmails].sort().join("|"),
    "Internal messages did not match the configured recipients.",
    internalMessages,
  );
  assert(
    internalMessages.every((message) => message.templateKey === "INTERNAL_NEW_REGISTRATION"),
    "Internal recipients must use the internal registration template.",
    internalMessages,
  );

  for (const message of firstMessages) {
    assert(message.status === "CAPTURED", "Local delivery must finish as CAPTURED.", message);
    assert(message.attemptCount === 1, "Each new local message must have one attempt.", message);
    assert(message.capturedAt !== null, "A captured message must record capturedAt.", message);
    assert(message.sentAt === null, "Local capture must never be marked as externally sent.", message);
    assert(message.attempts.length === 1, "Each message must retain one delivery attempt.", message);
    assert(message.attempts[0].attemptNumber === 1, "The first delivery attempt number must be 1.", message);
    assert(message.attempts[0].status === "CAPTURED", "The local attempt must be CAPTURED.", message);
    assert(message.attempts[0].completedAt !== null, "A captured attempt must have a completion time.", message);
    assert(message.subjectSnapshot.includes(event.name), "The message subject must contain the event name.", message);
    assert(message.bodyTextSnapshot.includes(confirmationCode), "The message body must contain the confirmation code.", message);
    assert(!/\{\{[^{}]+\}\}/.test(message.subjectSnapshot), "The subject contains an unresolved token.", message);
    assert(!/\{\{[^{}]+\}\}/.test(message.bodyTextSnapshot), "The body contains an unresolved token.", message);
  }
  assert(
    new Set(firstMessages.map((message) => message.idempotencyKey)).size === expectedMessageCount,
    "Every queued recipient must have a distinct message idempotency key.",
    firstMessages,
  );

  const beforeReplayCounts = {
    registrations: await prisma.registration.count({ where: { eventId } }),
    submissions: await prisma.publicRegistrationSubmission.count({ where: { eventId } }),
    attendees: await prisma.registrationAttendee.count({ where: { eventId } }),
    messages: await prisma.messageOutbox.count({ where: { eventId } }),
    attempts: await prisma.messageDeliveryAttempt.count({ where: { message: { eventId } } }),
    submissionAudits: await prisma.auditLog.count({
      where: { eventId, action: "PUBLIC_REGISTRATION_SUBMITTED" },
    }),
  };
  assert(
    JSON.stringify(beforeReplayCounts) === JSON.stringify({
      registrations: 1,
      submissions: 1,
      attendees: 1,
      messages: expectedMessageCount,
      attempts: expectedMessageCount,
      submissionAudits: 1,
    }),
    "The initial registration did not commit the expected atomic records.",
    beforeReplayCounts,
  );

  const replay = await postRegistration();
  assert(replay.status === 201, "An identical idempotent replay did not succeed.", replay);
  assert(
    confirmationCodeFrom(replay.body) === confirmationCode,
    "The idempotent replay returned a different confirmation code.",
    replay,
  );

  const afterReplayCounts = {
    registrations: await prisma.registration.count({ where: { eventId } }),
    submissions: await prisma.publicRegistrationSubmission.count({ where: { eventId } }),
    attendees: await prisma.registrationAttendee.count({ where: { eventId } }),
    messages: await prisma.messageOutbox.count({ where: { eventId } }),
    attempts: await prisma.messageDeliveryAttempt.count({ where: { message: { eventId } } }),
    submissionAudits: await prisma.auditLog.count({
      where: { eventId, action: "PUBLIC_REGISTRATION_SUBMITTED" },
    }),
  };
  assert(
    JSON.stringify(afterReplayCounts) === JSON.stringify(beforeReplayCounts),
    "The idempotent replay created duplicate registration or messaging records.",
    { beforeReplayCounts, afterReplayCounts },
  );

  console.log(JSON.stringify({
    confirmationCode,
    firstStatus: first.status,
    replayStatus: replay.status,
    counts: afterReplayCounts,
    messages: firstMessages.map((message) => ({
      recipientKind: message.recipientKind,
      recipientEmail: message.recipientEmail,
      templateKey: message.templateKey,
      status: message.status,
      attemptStatus: message.attempts[0]?.status,
    })),
  }, null, 2));
}

main()
  .finally(cleanup)
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
