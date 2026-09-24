"use client";

import {
  AlertTriangle,
  CheckCheck,
  CheckCircle2,
  CheckSquare,
  ListChecks,
  UsersRound,
} from "lucide-react";
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
  /** This device's most recent result for the attendee, so a failed row reads "Needs review". */
  lastResult?: "CONFIRMED" | "QUEUED" | "CONFLICT";
};

export type ClubCheckInProgress = { current: number; total: number };

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/**
 * Who "Check in all" checks in: everyone not already checked in and not
 * held for staff review. Someone already checked in — by this device,
 * another scan, or another staff member's action in the meantime — is
 * skipped here, never re-sent, so a repeat tap never asks the server to
 * duplicate a check-in. Anyone needing review — a saved check-in stuck at
 * CONFLICT, or this device's last result for them was CONFLICT even though
 * nothing was saved to the queue — is never retried by "Check in all";
 * staff retry them on purpose through "Check in selected" or that row's own
 * retry. This is the same "Needs review" rule `clubAttendeeStatusLabel`
 * uses, so the review note below always names exactly who was left out.
 */
export function pendingAttendeeIds(attendees: ClubCheckInAttendeeView[]) {
  return attendees
    .filter((attendee) => (
      !attendee.checkedIn && clubAttendeeStatusLabel(attendee) !== "Needs review"
    ))
    .map((attendee) => attendee.id);
}

/**
 * Who "Check in selected" checks in: only the checked boxes, and only the
 * ones not already checked in. A box left checked for someone who became
 * checked in while the club view was open (e.g. confirmed by another
 * device) is dropped, matching "Check in all"'s repeat-safe behavior. A
 * ticked attendee that needs review is included: ticking is the explicit
 * choice to retry them.
 */
export function selectedPendingAttendeeIds(
  attendees: ClubCheckInAttendeeView[],
  selected: ReadonlySet<string>,
) {
  return attendees
    .filter((attendee) => !attendee.checkedIn && selected.has(attendee.id))
    .map((attendee) => attendee.id);
}

export function clubAttendeeStatusLabel(attendee: ClubCheckInAttendeeView) {
  if (attendee.checkedIn) return "Checked in";
  if (attendee.savedState === "CONFLICT" || attendee.lastResult === "CONFLICT") return "Needs review";
  if (attendee.savedState === "QUEUED" || attendee.lastResult === "QUEUED") return "Queued — not confirmed";
  return "Not yet";
}

export function clubCheckInProgressLabel(progress: ClubCheckInProgress | null | undefined) {
  return progress ? `Checking in ${progress.current} of ${progress.total}…` : "";
}

export function ClubCheckInPanel({
  organizationName,
  confirmationCode,
  amountOwedCents,
  attendees,
  canCheckIn,
  busy,
  onCheckInMany,
  progress = null,
  savedQueueUnreadable = false,
  headingLevel = 2,
  scannedAttendeeId,
  onCheckInScanned,
}: {
  organizationName: string;
  confirmationCode: string;
  /** Estimated amount billed to the church (#409), read-only; null when this event doesn't bill churches. */
  amountOwedCents: number | null;
  attendees: ClubCheckInAttendeeView[];
  canCheckIn: boolean;
  busy: boolean;
  onCheckInMany: (attendeeIds: string[]) => void | Promise<void>;
  /** Set while a bulk run is in progress: which attendee of how many. */
  progress?: ClubCheckInProgress | null;
  /** Unreadable saved-queue data blocks new check-ins until staff discard it. */
  savedQueueUnreadable?: boolean;
  /** 2 on the check-in page; 3 inside the scanner dialog, under its own h2. */
  headingLevel?: 2 | 3;
  /**
   * The person whose own QR pass was scanned. Their one-tap check-in is the
   * primary action; the whole club stays behind an explicit extra choice so
   * one late child's pass can't record the whole club as arrived.
   */
  scannedAttendeeId?: string;
  onCheckInScanned?: (attendeeId: string) => void | Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const pendingIds = useMemo(() => pendingAttendeeIds(attendees), [attendees]);
  const selectedPendingIds = useMemo(
    () => selectedPendingAttendeeIds(attendees, selected),
    [attendees, selected],
  );
  const flaggedCount = attendees.filter((attendee) => attendee.backgroundFlagged).length;
  const reviewCount = attendees.filter(
    (attendee) => clubAttendeeStatusLabel(attendee) === "Needs review",
  ).length;
  const scanned = scannedAttendeeId
    ? attendees.find((attendee) => attendee.id === scannedAttendeeId)
    : undefined;
  const actionsDisabled = !canCheckIn || busy || savedQueueUnreadable;
  const progressLabel = clubCheckInProgressLabel(progress);
  const Heading = headingLevel === 3 ? "h3" : "h2";

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

  const bulkButtonClass = scanned ? "secondary-button" : "primary-button";
  const clubActions = (
    <>
      <div className="club-check-in-actions">
        <button
          className={bulkButtonClass}
          disabled={actionsDisabled || pendingIds.length === 0}
          onClick={() => void checkInAll()}
          type="button"
        >
          <CheckCheck aria-hidden="true" size={17} />
          {progressLabel || `Check in all (${pendingIds.length})`}
        </button>
        <button
          className="secondary-button"
          disabled={actionsDisabled || selectedPendingIds.length === 0}
          onClick={() => void checkInSelected()}
          type="button"
        >
          <ListChecks aria-hidden="true" size={17} />
          Check in selected ({selectedPendingIds.length})
        </button>
      </div>
      {reviewCount > 0 && (
        <p className="club-check-in-review-note">
          {reviewCount} {reviewCount === 1 ? "person needs" : "people need"} review
          and {reviewCount === 1 ? "is" : "are"} left out of &ldquo;Check in all&rdquo;.
          Tick them and use &ldquo;Check in selected&rdquo; to retry.
        </p>
      )}

      <ul className="club-check-in-list">
        {attendees.map((attendee) => {
          const status = clubAttendeeStatusLabel(attendee);
          return (
            <li
              className={[
                status === "Needs review" ? "is-review" : "",
                attendee.id === scanned?.id ? "is-scanned" : "",
              ].filter(Boolean).join(" ") || undefined}
              key={attendee.id}
            >
              <label className="club-check-in-attendee">
                <input
                  checked={selected.has(attendee.id)}
                  disabled={actionsDisabled || attendee.checkedIn}
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
                {status === "Checked in"
                  ? <><CheckSquare aria-hidden="true" size={15} /> Checked in</>
                  : status === "Needs review"
                    ? <><AlertTriangle aria-hidden="true" size={15} /> Needs review</>
                    : status}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );

  return (
    <section aria-label={`Club check-in for ${organizationName}`} className="panel club-check-in-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Club</p>
          <Heading translate="no">{organizationName}</Heading>
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

      {savedQueueUnreadable && (
        <p className="inline-notice error club-check-in-blocked" role="alert">
          <AlertTriangle aria-hidden="true" size={15} />
          Unreadable saved check-in data is on this device. Discard it before
          checking in this club.
        </p>
      )}

      <p aria-live="polite" className="club-check-in-progress" role="status">
        {progressLabel}
      </p>

      {scanned ? (
        <>
          <div className="club-check-in-scanned">
            <div>
              <p className="eyebrow">Scanned pass</p>
              <strong translate="no">{scanned.firstName} {scanned.lastName}</strong>
              <small>{scanned.attendeeType.toLowerCase()}</small>
              {scanned.backgroundFlagged && <BackgroundCheckBadge />}
            </div>
            {scanned.checkedIn ? (
              <span className="club-check-in-status">
                <CheckSquare aria-hidden="true" size={15} /> Checked in
              </span>
            ) : scanned.savedState === "QUEUED" && scanned.lastResult !== "CONFLICT" ? (
              <span className="club-check-in-status">Queued — not confirmed</span>
            ) : (
              <button
                className="primary-button"
                disabled={actionsDisabled || !onCheckInScanned}
                onClick={() => void onCheckInScanned?.(scanned.id)}
                type="button"
              >
                <CheckCircle2 aria-hidden="true" size={17} />
                {busy && !progress
                  ? "Checking in…"
                  : clubAttendeeStatusLabel(scanned) === "Needs review"
                    ? <>Retry check-in for <span translate="no">{scanned.firstName} {scanned.lastName}</span></>
                    : <>Check in <span translate="no">{scanned.firstName} {scanned.lastName}</span></>}
              </button>
            )}
          </div>
          <details className="club-check-in-whole">
            <summary>
              Open whole club ({attendees.length}) to check in others
            </summary>
            {clubActions}
          </details>
        </>
      ) : clubActions}
    </section>
  );
}
