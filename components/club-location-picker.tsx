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
  remaining: number | null;
  full: boolean;
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
export function locationUnavailableLabel(location: Pick<ClubPickableLocation, "full" | "phase" | "isActive">, currentId: string | null, id: string) {
  // The club's own current location stays selectable while it is only full or closed for others.
  if (id === currentId && location.isActive) return null;
  if (!location.isActive) return "No longer available";
  if (location.full) return "Full";
  if (location.phase === "UPCOMING") return "Opens soon";
  if (location.phase !== "OPEN") return "Registration closed";
  return null;
}

/**
 * The event's location choice (#413): required before a club can continue
 * when the event has locations. A full location shows "Full" and can't be
 * picked; the server checks capacity again when the registration is saved.
 */
export function ClubLocationPicker({
  currentId = null,
  locations,
  onChange,
  value,
}: {
  currentId?: string | null;
  locations: ClubPickableLocation[];
  onChange: (locationId: string) => void;
  value: string | null;
}) {
  if (locations.length === 0) return null;
  return (
    <fieldset className="club-location-picker">
      <legend><MapPin aria-hidden="true" size={15} /> Choose a location</legend>
      <p className="field-help">Your club registers at one location. Its own dates and space limit apply.</p>
      <ul className="club-going-list">
        {locations.map((location) => {
          const unavailable = locationUnavailableLabel(location, currentId, location.id);
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
                      : location.remaining !== null && location.remaining <= 10
                        ? ` · ${location.remaining} ${location.remaining === 1 ? "spot" : "spots"} left`
                        : ""}
                    {!unavailable && location.registrationClosesOn ? ` · Register by ${formatCalendarDate(location.registrationClosesOn)}` : ""}
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
