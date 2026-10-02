/**
 * Refreshes the local Women's Retreat demo form to the code's current
 * template (npm run db:refresh-demo).
 *
 * It goes through the application's own form workflow (save draft, run a
 * test submission, publish), never raw writes, so the definition is
 * hydrated the way the app hydrates it (club, church and attendee-type
 * choices come from the live directory) and publication is gated exactly as
 * it is for staff. It is idempotent: when the published version already
 * matches the template it changes nothing.
 *
 * The demo answers use the "Not listed" church choice, which is always valid,
 * so a clean install with an empty church directory still publishes.
 */
import { loadEnvConfig } from "@next/env";
import { assertLocalDatabase } from "./support/local-only-guard";

loadEnvConfig(process.cwd());
// Same refusal rules as the seed: a local database only, never NODE_ENV=production.
assertLocalDatabase(process.env, "refresh demo data");

const eventId = "evt_wr26";
const actorUserId = "usr_event_admin";
const formSlug = "womens-retreat-registration";
const templateKey = "womens_retreat_export";

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
  // Loaded after the guard so nothing server-side initialises on a refused run.
  const { getPrisma } = await import("../lib/prisma");
  const { formTemplates, registrationFormDefinitionSchema } = await import("../modules/forms/definition");
  const { stripAttendeeTypeOptions } = await import("../modules/attendee-types/form-options");
  const { stripDirectoryOptions } = await import("../modules/organizations/directory-form-options");
  const forms = await import("../modules/forms/repository");
  const prisma = getPrisma();
  const { RegistrationFormStatus } = await import("@prisma/client");

  const [event, actor] = await Promise.all([
    prisma.event.findUnique({ where: { id: eventId }, select: { id: true, name: true } }),
    prisma.user.findUnique({ where: { id: actorUserId }, select: { id: true, email: true } }),
  ]);
  if (!event || !actor || !actor.email.endsWith("@imsda-events.test")) {
    throw new Error("The seeded local event and test administrator must exist. Run npm run db:seed first.");
  }

  const template = formTemplates.find((candidate) => candidate.key === templateKey);
  if (!template) throw new Error(`Template ${templateKey} is unavailable.`);
  const definition = registrationFormDefinitionSchema.parse(structuredClone(template.definition));
  const storedShape = (value: unknown) =>
    stableJson(stripDirectoryOptions(stripAttendeeTypeOptions(registrationFormDefinitionSchema.parse(value))));
  const templateShape = storedShape(definition);

  const registrationResponses = {
    primary_contact_first_name: "Demo",
    primary_contact_last_name: "Registrant",
    email: "demo.registrant@example.test",
    phone: "515-555-0100",
    church: "Not listed",
    church_other: "Fictitious Demo Church",
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
      shirt_size: "Adult L",
      meal_preference: "Standard",
      childcare_needed: "No",
      volunteer: "No",
      session_1_preferences: [
        "Color Me Golden: Embracing Life in Every Season",
        "Refined by Fire, Revealed in Beauty",
      ],
      session_2_preferences: ["Repainted by Grace", "Color Me Open"],
      session_3_preferences: ["Shades of Peace", "Broken Crayons Still Color"],
      session_4_attendance: "Attending",
    },
  }];

  // The demo promo code keeps at least 25 uses available after every refresh.
  const existingLocalPromo = await prisma.promoCode.findUnique({
    where: { eventId_normalizedCode: { eventId, normalizedCode: "LOCAL10" } },
    select: { redeemedCount: true },
  });
  const localPromoMaximumUses = (existingLocalPromo?.redeemedCount ?? 0) + 25;
  await prisma.promoCode.upsert({
    where: { eventId_normalizedCode: { eventId, normalizedCode: "LOCAL10" } },
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

  let form = await prisma.registrationForm.findUnique({
    where: { eventId_slug: { eventId, slug: formSlug } },
    select: { id: true },
  });
  if (!form) {
    const created = await prisma.$transaction((tx) =>
      forms.createRegistrationFormFromTemplateInTransaction(tx, eventId, actorUserId, templateKey),
    );
    form = { id: created.id };
  }

  const current = await forms.getRegistrationForm(eventId, form.id);
  if (!current) throw new Error("The demo registration form could not be loaded.");
  const published = current.versions.find((version) => version.status === RegistrationFormStatus.PUBLISHED);
  if (published && storedShape(published.definition) === templateShape) {
    console.log(`Demo form version ${published.versionNumber} is already current.`);
  } else {
    // Save the template as the draft (a new draft beside any live version),
    // prove it with a test submission, then publish it: the staff workflow.
    const editable = current.versions.find((version) => version.status === RegistrationFormStatus.DRAFT)
      ?? current.versions[0];
    if (!editable) throw new Error("The demo registration form has no version to refresh.");
    const saved = await forms.updateRegistrationForm(eventId, form.id, actorUserId, {
      definition,
      expectedUpdatedAt: editable.updatedAt,
    });
    const draft = saved.versions.find((version) => version.status === RegistrationFormStatus.DRAFT);
    if (!draft) throw new Error("Saving the demo draft did not produce a draft version.");
    const test = await forms.createTestSubmission(eventId, form.id, actorUserId, {
      versionId: draft.id,
      responses: registrationResponses,
      attendees,
    });
    if (!test.isValid) {
      const issues = (test.validation.issues as Array<{ message: string }>)
        .map((issue) => `- ${issue.message}`)
        .join("\n");
      throw new Error(`The Women’s Retreat template is not publishable:\n${issues}`);
    }
    const result = await forms.publishRegistrationForm(eventId, form.id, actorUserId);
    const live = result.versions.find((version) => version.status === RegistrationFormStatus.PUBLISHED);
    console.log(`Published ${event.name} demo form version ${live?.versionNumber ?? draft.versionNumber}.`);
  }

  console.log("Public URL: http://localhost:3000/events/womens-retreat-2026");
  console.log("Fictitious promo code: LOCAL10 (10% off, $50 maximum, at least 25 uses remaining)");
}

main()
  .then(async () => {
    const { getPrisma } = await import("../lib/prisma");
    await getPrisma().$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    process.exit(1);
  });
