import { getServerEnv, isServerEnvironmentError } from "@/lib/env";

/**
 * A cross-origin request and a misconfigured deployment are different events
 * and must not share a response. `getServerEnv()` throws on any environment
 * fault, so that throw is allowed to propagate: swallowing it here turned a
 * malformed `APP_BASE_URL` into `403 INVALID_REQUEST_ORIGIN` on every mutation
 * route in the application while reads kept working, and pointed the operator
 * at CORS instead of at the env panel.
 */
export function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const configuredOrigin = new URL(getServerEnv().APP_BASE_URL).origin;

  try {
    const browserOrigin = new URL(origin).origin;
    const requestOrigin = new URL(request.url).origin;

    return (
      browserOrigin === requestOrigin ||
      browserOrigin === configuredOrigin
    );
  } catch {
    // Only a malformed inbound Origin or request URL reaches here.
    return false;
  }
}

export function rejectCrossOriginRequest(request: Request) {
  let sameOrigin: boolean;
  try {
    sameOrigin = isSameOriginRequest(request);
  } catch (error) {
    if (!isServerEnvironmentError(error)) throw error;
    console.error(
      "Request origin could not be checked because the server environment is invalid.",
      { issues: error.issues },
    );
    return Response.json(
      {
        error: "SERVER_MISCONFIGURED",
        message:
          "The server is not configured correctly. Contact the event technology team.",
      },
      { status: 500 },
    );
  }

  return sameOrigin
    ? null
    : Response.json(
        {
          error: "INVALID_REQUEST_ORIGIN",
          message: "This request must come from the IMSDA Events workspace.",
        },
        { status: 403 },
      );
}
