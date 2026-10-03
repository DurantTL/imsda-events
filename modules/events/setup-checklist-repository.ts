import { getPrisma } from "@/lib/prisma";
import { definitionHasPrice, type SetupChecklistFacts } from "@/modules/events/setup-checklist";

/**
 * Reads the counts behind the Dashboard setup checklist. Aggregates only: how
 * many attendee types, forms, tests and published versions the event holds.
 * Form definitions are read for field prices and never leave this function.
 */
export async function getSetupChecklistFacts(event: {
  id: string;
  slug: string;
  name: string;
  startsAt: Date | null;
  endsAt: Date | null;
  isPublished: boolean;
}): Promise<SetupChecklistFacts> {
  const prisma = getPrisma();
  const [activeAttendeeTypeCount, formCount, testSubmissionCount, publishedFormCount, versions] = await Promise.all([
    prisma.eventAttendeeType.count({ where: { eventId: event.id, isActive: true } }),
    prisma.registrationForm.count({ where: { eventId: event.id } }),
    prisma.formTestSubmission.count({ where: { eventId: event.id } }),
    prisma.registrationFormVersion.count({ where: { form: { eventId: event.id }, status: "PUBLISHED" } }),
    // The newest version of each form is the one staff are pricing.
    prisma.registrationForm.findMany({
      where: { eventId: event.id },
      select: { versions: { orderBy: { versionNumber: "desc" }, take: 1, select: { definition: true } } },
    }),
  ]);
  return {
    eventId: event.id,
    slug: event.slug,
    name: event.name,
    startsOn: event.startsAt?.toISOString() ?? null,
    endsOn: event.endsAt?.toISOString() ?? null,
    isPublished: event.isPublished,
    activeAttendeeTypeCount,
    hasPricedField: versions.some((form) => form.versions.some((version) => definitionHasPrice(version.definition))),
    formCount,
    testSubmissionCount,
    publishedFormCount,
  };
}
