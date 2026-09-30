/**
 * Sends club registration drafts to the server (#659). Each save names the
 * revision it is based on and a save id for its snapshot, reused when the same
 * snapshot is retried. So:
 * - a save from another tab is refused (conflict), and after a conflict nothing
 *   more is sent;
 * - a save that landed but whose response was lost is recognised on retry by
 *   the server, and is not reported as a conflict. When a newer edit replaced
 *   that unconfirmed snapshot in the queue, it is resent first (same save id)
 *   so the newer one is based on the right revision.
 */
export const DRAFT_CONFLICT_MESSAGE = "This draft changed in another tab. Reload to see the latest version.";

/** What stops the registration being submitted: a conflicted draft first, then any class problem. */
export function draftBlockedReason({ conflict, honorsProblem }: { conflict: boolean; honorsProblem: string | null }) {
  return conflict ? DRAFT_CONFLICT_MESSAGE : honorsProblem;
}

type Attempt = "ok" | "failed" | "conflict" | "rejected";

/** Refusals that can recover (the session, the route or the server may come back); any other 4xx never will. */
const recoverableStatuses = new Set([401, 403, 404, 408, 410, 429]);

export function createDraftSender<T extends object>({
  url,
  initialRevision,
  onConflict,
  fetchImpl = (input, init) => fetch(input, init),
  newId = () => crypto.randomUUID(),
}: {
  url: string;
  initialRevision: number;
  onConflict?: () => void;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;
  newId?: () => string;
}) {
  let revision = initialRevision;
  let conflicted = false;
  let unconfirmed: T | null = null;
  const ids = new WeakMap<T, string>();

  async function attempt(snapshot: T): Promise<Attempt> {
    let saveId = ids.get(snapshot);
    if (!saveId) { saveId = newId(); ids.set(snapshot, saveId); }
    let response;
    try {
      response = await fetchImpl(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...snapshot, baseRevision: revision, saveId }),
      });
    } catch {
      unconfirmed = snapshot;
      return "failed";
    }
    if (response.ok) {
      const saved = await response.json().catch(() => null) as { revision?: number } | null;
      if (typeof saved?.revision === "number") {
        revision = saved.revision;
        if (unconfirmed === snapshot) unconfirmed = null;
      } else {
        // Saved, but the revision is unknown: resend with the same save id to learn it before anything newer.
        unconfirmed = snapshot;
      }
      return "ok";
    }
    if (response.status === 409) {
      const problem = await response.json().catch(() => null) as { error?: string } | null;
      if (problem?.error === "DRAFT_CONFLICT") {
        if (unconfirmed === snapshot) unconfirmed = null;
        conflicted = true;
        onConflict?.();
        return "conflict";
      }
    }
    if (response.status >= 500 || recoverableStatuses.has(response.status)) {
      // Doesn't say whether the save landed, and may succeed later: resent with the same save id.
      unconfirmed = snapshot;
      return "failed";
    }
    // 400, 413, 422 and other 4xx will never succeed: drop it so it can't block newer saves.
    if (unconfirmed === snapshot) unconfirmed = null;
    return "rejected";
  }

  return {
    isConflicted: () => conflicted,
    async send(snapshot: T): Promise<boolean> {
      if (conflicted) return false;
      if (unconfirmed && unconfirmed !== snapshot) {
        // A resend that can never succeed is dropped and the newer snapshot goes ahead on the current base.
        const resent = await attempt(unconfirmed);
        if (resent !== "ok" && resent !== "rejected") return false;
      }
      return (await attempt(snapshot)) === "ok";
    },
  };
}
