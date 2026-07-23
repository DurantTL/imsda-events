import { randomUUID } from "node:crypto";
import { PrismaClient, RegistrationFormStatus } from "@prisma/client";
import { registrationFormDefinitionSchema } from "../modules/forms/definition";

const prisma = new PrismaClient();
const baseUrl = process.env.PUBLIC_REGISTRATION_TEST_URL ?? "http://localhost:3000";
const eventSlug = "womens-retreat-2026";
const formId = "form_public_capacity_verification";
const formVersionId = "formver_public_capacity_verification_1";
const formSlug = "public-capacity-verification";
const testEmails = ["capacity.one@example.test", "capacity.two@example.test"];

const definition = registrationFormDefinitionSchema.parse({
  title: "Public capacity verification",
  description: "Temporary fictitious form used only by the local integration check.",
  confirmationMessage: "The capacity verification registration was received.",
  sections: [{
    id: "capacity_contact",
    title: "Contact and room",
    description: "One final room is available.",
    fields: [
      { id: "capacity_first", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
      { id: "capacity_last", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
      { id: "capacity_email", key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
      { id: "capacity_room", key: "room", label: "Room", helpText: "", type: "RADIO", scope: "REGISTRATION", required: true, options: ["Final room", "No room"], availabilityMode: "CAPACITY", choiceLimits: { "Final room": 1 } },
    ],
  }],
});

async function cleanup() {
  const registrations = await prisma.registration.findMany({
    where: { publicFormSubmission: { formVersionId } },
    select: { id: true },
  });
  const registrationIds = registrations.map((registration) => registration.id);
  if (registrationIds.length > 0) {
    await prisma.messageOutbox.deleteMany({ where: { registrationId: { in: registrationIds } } });
    await prisma.auditLog.deleteMany({ where: { action: "PUBLIC_REGISTRATION_SUBMITTED", entityId: { in: registrationIds } } });
    await prisma.registration.deleteMany({ where: { id: { in: registrationIds } } });
  }
  await prisma.registrationForm.deleteMany({ where: { id: formId } });
  await prisma.person.deleteMany({ where: { normalizedEmail: { in: testEmails }, heldRegistrations: { none: {} }, registrationEvents: { none: {} } } });
}

async function main() {
  await cleanup();
  const event = await prisma.event.findUnique({ where: { slug: eventSlug }, select: { id: true, isPublished: true } });
  const actor = await prisma.user.findUnique({ where: { email: "admin@imsda-events.test" }, select: { id: true } });
  if (!event?.isPublished || !actor) throw new Error("The published local event and fixture administrator are required.");

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

  const requests = testEmails.map((email, index) => fetch(`${baseUrl}/api/public/events/${eventSlug}/forms/${formSlug}/registrations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({
      versionId: formVersionId,
      idempotencyKey: randomUUID(),
      responses: { first_name: `Capacity${index + 1}`, last_name: "Tester", email, room: "Final room" },
      website: "",
    }),
  }));
  const responses = await Promise.all(requests);
  const results = await Promise.all(responses.map(async (response) => ({ status: response.status, body: await response.json() })));
  const statuses = results.map((result) => result.status).sort((left, right) => left - right);
  const [submissionCount, reservationCount] = await Promise.all([
    prisma.publicRegistrationSubmission.count({ where: { formVersionId } }),
    prisma.registrationCapacityReservation.count({ where: { formVersionId, optionValue: "Final room", releasedAt: null } }),
  ]);

  if (statuses[0] !== 201 || statuses[1] !== 409 || submissionCount !== 1 || reservationCount !== 1) {
    throw new Error(`Capacity verification failed: ${JSON.stringify({ statuses, submissionCount, reservationCount, results })}`);
  }
  console.log(JSON.stringify({ statuses, submissionCount, reservationCount, conflict: results.find((result) => result.status === 409)?.body }, null, 2));
}

main()
  .finally(cleanup)
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
