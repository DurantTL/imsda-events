import { z } from "zod";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import {
  getSystemReadiness,
  ReadinessError,
  tickReadinessItem,
  untickReadinessItem,
} from "@/modules/system-admin/readiness-repository";

/**
 * The System readiness checklist is global, so it is gated on the global role, like platform settings. Viewing and
 * ticking are both system-administrator only, checked here on the server. Ticking records a person's confirmation
 * and performs nothing.
 */
async function requireSystemAdmin() {
  const { user } = await getCurrentSession();
  if (!user || user.globalRole !== "SYSTEM_ADMIN") return null;
  return user;
}

function forbidden() {
  return Response.json(
    { error: "SYSTEM_ADMIN_REQUIRED", message: "Only a system administrator can use the system readiness checklist." },
    { status: 403 },
  );
}

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tick"), key: z.string().min(1).max(80), note: z.string().max(1000).nullish() }).strict(),
  z.object({ action: z.literal("untick"), key: z.string().min(1).max(80), reason: z.string().max(1000).nullish() }).strict(),
]);

async function getHandler() {
  const user = await requireSystemAdmin();
  if (!user) return forbidden();
  return Response.json({ readiness: await getSystemReadiness() }, { headers: { "Cache-Control": "no-store" } });
}

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  const user = await requireSystemAdmin();
  if (!user) return forbidden();
  try {
    const body = bodySchema.parse(await request.json());
    const actor = { id: user.id, displayName: user.displayName };
    if (body.action === "tick") await tickReadinessItem(body.key, actor, body.note);
    else await untickReadinessItem(body.key, actor, body.reason);
    return Response.json({ readiness: await getSystemReadiness() });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "INVALID_READINESS_REQUEST", message: "Review the request and try again." },
        { status: 400 },
      );
    }
    if (error instanceof ReadinessError) {
      const status = error.code === "UNKNOWN_ITEM" ? 404 : error.code === "ALREADY_TICKED" || error.code === "NOT_TICKED" ? 409 : 400;
      return Response.json({ error: error.code, message: error.message }, { status });
    }
    if (error instanceof SyntaxError) {
      return Response.json({ error: "INVALID_JSON", message: "The request is not valid JSON." }, { status: 400 });
    }
    logError("Updating the system readiness checklist failed", error);
    return Response.json(
      { error: "SYSTEM_READINESS_UPDATE_FAILED", message: "The checklist could not be updated." },
      { status: 500 },
    );
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
