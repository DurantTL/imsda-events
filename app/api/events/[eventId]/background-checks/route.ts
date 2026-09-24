import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import { backgroundFlagsCsv } from "@/modules/background-checks/domain";
import { listEventBackgroundFlags } from "@/modules/background-checks/repository";
import { withRequestContext } from "@/lib/request-context";

/** Adults at a youth or children's event with no current background check (#388), as CSV. */
async function getHandler(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "VIEW_REPORTS", findActiveMembership);
    const flags = await listEventBackgroundFlags(eventId);
    if (!flags) {
      return Response.json(
        { error: "BACKGROUND_CHECKS_OFF", message: "This event isn't marked as a youth or children's event." },
        { status: 404 },
      );
    }
    const safeEventId = eventId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100) || "event";
    return new Response(backgroundFlagsCsv(flags.people), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeEventId}-background-checks-needed.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return backgroundCheckApiError(error, "Downloading the background check list");
  }
}

export const GET = withRequestContext(getHandler);
