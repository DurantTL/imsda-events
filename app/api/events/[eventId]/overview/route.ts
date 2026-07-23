import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership, getEventOverview } from "@/modules/events/repository";

const eventIdSchema = z.string().min(3).max(64).regex(/^[a-zA-Z0-9_-]+$/);

export async function GET(
  _request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId: rawEventId } = await context.params;
    const eventId = eventIdSchema.parse(rawEventId);
    await requirePermission(
      await getCurrentSession(),
      eventId,
      "VIEW_EVENT",
      findActiveMembership,
    );

    const overview = await getEventOverview(eventId);
    if (!overview) {
      return Response.json({ error: "EVENT_NOT_FOUND" }, { status: 404 });
    }

    return Response.json(overview);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "INVALID_EVENT_ID" }, { status: 400 });
    }
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    console.error("Unable to load event overview", error);
    return Response.json({ error: "EVENT_OVERVIEW_FAILED" }, { status: 500 });
  }
}
