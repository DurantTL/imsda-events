import type { PrismaClient } from "@prisma/client";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import {
  getFeeWarnings,
  getLocationDateWarnings,
  unpricedFeeFieldLabels,
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
  const feeLabels = latestForms.flatMap((form) => {
    const definition = published.get(form.id) ?? form.versions[0]?.definition;
    const parsed = registrationFormDefinitionSchema.safeParse(definition);
    return parsed.success ? unpricedFeeFieldLabels(parsed.data) : [];
  });
  return [...getLocationDateWarnings(locations), ...getFeeWarnings(feeLabels)];
}
