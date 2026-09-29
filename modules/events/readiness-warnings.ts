import type { PrismaClient } from "@prisma/client";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import {
  getFeeWarnings,
  getLocationDateWarnings,
  unpricedFeeFieldLabels,
  type EventReadinessWarning,
} from "@/modules/events/readiness";

/**
 * The setup reminders for one event (#593): active locations with no dates,
 * and fee fields with no amount on each form's latest version. Reads only
 * structure, never registrations. They never block publishing.
 */
export async function collectEventReadinessWarnings(
  prisma: Pick<PrismaClient, "eventLocation" | "registrationFormVersion">,
  eventId: string,
): Promise<EventReadinessWarning[]> {
  const [locations, versions] = await Promise.all([
    prisma.eventLocation.findMany({
      where: { eventId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { name: true, firstDay: true, lastDay: true, isActive: true },
    }),
    prisma.registrationFormVersion.findMany({
      where: { form: { eventId } },
      orderBy: [{ formId: "asc" }, { versionNumber: "desc" }],
      distinct: ["formId"],
      select: { definition: true },
    }),
  ]);
  const feeLabels = versions.flatMap((version) => {
    const parsed = registrationFormDefinitionSchema.safeParse(version.definition);
    return parsed.success ? unpricedFeeFieldLabels(parsed.data) : [];
  });
  return [...getLocationDateWarnings(locations), ...getFeeWarnings(feeLabels)];
}
