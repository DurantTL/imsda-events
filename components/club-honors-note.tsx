"use client";

import { useState, useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * Shown on the registered page right after submitting: the registration was
 * saved, but the honors picked while registering were not (a class filled up,
 * or the club is waitlisted, #618). Carried across the page refresh in
 * sessionStorage, and shown whether or not the class picker below renders,
 * until the director dismisses it.
 */
export function ClubHonorsNote({ eventId }: { eventId: string }) {
  const key = `club-honors-note:${eventId}`;
  const stored = useSyncExternalStore(
    subscribe,
    () => { try { return sessionStorage.getItem(key) ?? ""; } catch { return ""; } },
    () => "",
  );
  const [dismissed, setDismissed] = useState(false);
  if (!stored || dismissed) return null;
  return (
    <div className="inline-notice error" role="alert">
      {stored}{" "}
      <button
        className="text-button"
        onClick={() => {
          try { sessionStorage.removeItem(key); } catch { /* storage is optional */ }
          setDismissed(true);
        }}
        type="button"
      >
        Dismiss
      </button>
    </div>
  );
}
