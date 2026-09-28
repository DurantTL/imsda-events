import { getPrisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

/**
 * Fills the background-check match cache after a write that adds or edits a
 * person (#527 B5): registrations, amendments, transfers, substitutions,
 * imports, club imports, account links, and roster edits. Always called
 * after the write has committed, and best effort — a refresh failure is
 * logged and never fails the user's save. Read paths match anyone the cache
 * missed anyway (`lookupUncachedChecks`), so a skipped refresh only delays
 * the cache, never anyone's status.
 *
 * The matching engine is loaded lazily: many write paths (registrations,
 * imports) are imported by modules and tests that never touch background
 * checks, and the engine is `server-only`.
 */
export async function refreshBackgroundCheckMatchesSafely(personIds: Iterable<string | null | undefined>) {
  const ids = [...new Set([...personIds].filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return;
  try {
    const { refreshBackgroundCheckMatches } = await import("@/modules/background-checks/repository");
    await refreshBackgroundCheckMatches(ids);
  } catch (error) {
    logError("Background check match refresh failed after a save", error, { people: ids.length });
  }
}

/** The same, for everyone on the given registrations: the account holder and every attendee. */
export async function refreshBackgroundCheckMatchesForRegistrations(registrationIds: Iterable<string | null | undefined>) {
  const ids = [...new Set([...registrationIds].filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return;
  try {
    const registrations = await getPrisma().registration.findMany({
      where: { id: { in: ids } },
      select: { accountHolderPersonId: true, attendees: { select: { personId: true } } },
    });
    await refreshBackgroundCheckMatchesSafely(registrations.flatMap((registration) => [
      registration.accountHolderPersonId,
      ...registration.attendees.map((attendee) => attendee.personId),
    ]));
  } catch (error) {
    logError("Background check match refresh failed after a save", error, { registrations: ids.length });
  }
}
