import { PrismaClient, RegistrationFormStatus } from "@prisma/client";
import { registrationFormDefinitionSchema } from "../modules/forms/definition";

const prisma = new PrismaClient();
const baseUrl = process.env.PUBLIC_REGISTRATION_TEST_URL ?? "http://localhost:3000";
const origin = new URL(baseUrl).origin;

const actorId = "usr_public_roster_verification";
const actorEmail = "roster.actor@example.test";
const eventId = "evt_public_roster_verification";
const eventSlug = "public-roster-verification-2026";
const formId = "form_public_roster_verification";
const formVersionId = "formver_public_roster_verification_1";
const formSlug = "public-roster-verification";
const settingsId = "msgset_public_roster_verification";
const submissionIdempotencyKey = "6bf7d9a7-607d-4614-8a2a-d2e0549326aa";
const capacityIdempotencyKey = "45a62cc4-041b-4a3a-8e85-e4cf18e70a53";
const registrantEmail = "roster.registrant@example.test";
const internalEmail = "roster.internal@example.test";
const attendeeNames = [
  "RosterVerify Avery",
  "RosterVerify Casey",
  "RosterVerify Wren",
] as const;

const definition = registrationFormDefinitionSchema.parse({
  title: "Public roster verification",
  description: "Temporary fictitious form used only by the local roster integration check.",
  confirmationMessage: "The roster verification registration was received.",
  attendeeRoster: {
    enabled: true,
    minAttendees: 1,
    maxAttendees: 6,
    attendeeLabel: "Attendee",
    addButtonLabel: "Add another attendee",
  },
  payment: {
    enabled: true,
    currency: "USD",
    paymentMethodFieldKey: "payment_method",
    cardOptionValue: "Credit / debit card",
    percentageBasisPoints: 290,
    fixedFeeCents: 30,
    passFeeToRegistrant: true,
  },
  sections: [
    {
      id: "roster_registration",
      title: "Registration contact",
      description: "",
      fields: [
        {
          id: "roster_contact_name",
          key: "contact_name",
          label: "Primary contact name",
          helpText: "",
          type: "TEXT",
          scope: "REGISTRATION",
          required: true,
          options: [],
        },
        {
          id: "roster_contact_email",
          key: "email",
          label: "Primary contact email",
          helpText: "",
          type: "EMAIL",
          scope: "REGISTRATION",
          required: true,
          options: [],
        },
        {
          id: "roster_payment_method",
          key: "payment_method",
          label: "Payment method",
          helpText: "",
          type: "RADIO",
          scope: "REGISTRATION",
          required: true,
          options: ["Pay later", "Credit / debit card"],
        },
        {
          id: "roster_setup_fee",
          key: "setup_fee",
          label: "Registration setup",
          helpText: "",
          type: "CALCULATED",
          scope: "REGISTRATION",
          required: false,
          options: [],
          priceCents: 500,
        },
      ],
    },
    {
      id: "roster_attendees",
      title: "Attendee roster",
      description: "",
      fields: [
        {
          id: "roster_attendee_name",
          key: "attendee_name",
          label: "Attendee name",
          helpText: "",
          type: "TEXT",
          scope: "ATTENDEE",
          required: true,
          options: [],
        },
        {
          id: "roster_attendee_type",
          key: "attendee_type",
          label: "Attendee type",
          helpText: "",
          type: "RADIO",
          scope: "ATTENDEE",
          required: true,
          options: ["Adult", "Child", "Worker"],
        },
        {
          id: "roster_lodging",
          key: "lodging",
          label: "Lodging",
          helpText: "",
          type: "RADIO",
          scope: "ATTENDEE",
          required: true,
          options: ["Shared cabin", "Commuting"],
          availabilityMode: "CAPACITY",
          choiceLimits: { "Shared cabin": 3 },
        },
        {
          id: "roster_attendee_fee",
          key: "attendee_fee",
          label: "Attendee registration",
          helpText: "",
          type: "CALCULATED",
          scope: "ATTENDEE",
          required: false,
          options: [],
          priceCents: 1000,
          conditional: {
            fieldKey: "attendee_type",
            operator: "NOT_EQUALS",
            value: "Worker",
          },
        },
      ],
    },
  ],
});

type JsonRecord = Record<string, unknown>;

function assert(condition: unknown, message: string, details?: unknown): asserts condition {
  if (condition) return;
  const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
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
      OR: [
        { normalizedEmail: registrantEmail },
        { firstName: { startsWith: "RosterVerify" } },
      ],
      heldRegistrations: { none: {} },
      registrationEvents: { none: {} },
    },
  });
  await prisma.user.deleteMany({ where: { id: actorId } });
}

const firstRequestBody = {
  versionId: formVersionId,
  idempotencyKey: submissionIdempotencyKey,
  responses: {
    contact_name: "RosterVerify Contact",
    email: registrantEmail,
    payment_method: "Credit / debit card",
  },
  attendees: [
    {
      clientId: "roster-attendee-1",
      responses: {
        attendee_name: attendeeNames[0],
        attendee_type: "Adult",
        lodging: "Shared cabin",
      },
    },
    {
      clientId: "roster-attendee-2",
      responses: {
        attendee_name: attendeeNames[1],
        attendee_type: "Child",
        lodging: "Shared cabin",
      },
    },
    {
      clientId: "roster-attendee-3",
      responses: {
        attendee_name: attendeeNames[2],
        attendee_type: "Worker",
        lodging: "Shared cabin",
      },
    },
  ],
  website: "",
};

async function postRegistration(body: JsonRecord) {
  const response = await fetch(
    `${baseUrl}/api/public/events/${eventSlug}/forms/${formSlug}/registrations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    },
  );
  return {
    status: response.status,
    body: await response.json() as JsonRecord,
  };
}

async function waitForCapturedMessages(expectedCount: number) {
  const deadline = Date.now() + 5_000;
  let messages = await prisma.messageOutbox.findMany({
    where: { eventId },
    include: { attempts: true },
    orderBy: { recipientKind: "asc" },
  });
  while (
    Date.now() < deadline
    && (
      messages.length !== expectedCount
      || messages.some((message) => message.status !== "CAPTURED" || message.attempts.length !== 1)
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    messages = await prisma.messageOutbox.findMany({
      where: { eventId },
      include: { attempts: true },
      orderBy: { recipientKind: "asc" },
    });
  }
  return messages;
}

async function main() {
  await cleanup();

  const actor = await prisma.user.create({
    data: {
      id: actorId,
      email: actorEmail,
      displayName: "Roster Verification Actor",
    },
  });
  const event = await prisma.event.create({
    data: {
      id: eventId,
      slug: eventSlug,
      name: "Public Roster Verification 2026",
      startsAt: new Date("2026-11-06T21:00:00.000Z"),
      endsAt: new Date("2026-11-08T18:00:00.000Z"),
      timezone: "America/Chicago",
      location: "Fictitious Local Test Venue",
      capacity: 4,
      isPublished: true,
    },
  });
  await prisma.eventMessageSettings.create({
    data: {
      id: settingsId,
      eventId: event.id,
      deliveryMode: "LOCAL_CAPTURE",
      senderName: "IMSDA Roster Verification",
      senderEmail: "roster.sender@example.test",
      replyToEmail: "roster.reply@example.test",
      internalNotificationEmails: [internalEmail],
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

  const first = await postRegistration(firstRequestBody);
  assert(first.status === 201, "The three-attendee registration did not succeed.", first);
  const confirmation = asRecord(first.body.confirmation);
  assert(typeof confirmation.confirmationCode === "string", "The confirmation code was missing.", first);
  assert(confirmation.attendeeCount === 3, "The confirmation did not report three attendees.", confirmation);
  assert(
    JSON.stringify(confirmation.attendeeNames) === JSON.stringify(attendeeNames),
    "The confirmation attendee names were not preserved in order.",
    confirmation,
  );
  assert(confirmation.subtotalCents === 2500, "The server-calculated roster subtotal was incorrect.", confirmation);
  assert(confirmation.processingFeeCents === 106, "The single grossed-up card fee was incorrect.", confirmation);
  assert(confirmation.totalCents === 2606, "The server-calculated roster total was incorrect.", confirmation);
  assert(confirmation.notificationStatus === "CAPTURED", "The local confirmation was not captured.", confirmation);

  const registration = await prisma.registration.findFirstOrThrow({
    where: { eventId },
    include: {
      attendees: { orderBy: { position: "asc" } },
      publicFormSubmission: true,
      capacityReservations: { orderBy: { participantKey: "asc" } },
    },
  });
  assert(registration.attendees.length === 3, "The registration did not persist three attendee rows.", registration);
  assert(
    registration.attendees.map((attendee) => attendee.position).join(",") === "0,1,2",
    "Attendee positions were not persisted in order.",
    registration.attendees,
  );
  assert(
    registration.attendees.map((attendee) => asRecord(attendee.formResponses).attendee_name).join("|")
      === attendeeNames.join("|"),
    "Per-attendee answer snapshots did not match the submitted roster.",
    registration.attendees,
  );

  const attendeeResponseSnapshot = registration.publicFormSubmission?.attendeeResponses;
  assert(
    Array.isArray(attendeeResponseSnapshot) && attendeeResponseSnapshot.length === 3,
    "The immutable public submission did not retain three attendee answer snapshots.",
    attendeeResponseSnapshot,
  );
  const pricingSnapshot = asRecord(registration.publicFormSubmission?.pricingSnapshot);
  assert(pricingSnapshot.attendeeCount === 3, "The pricing snapshot did not retain attendee count.", pricingSnapshot);
  assert(pricingSnapshot.totalCents === 2606, "The pricing snapshot did not retain the authoritative total.", pricingSnapshot);

  const cabinReservations = registration.capacityReservations.filter(
    (reservation) => reservation.fieldKey === "lodging" && reservation.optionValue === "Shared cabin",
  );
  assert(cabinReservations.length === 3, "The shared cabin was not reserved once per attendee.", cabinReservations);
  assert(
    cabinReservations.every(
      (reservation) => reservation.registrationAttendeeId
        && reservation.participantKey === reservation.registrationAttendeeId,
    ),
    "Capacity reservations were not scoped to their attendee rows.",
    cabinReservations,
  );
  assert(
    new Set(cabinReservations.map((reservation) => reservation.participantKey)).size === 3,
    "Attendee-scoped capacity keys were not unique.",
    cabinReservations,
  );

  const messages = await waitForCapturedMessages(2);
  assert(messages.length === 2, "Expected one registrant and one internal message.", messages);
  for (const message of messages) {
    assert(message.status === "CAPTURED", "A local roster message was not captured.", message);
    assert(message.attempts.length === 1, "A local roster message did not retain one attempt.", message);
    for (const attendeeName of attendeeNames) {
      assert(
        message.bodyTextSnapshot.includes(attendeeName),
        `The message snapshot omitted ${attendeeName}.`,
        message,
      );
    }
  }

  const replay = await postRegistration(firstRequestBody);
  assert(replay.status === 201, "The identical idempotent replay did not succeed.", replay);
  const replayConfirmation = asRecord(replay.body.confirmation);
  assert(
    replayConfirmation.confirmationCode === confirmation.confirmationCode,
    "The idempotent replay returned a different confirmation code.",
    replay,
  );

  const eventCapacityAttempt = await postRegistration({
    versionId: formVersionId,
    idempotencyKey: capacityIdempotencyKey,
    responses: {
      contact_name: "RosterVerify Capacity",
      email: "roster.capacity@example.test",
      payment_method: "Pay later",
    },
    attendees: [
      {
        clientId: "capacity-attendee-1",
        responses: {
          attendee_name: "RosterVerify Fourth",
          attendee_type: "Adult",
          lodging: "Commuting",
        },
      },
      {
        clientId: "capacity-attendee-2",
        responses: {
          attendee_name: "RosterVerify Fifth",
          attendee_type: "Adult",
          lodging: "Commuting",
        },
      },
    ],
    website: "",
  });
  assert(
    eventCapacityAttempt.status === 409 && eventCapacityAttempt.body.error === "EVENT_FULL",
    "A roster larger than the remaining event capacity was not rejected atomically.",
    eventCapacityAttempt,
  );

  const counts = {
    registrations: await prisma.registration.count({ where: { eventId } }),
    submissions: await prisma.publicRegistrationSubmission.count({ where: { eventId } }),
    attendees: await prisma.registrationAttendee.count({ where: { eventId } }),
    reservations: await prisma.registrationCapacityReservation.count({ where: { eventId } }),
    messages: await prisma.messageOutbox.count({ where: { eventId } }),
    attempts: await prisma.messageDeliveryAttempt.count({ where: { message: { eventId } } }),
    submissionAudits: await prisma.auditLog.count({
      where: { eventId, action: "PUBLIC_REGISTRATION_SUBMITTED" },
    }),
  };
  assert(
    JSON.stringify(counts) === JSON.stringify({
      registrations: 1,
      submissions: 1,
      attendees: 3,
      reservations: 3,
      messages: 2,
      attempts: 2,
      submissionAudits: 1,
    }),
    "Replay or event-capacity rejection created duplicate or partial records.",
    counts,
  );

  console.log(JSON.stringify({
    confirmationCode: confirmation.confirmationCode,
    attendeeNames,
    firstStatus: first.status,
    replayStatus: replay.status,
    eventCapacityStatus: eventCapacityAttempt.status,
    counts,
    scopedReservations: cabinReservations.map((reservation) => ({
      registrationAttendeeId: reservation.registrationAttendeeId,
      participantKey: reservation.participantKey,
      optionValue: reservation.optionValue,
    })),
    messages: messages.map((message) => ({
      recipientKind: message.recipientKind,
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
