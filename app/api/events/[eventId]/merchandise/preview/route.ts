import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import { getMerchandiseCatalogForProjection } from "@/modules/merchandise/catalog-repository";
import { projectMerchandiseCatalog, type MerchandiseCatalogViewer } from "@/modules/merchandise/catalog-domain";
import { withRequestContext } from "@/lib/request-context";

type Context = { params: Promise<{ eventId: string }> };

const audienceViewers: Record<string, MerchandiseCatalogViewer> = {
  anonymous: {},
  registered: { isRegisteredAttendee: true },
  staff: { isStaff: true },
};

/**
 * Staff-only preview of the exact safe DTO the requested attendee context
 * would receive: same explicit field list, same attendeeAvailability,
 * sales-window, and enabled/archived enforcement as projectMerchandiseCatalog
 * applies to any future public consumer. Unlike that future public consumer,
 * this route always fetches with the unpublished-event escape hatch and
 * always bypasses the catalog activation gate, so staff can review a draft
 * catalog before human approval — the bypass never reaches, and never
 * changes behavior for, an actual public/attendee request.
 */
async function getHandler(request: Request, context: Context) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const audience = new URL(request.url).searchParams.get("audience") ?? "registered";
    const viewer = audienceViewers[audience] ?? audienceViewers.registered;
    const raw = await getMerchandiseCatalogForProjection(eventId, { includeUnpublishedEvent: true });
    return Response.json(projectMerchandiseCatalog(raw, viewer, undefined, { bypassPublicationGate: true }));
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    return Response.json({ error: "MERCHANDISE_PREVIEW_FAILED", message: "The merchandise preview could not be built." }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
