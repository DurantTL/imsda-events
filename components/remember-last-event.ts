/**
 * Tells the server which event a staff member just picked. It becomes the
 * current event for pages opened without `?event=` (#616) and the default at
 * the next sign-in (#108 queue 1). The server checks the choice against the
 * account's memberships before remembering it.
 *
 * Never rejects: a failure is ignored and never blocks navigation. The
 * promise resolves once the request settles so callers can refresh the
 * server default. `keepalive` lets the request finish even if the page
 * navigates away first.
 */
export async function rememberLastUsedEvent(eventId: string): Promise<void> {
  try {
    await fetch("/api/staff/last-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId }),
      keepalive: true,
    });
  } catch {
    // Remembering the choice is optional; navigation must still happen.
  }
}
