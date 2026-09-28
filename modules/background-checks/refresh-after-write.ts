import { after } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

/**
 * Fills the background-check match cache after a write that adds or edits a
 * person (#527 B5): registrations and their status changes, answer edits,
 * amendments, transfers, substitutions, imports, club imports, account
 * links, attendee-type backfills, and roster edits. Always after the write
 * has committed, and never in the user's way:
 *
 * - Inside a request (a route handler or server function) the refresh is
 *   scheduled with Next's `after()`, so the response never waits on it.
 *   Outside one (a script, a test) it runs inline.
 * - It is best effort: a failure is logged and never fails the save.
 * - The refresh itself only try-locks (`refreshBackgroundCheckMatches`):
 *   while an upload holds the list, it is skipped rather than waited on.
 *
 * Nothing is lost when a refresh is skipped: every read path matches anyone
 * the cache missed (`lookupUncachedChecks`), and the next upload's full pass
 * recomputes everyone.
 *
 * The matching engine is loaded lazily: many write paths are imported by
 * modules and tests that never touch background checks, and the engine is
 * `server-only`.
 */
function runAfterResponse(work: () => Promise<void>): Promise<void> {
  try {
    after(work);
    return Promise.resolve();
  } catch {
    // Not inside a request scope: nothing to defer past, so run it now.
    return work();
  }
}

function distinct(values: Iterable<string | null | undefined>) {
  return [...new Set([...values].filter((value): value is string => typeof value === "string" && value.length > 0))];
}

async function refreshNow(ids: string[]) {
  try {
    const { refreshBackgroundCheckMatches } = await import("@/modules/background-checks/repository");
    await refreshBackgroundCheckMatches(ids);
  } catch (error) {
    logError("Background check match refresh failed after a save", error, { people: ids.length });
  }
}

export async function refreshBackgroundCheckMatchesSafely(personIds: Iterable<string | null | undefined>) {
  const ids = distinct(personIds);
  if (ids.length === 0) return;
  await runAfterResponse(() => refreshNow(ids));
}

/** The same, for everyone on the given registrations: the account holder and every attendee. */
export async function refreshBackgroundCheckMatchesForRegistrations(registrationIds: Iterable<string | null | undefined>) {
  const ids = distinct(registrationIds);
  if (ids.length === 0) return;
  await runAfterResponse(async () => {
    try {
      const registrations = await getPrisma().registration.findMany({
        where: { id: { in: ids } },
        select: { accountHolderPersonId: true, attendees: { select: { personId: true } } },
      });
      const personIds = distinct(registrations.flatMap((registration) => [
        registration.accountHolderPersonId,
        ...registration.attendees.map((attendee) => attendee.personId),
      ]));
      if (personIds.length > 0) await refreshNow(personIds);
    } catch (error) {
      logError("Background check match refresh failed after a save", error, { registrations: ids.length });
    }
  });
}
