import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { sanitizeCustomHtml } from "@/modules/events/content-html";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ eventId: string }> };

const previewSchema = z.object({ html: z.string().max(20000) }).strict();

/**
 * Shows a system administrator exactly what the sanitizer will keep from the
 * custom HTML they typed, before they save or publish. System administrators
 * only, like the block itself; the output is the same function the save and
 * the public render use.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "CONFIGURE_EVENT",
      findActiveMembership,
    );
    if (access.user.globalRole !== "SYSTEM_ADMIN") {
      return Response.json(
        { error: "CUSTOM_HTML_FORBIDDEN", message: "Only a system administrator can use custom HTML." },
        { status: 403 },
      );
    }
    const { html } = previewSchema.parse(await request.json());
    return Response.json({ html: sanitizeCustomHtml(html) });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return Response.json(
        { error: "INVALID_HTML_PREVIEW", message: "Send the HTML as text, under 20,000 characters." },
        { status: 400 },
      );
    }
    logError("Previewing custom HTML failed", error);
    return Response.json(
      { error: "HTML_PREVIEW_FAILED", message: "The preview could not be built." },
      { status: 500 },
    );
  }
}

export const POST = withRequestContext(postHandler);
