import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import {
  Prisma,
  PrismaClient,
  RegistrationFormStatus,
} from "@prisma/client";
import {
  formTemplates,
  registrationFormDefinitionSchema,
} from "../modules/forms/definition";
import { preparePublicRegistration } from "../modules/forms/public-domain";

loadEnvConfig(process.cwd());

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

const parsedDatabaseUrl = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "::1"].includes(parsedDatabaseUrl.hostname)) {
  throw new Error(
    `Refusing to refresh demo data outside a local database (received ${parsedDatabaseUrl.hostname}).`,
  );
}

const eventId = "evt_wr26";
const actorUserId = "usr_event_admin";
const formId = "form_wr26_registration";
const formSlug = "womens-retreat-registration";
const templateKey = "womens_retreat_export";
const prisma = new PrismaClient();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function main() {
  const [event, actor] = await Promise.all([
    prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, name: true, timezone: true },
    }),
    prisma.user.findUnique({
      where: { id: actorUserId },
      select: { id: true, email: true },
    }),
  ]);

  if (!event || !actor || !actor.email.endsWith("@imsda-events.test")) {
    throw new Error(
      "The seeded local event and test administrator must exist. Run npm run db:seed first.",
    );
  }

  const template = formTemplates.find((candidate) => candidate.key === templateKey);
  if (!template) throw new Error(`Template ${templateKey} is unavailable.`);
  const definition = registrationFormDefinitionSchema.parse(
    structuredClone(template.definition),
  );

  const registrationResponses = {
    primary_contact_first_name: "Demo",
    primary_contact_last_name: "Registrant",
    email: "demo.registrant@example.test",
    phone: "515-555-0100",
    church: "Des Moines SDA Church",
    emergency_contact_name: "Demo Emergency Contact",
    emergency_contact_phone: "515-555-0101",
    payment_method: "Pay later",
    acknowledgment: true,
  };
  const attendees = [{
    clientId: "seed-attendee-1",
    responses: {
      first_name: "Demo",
      last_name: "Registrant",
      attendee_phone: "515-555-0100",
      attendee_type: "Adult",
      meal_preference: "Standard",
      childcare_needed: "No",
      session_1_preferences: [
        "Color Me Golden: Embracing Life in Every Season",
        "Refined by Fire, Revealed in Beauty",
      ],
      session_2_preferences: ["Repainted by Grace", "Color Me Open"],
      session_3_preferences: ["Shades of Peace", "Broken Crayons Still Color"],
      session_4_attendance: "Attending",
    },
  }];

  const prepared = preparePublicRegistration(
    definition,
    {
      versionId: "local-demo-validation",
      idempotencyKey: randomUUID(),
      responses: registrationResponses,
      attendees,
      website: "",
    },
    { timeZone: event.timezone, now: new Date("2026-07-23T12:00:00.000Z") },
  );
  if (!prepared.isValid) {
    throw new Error(
      `The Women’s Retreat template is not publishable:\n${prepared.issues
        .map((issue) => `- ${issue.message}`)
        .join("\n")}`,
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const existingLocalPromo = await tx.promoCode.findUnique({
      where: {
        eventId_normalizedCode: {
          eventId,
          normalizedCode: "LOCAL10",
        },
      },
      select: { redeemedCount: true },
    });
    const localPromoMaximumUses =
      (existingLocalPromo?.redeemedCount ?? 0) + 25;
    await tx.promoCode.upsert({
      where: {
        eventId_normalizedCode: {
          eventId,
          normalizedCode: "LOCAL10",
        },
      },
      update: {
        code: "LOCAL10",
        isActive: true,
        discountType: "PERCENT_BPS",
        discountValue: 1000,
        startsOn: null,
        endsOn: null,
        minimumSubtotalCents: 10000,
        maximumUses: localPromoMaximumUses,
        maximumDiscountCents: 5000,
      },
      create: {
        id: "promo_wr26_local10",
        eventId,
        code: "LOCAL10",
        normalizedCode: "LOCAL10",
        isActive: true,
        discountType: "PERCENT_BPS",
        discountValue: 1000,
        minimumSubtotalCents: 10000,
        maximumUses: localPromoMaximumUses,
        maximumDiscountCents: 5000,
      },
    });
    let form = await tx.registrationForm.findUnique({
      where: { id: formId },
      include: { versions: { orderBy: { versionNumber: "desc" } } },
    });

    if (!form) {
      const existingSlug = await tx.registrationForm.findUnique({
        where: { eventId_slug: { eventId, slug: formSlug } },
        include: { versions: { orderBy: { versionNumber: "desc" } } },
      });
      form = existingSlug ?? await tx.registrationForm.create({
        data: {
          id: formId,
          eventId,
          createdByUserId: actorUserId,
          name: definition.title,
          slug: formSlug,
        },
        include: { versions: { orderBy: { versionNumber: "desc" } } },
      });
    }

    if (form.eventId !== eventId) {
      throw new Error("The seeded form ID belongs to a different event.");
    }

    const currentPublished = form.versions.find(
      (version) => version.status === RegistrationFormStatus.PUBLISHED,
    );
    if (
      currentPublished
      && stableJson(currentPublished.definition) === stableJson(definition)
    ) {
      await tx.registrationForm.update({
        where: { id: form.id },
        data: { name: definition.title, status: RegistrationFormStatus.PUBLISHED },
      });
      return {
        changed: false,
        formId: form.id,
        versionNumber: currentPublished.versionNumber,
      };
    }

    await tx.registrationFormVersion.updateMany({
      where: {
        formId: form.id,
        status: {
          in: [
            RegistrationFormStatus.DRAFT,
            RegistrationFormStatus.PUBLISHED,
          ],
        },
      },
      data: { status: RegistrationFormStatus.ARCHIVED },
    });

    const nextVersionNumber = (form.versions[0]?.versionNumber ?? 0) + 1;
    const version = await tx.registrationFormVersion.create({
      data: {
        formId: form.id,
        createdByUserId: actorUserId,
        versionNumber: nextVersionNumber,
        status: RegistrationFormStatus.PUBLISHED,
        definition: definition as Prisma.InputJsonValue,
        publishedAt: new Date(),
      },
    });
    await tx.formTestSubmission.create({
      data: {
        eventId,
        formVersionId: version.id,
        submittedByUserId: actorUserId,
        responses: {
          registrationResponses: prepared.registrationResponses,
          attendees: prepared.attendees.map((attendee) => ({
            clientId: attendee.clientId,
            responses: attendee.responses,
          })),
        } as Prisma.InputJsonValue,
        validation: {
          isValid: true,
          issues: [],
          calculation: prepared.calculation,
        } as Prisma.InputJsonValue,
        isValid: true,
      },
    });
    await tx.registrationForm.update({
      where: { id: form.id },
      data: {
        name: definition.title,
        status: RegistrationFormStatus.PUBLISHED,
      },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "LOCAL_DEMO_FORM_REFRESHED",
        entityType: "RegistrationForm",
        entityId: form.id,
        correlationId: randomUUID(),
        summary: `Published the current ${template.name} demo template as version ${nextVersionNumber}.`,
        metadata: {
          templateKey,
          localFixtureRefresh: true,
          productionWrite: false,
        },
      },
    });
    return {
      changed: true,
      formId: form.id,
      versionNumber: nextVersionNumber,
    };
  });

  console.log(
    result.changed
      ? `Published ${event.name} demo form version ${result.versionNumber}.`
      : `Demo form version ${result.versionNumber} is already current.`,
  );
  console.log(`Public URL: http://localhost:3000/events/womens-retreat-2026`);
  console.log("Fictitious promo code: LOCAL10 (10% off, $50 maximum, at least 25 uses remaining)");
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
