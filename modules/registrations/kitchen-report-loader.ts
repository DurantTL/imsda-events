import "server-only";

import { getPrisma } from "@/lib/prisma";
import { currentAreaCoordinatorViewerActive } from "@/modules/organizations/area-coordinators";
import { listRegistrations } from "@/modules/registrations/repository";
import { KITCHEN_REPORT_STATUSES, buildKitchenReport, type KitchenReport } from "@/modules/registrations/kitchen-report";

/** The whole-event report for an event the caller has already been authorized for. */
export async function loadKitchenReport(eventId: string): Promise<KitchenReport> {
  return buildKitchenReport(await listRegistrations(eventId, { statuses: KITCHEN_REPORT_STATUSES }));
}

/**
 * The Area Coordinator path (#787). Authority is the existing coordinator check
 * (`currentAreaCoordinatorViewerActive`, the same one the area-clubs pages and
 * exports use), and only a published club-audience event qualifies, the same
 * events the coordinator's "Club events" page lists. Anyone else, or any other
 * event, reads as null (not found) before any registration is read.
 */
export async function loadAreaKitchenReport(eventId: string): Promise<{ eventName: string; report: KitchenReport } | null> {
  if (!(await currentAreaCoordinatorViewerActive())) return null;
  const event = await getPrisma().event.findUnique({ where: { id: eventId }, select: { name: true, audience: true, isPublished: true } });
  if (!event || event.audience !== "CLUB" || !event.isPublished) return null;
  return { eventName: event.name, report: await loadKitchenReport(eventId) };
}
