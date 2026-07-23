import { getServerEnv } from "@/lib/env";

export function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    const browserOrigin = new URL(origin).origin;
    const requestOrigin = new URL(request.url).origin;
    const configuredOrigin = new URL(getServerEnv().APP_BASE_URL).origin;

    return (
      browserOrigin === requestOrigin ||
      browserOrigin === configuredOrigin
    );
  } catch {
    return false;
  }
}

export function rejectCrossOriginRequest(request: Request) {
  return isSameOriginRequest(request)
    ? null
    : Response.json(
        {
          error: "INVALID_REQUEST_ORIGIN",
          message: "This request must come from the IMSDA Events workspace.",
        },
        { status: 403 },
      );
}
