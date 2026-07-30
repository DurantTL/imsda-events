import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { attendeeCommunityActionSchema } from "@/modules/community/domain";
import {
  acceptCommunityConduct,
  CommunityError,
  createCommunityPost,
  markCommunityNotificationsRead,
  reportCommunityPost,
  updateCommunityNotifications,
} from "@/modules/community/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: { ...privateHeaders, ...init?.headers },
  });
}

function apiError(error: unknown) {
  if (error instanceof z.ZodError) {
    return json({
      error: "INVALID_COMMUNITY_ACTION",
      message: error.issues[0]?.message ?? "Review the community action and try again.",
      issues: error.issues,
    }, { status: 400 });
  }
  if (error instanceof CommunityError) {
    return json({ error: error.code, message: error.message }, { status: error.status });
  }
  logError("Attendee community request failed", error);
  return json({
    error: "COMMUNITY_REQUEST_FAILED",
    message: "The community action could not be completed.",
  }, { status: 500 });
}

async function postHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const current = await getCurrentAttendee();
    if (current.via !== "attendee" || !current.account) {
      return json({ message: "Sign in as an attendee to use the community." }, { status: 401 });
    }
    const input = attendeeCommunityActionSchema.parse(await request.json());
    switch (input.action) {
      case "ACCEPT_CONDUCT":
        await acceptCommunityConduct(current.account, eventId);
        break;
      case "UPDATE_NOTIFICATIONS":
        await updateCommunityNotifications(current.account, eventId, input.preference);
        break;
      case "CREATE_POST":
        await createCommunityPost(current.account, eventId, input);
        break;
      case "REPORT_POST":
        await reportCommunityPost(current.account, eventId, input);
        break;
      case "MARK_NOTIFICATIONS_READ":
        await markCommunityNotificationsRead(current.account, eventId);
        break;
    }
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

export const POST = withRequestContext(postHandler);
