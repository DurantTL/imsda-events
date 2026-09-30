"use client";

import { useState, useSyncExternalStore } from "react";
import { honorsNoteKey } from "@/modules/honors/registration-picks";

const subscribe = () => () => {};

/**
 * Shown on the registered page right after submitting: the registration was
 * saved, but the honors picked while registering were not (a class filled up,
 * or the club is waitlisted, #618). Carried across the page refresh in
 * sessionStorage, and shown whether or not the class picker below renders,
 * until the director dismisses it or saves classes in the picker.
 */
export function ClubHonorsNote({ eventId, organizationId }: { eventId: string; organizationId: string }) {
  const key = honorsNoteKey(organizationId, eventId);
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
