import type { PrismaClient } from "@prisma/client";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import {
  getDuplicatePublicFormWarnings,
  getFeeWarnings,
  getLocationDateWarnings,
  getPaymentOnChurchBilledWarnings,
  unpricedFeeFields,
  type EventReadinessWarning,
} from "@/modules/events/readiness";

/**
 * The setup reminders for one event (#593): active locations never edited and without dates,
 * and fee fields with no amount on each form's published version (else its latest draft). Reads only
 * structure, never registrations. They never block publishing.
 */
export async function collectEventReadinessWarnings(
  prisma: Pick<PrismaClient, "eventLocation" | "registrationForm">,
  eventId: string,
  billingMode?: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE" | null,
): Promise<EventReadinessWarning[]> {
  const [locations, publishedForms, latestForms] = await Promise.all([
    prisma.eventLocation.findMany({
      where: { eventId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { name: true, firstDay: true, lastDay: true, isActive: true, createdAt: true, updatedAt: true },
    }),
    // Bounded reads, one version per form: the newest published version, and the newest of any status.
    prisma.registrationForm.findMany({
      where: { eventId },
      select: { id: true, versions: { where: { status: "PUBLISHED" }, take: 1, orderBy: { versionNumber: "desc" }, select: { definition: true } } },
    }),
    prisma.registrationForm.findMany({
      where: { eventId },
      select: { id: true, versions: { take: 1, orderBy: { versionNumber: "desc" }, select: { definition: true } } },
    }),
  ]);
  // The published version when there is one, else the latest draft.
  const published = new Map(publishedForms.map((form) => [form.id, form.versions[0]?.definition]));
  const parsedForms = latestForms.flatMap((form) => {
    const parsed = registrationFormDefinitionSchema.safeParse(published.get(form.id) ?? form.versions[0]?.definition);
    return parsed.success ? [{ formId: form.id, definition: parsed.data }] : [];
  });
  // Only forms with a live (published) version are shown to the public.
  const publiclyListed = publishedForms.flatMap((form) => {
    const parsed = registrationFormDefinitionSchema.safeParse(form.versions[0]?.definition);
    return parsed.success ? [{ title: parsed.data.title, description: parsed.data.description }] : [];
  });
  const feeFields = parsedForms.flatMap(({ formId, definition }) => unpricedFeeFields(definition, formId));
  const paymentFormTitles = parsedForms.filter(({ definition }) => definition.payment?.enabled).map(({ definition }) => definition.title);
  return [...getLocationDateWarnings(locations), ...getFeeWarnings(feeFields, eventId), ...getPaymentOnChurchBilledWarnings(billingMode, paymentFormTitles), ...getDuplicatePublicFormWarnings(publiclyListed, eventId)];
}
