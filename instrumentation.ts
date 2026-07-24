import type { Instrumentation } from "next";

/**
 * Runs once when a server instance starts, before it accepts a request.
 *
 * The environment contract is checked here so a missing
 * `ATTENDEE_PASS_SIGNING_SECRET` fails the deploy rather than check-in morning.
 * `next build` also initialises the runtime; a build has no deployment
 * environment to validate, so it is skipped.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { assertServerEnvAtStartup } = await import("@/lib/env");
  assertServerEnvAtStartup();
}

/**
 * Catches every server error Next.js sees, including ones no route handler
 * caught, and records it as one structured line with the route that produced
 * it. The error itself goes through the logger's redaction rule rather than
 * being serialised whole.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  const { logError } = await import("@/lib/logger");
  const correlationId = request.headers["x-correlation-id"];

  logError("Unhandled server error", error, {
    path: request.path,
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
    correlationId: typeof correlationId === "string" ? correlationId : undefined,
  });
};
