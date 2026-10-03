import { getPrisma } from "@/lib/prisma";
import type { SetupChecklistFacts } from "@/modules/events/setup-checklist";

/**
 * Reads the counts behind the Dashboard setup checklist: how many attendee
 * types, forms, valid tests and published versions the event holds. Four cheap
 * counts and nothing else; form definitions are never read.
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
  const [activeAttendeeTypeCount, formCount, testSubmissionCount, publishedFormCount] = await Promise.all([
    prisma.eventAttendeeType.count({ where: { eventId: event.id, isActive: true } }),
    prisma.registrationForm.count({ where: { eventId: event.id } }),
    prisma.formTestSubmission.count({ where: { eventId: event.id, isValid: true } }),
    prisma.registrationFormVersion.count({ where: { form: { eventId: event.id }, status: "PUBLISHED" } }),
  ]);
  return {
    eventId: event.id,
    slug: event.slug,
    name: event.name,
    startsOn: event.startsAt?.toISOString() ?? null,
    endsOn: event.endsAt?.toISOString() ?? null,
    isPublished: event.isPublished,
    activeAttendeeTypeCount,
    formCount,
    testSubmissionCount,
    publishedFormCount,
  };
}
