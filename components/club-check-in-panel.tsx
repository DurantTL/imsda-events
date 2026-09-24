"use client";

import { CheckCheck, CheckSquare, ListChecks, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";
import { BackgroundCheckBadge } from "@/components/background-check-flags";

/**
 * Q1 (#412): checking in a whole club at once. Shared between the arrival
 * roster's club search and the scanner's club-code review, so scanning a
 * club's confirmation code opens the exact same view a name search finds.
 * Assignments and campsites don't exist yet (#410); this leaves a clearly
 * empty slot rather than inventing that schema.
 */

export type ClubCheckInAttendeeView = {
  id: string;
  firstName: string;
  lastName: string;
  attendeeType: string;
  checkedIn: boolean;
  backgroundFlagged: boolean;
  /** From the offline queue: undefined once confirmed or never attempted. */
  savedState?: "QUEUED" | "CONFLICT";
};

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/**
 * Who "Check in all" checks in: everyone not already checked in. Someone
 * already checked in — by this device, another scan, or another staff
 * member's action in the meantime — is skipped here, never re-sent, so a
 * repeat tap never asks the server to duplicate a check-in.
 */
export function pendingAttendeeIds(attendees: ClubCheckInAttendeeView[]) {
  return attendees.filter((attendee) => !attendee.checkedIn).map((attendee) => attendee.id);
}

/**
 * Who "Check in selected" checks in: only the checked boxes, and only the
 * ones still pending. A box left checked for someone who became checked in
 * while the club view was open (e.g. confirmed by another device) is
 * dropped, matching "Check in all"'s repeat-safe behavior.
 */
export function selectedPendingAttendeeIds(
  attendees: ClubCheckInAttendeeView[],
  selected: ReadonlySet<string>,
) {
  const pending = new Set(pendingAttendeeIds(attendees));
  return attendees
    .map((attendee) => attendee.id)
    .filter((id) => pending.has(id) && selected.has(id));
}

export function ClubCheckInPanel({
  organizationName,
  confirmationCode,
  amountOwedCents,
  attendees,
  canCheckIn,
  busy,
  onCheckInMany,
}: {
  organizationName: string;
  confirmationCode: string;
  /** Estimated amount billed to the church (#409), read-only; null when this event doesn't bill churches. */
  amountOwedCents: number | null;
  attendees: ClubCheckInAttendeeView[];
  canCheckIn: boolean;
  busy: boolean;
  onCheckInMany: (attendeeIds: string[]) => void | Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const pendingIds = useMemo(() => pendingAttendeeIds(attendees), [attendees]);
  const selectedPendingIds = useMemo(
    () => selectedPendingAttendeeIds(attendees, selected),
    [attendees, selected],
  );
  const flaggedCount = attendees.filter((attendee) => attendee.backgroundFlagged).length;

  function toggle(attendeeId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(attendeeId)) next.delete(attendeeId);
      else next.add(attendeeId);
      return next;
    });
  }

  async function checkInAll() {
    if (pendingIds.length === 0) return;
    await onCheckInMany(pendingIds);
    setSelected(new Set());
  }

  async function checkInSelected() {
    const ids = selectedPendingIds;
    if (ids.length === 0) return;
    await onCheckInMany(ids);
    setSelected(new Set());
  }

  return (
    <section aria-label={`Club check-in for ${organizationName}`} className="panel club-check-in-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Club</p>
          <h2 translate="no">{organizationName}</h2>
          <p>
            <span translate="no">{confirmationCode}</span> ·{" "}
            {attendees.length} {attendees.length === 1 ? "attendee" : "attendees"}
            {flaggedCount > 0 && (
              <> · {flaggedCount} {flaggedCount === 1 ? "flag" : "flags"}</>
            )}
          </p>
        </div>
        {amountOwedCents !== null && (
          <span className="count-badge club-billed-badge">
            {money(amountOwedCents)} billed to church
          </span>
        )}
      </div>

      <p className="club-check-in-campsite">
        <UsersRound aria-hidden="true" size={15} />
        Campsite and assignments aren&rsquo;t available yet.
      </p>

      <div className="club-check-in-actions">
        <button
          className="primary-button"
          disabled={!canCheckIn || busy || pendingIds.length === 0}
          onClick={() => void checkInAll()}
          type="button"
        >
          <CheckCheck aria-hidden="true" size={17} />
          Check in all ({pendingIds.length})
        </button>
        <button
          className="secondary-button"
          disabled={!canCheckIn || busy || selectedPendingIds.length === 0}
          onClick={() => void checkInSelected()}
          type="button"
        >
          <ListChecks aria-hidden="true" size={17} />
          Check in selected ({selectedPendingIds.length})
        </button>
      </div>

      <ul className="club-check-in-list">
        {attendees.map((attendee) => (
          <li key={attendee.id}>
            <label className="club-check-in-attendee">
              <input
                checked={selected.has(attendee.id)}
                disabled={!canCheckIn || attendee.checkedIn || busy}
                onChange={() => toggle(attendee.id)}
                type="checkbox"
              />
              <span>
                <strong translate="no">{attendee.firstName} {attendee.lastName}</strong>
                <small>{attendee.attendeeType.toLowerCase()}</small>
                {attendee.backgroundFlagged && <BackgroundCheckBadge />}
              </span>
            </label>
            <span className="club-check-in-status">
              {attendee.checkedIn
                ? <><CheckSquare aria-hidden="true" size={15} /> Checked in</>
                : attendee.savedState === "CONFLICT"
                  ? "Needs review"
                  : attendee.savedState === "QUEUED"
                    ? "Queued — not confirmed"
                    : "Not yet"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
