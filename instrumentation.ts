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
