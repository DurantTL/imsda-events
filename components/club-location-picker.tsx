"use client";

import { MapPin } from "lucide-react";
import { formatCalendarDate } from "@/modules/club-registrations/domain";

export type ClubPickableLocation = {
  id: string;
  name: string;
  address: string | null;
  firstDay: string;
  lastDay: string;
  registrationClosesOn: string | null;
  /** Set only when the location closes on a date other than the event's. */
  ownClosingDate?: string | null;
  /** Seats left. Left out for the public "Group" page (#650), which never shows seat counts. */
  remaining?: number | null;
  full: boolean;
  /** The event's waitlist is on (#599): a full location can still be picked, and the club joins its waitlist. */
  waitlistOnFull?: boolean;
  phase: "DRAFT" | "UPCOMING" | "OPEN" | "CLOSED";
  open: boolean;
  isActive: boolean;
};

function dateRange(location: Pick<ClubPickableLocation, "firstDay" | "lastDay">) {
  return location.firstDay === location.lastDay
    ? formatCalendarDate(location.firstDay)
    : `${formatCalendarDate(location.firstDay)} to ${formatCalendarDate(location.lastDay)}`;
}

/** Why a location can't be picked, or null when it can. */
export function locationUnavailableLabel(
  location: Pick<ClubPickableLocation, "full" | "phase" | "isActive"> & { waitlistOnFull?: boolean },
  currentId: string | null,
  id: string,
  allowWaitlist = false,
) {
  // The club's own current location stays selectable while it is only full or closed for others.
  if (id === currentId && location.isActive) return null;
  if (!location.isActive) return "No longer available";
  // A new registration may join a full location's waitlist when the event has one (#599).
  if (location.full && !(allowWaitlist && location.waitlistOnFull)) return "Full";
  if (location.phase === "UPCOMING") return "Opens soon";
  if (location.phase !== "OPEN") return "Registration closed";
  return null;
}

/**
 * The event's location choice (#413): required before a club can continue
 * when the event has locations. A full location shows "Full" and can't be
 * picked, unless a new registration is allowed to join the event's waitlist
 * (`allowWaitlist`, #599), which is said on the option. The server checks
 * capacity again when the registration is saved.
 */
export function ClubLocationPicker({
  allowWaitlist = false,
  currentId = null,
  locations,
  noun = "club",
  onChange,
  value,
}: {
  allowWaitlist?: boolean;
  currentId?: string | null;
  locations: ClubPickableLocation[];
  /** Who registers at the location, in the words the page uses (a "Group", #650). */
  noun?: "club" | "group";
  onChange: (locationId: string) => void;
  value: string | null;
}) {
  if (locations.length === 0) return null;
  return (
    <fieldset className="club-location-picker">
      <legend><MapPin aria-hidden="true" size={15} /> Choose a location</legend>
      <p className="field-help">Your {noun} registers at one location. Its own dates and space limit apply.</p>
      <ul className="club-going-list">
        {locations.map((location) => {
          const unavailable = locationUnavailableLabel(location, currentId, location.id, allowWaitlist);
          const joinsWaitlist = !unavailable && allowWaitlist && location.full && Boolean(location.waitlistOnFull) && location.id !== currentId;
          return (
            <li key={location.id}>
              <label className="checkbox-label">
                <input
                  checked={value === location.id}
                  disabled={unavailable !== null}
                  name="club-location"
                  onChange={() => onChange(location.id)}
                  type="radio"
                />
                <span>
                  <strong translate="no">{location.name}</strong>
                  <small>
                    {dateRange(location)}
                    {location.address ? <> · <span translate="no">{location.address}</span></> : ""}
                    {unavailable
                      ? <> · <strong>{unavailable}</strong></>
                      : joinsWaitlist
                        ? <> · <strong>Full. You can join the waitlist for this location.</strong></>
                      : location.remaining != null && location.remaining <= 10
                        ? ` · ${location.remaining} ${location.remaining === 1 ? "spot" : "spots"} left`
                        : ""}
                    {!unavailable && location.ownClosingDate ? ` · Register by ${formatCalendarDate(location.ownClosingDate)}` : ""}
                  </small>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
