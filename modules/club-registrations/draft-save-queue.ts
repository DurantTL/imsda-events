/**
 * The registration draft's save queue (#643). One save runs at a time;
 * `flush()` waits for every save in flight (including one started while it
 * waited) and resolves true only when nothing is left unsaved. A failed save
 * stays pending so a retry resends it, except after `submitted()`, which drops
 * the draft for good so a late failure can't bring a stale draft back.
 */
export function createDraftSaveQueue<T>({
  send,
  onState,
}: {
  send: (draft: T) => Promise<boolean>;
  onState?: (state: "saving" | "saved" | "error") => void;
}) {
  let pending: T | null = null;
  let inFlight: Promise<boolean> | null = null;
  let generation = 0;

  async function flush(): Promise<boolean> {
    while (inFlight) await inFlight;
    const next = pending;
    if (next === null) return true;
    pending = null;
    const started = generation;
    onState?.("saving");
    const attempt = (async () => {
      let ok = false;
      try { ok = await send(next); } catch { ok = false; }
      if (started !== generation) return true;
      if (!ok) pending ??= next;
      onState?.(ok ? "saved" : "error");
      return ok;
    })();
    inFlight = attempt;
    const ok = await attempt;
    if (inFlight === attempt) inFlight = null;
    if (!ok) return false;
    // A newer edit may have been queued while this save ran.
    return pending === null ? true : flush();
  }

  return {
    set(draft: T) { pending = draft; },
    hasPending: () => pending !== null,
    flush,
    submitted() { generation += 1; pending = null; },
  };
}
