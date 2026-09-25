/**
 * Tells the server which event a staff member just picked, so a multi-event
 * account lands back on it at its next sign-in (#108 queue 1). The server
 * checks the choice against the account's memberships before remembering it.
 *
 * Fire-and-forget: it is only a convenience for the next sign-in, so a
 * failure is ignored and never blocks navigation. `keepalive` lets the
 * request finish even if the page navigates away first.
 */
export function rememberLastUsedEvent(eventId: string): void {
  try {
    void fetch("/api/staff/last-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Remembering the choice is optional; navigation must still happen.
  }
}
