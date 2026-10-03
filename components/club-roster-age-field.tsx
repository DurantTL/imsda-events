"use client";

import { ageInputAttributes } from "@/modules/attendee-types/age-limits";
import Link from "next/link";
import { useState, type MouseEvent } from "react";
import { ageFieldId } from "@/modules/club-registrations/roster-ages";
import { shownAgeError } from "@/modules/club-registrations/roster-age-flow";

/**
 * The "Age on event date" field for a roster person with no birth date (#639).
 * The age is used for this registration; the checkbox also saves it on the
 * roster as their reported age when the registration is saved. A birth date is
 * never written or guessed.
 *
 * The problem text stays hidden until the director has pressed Continue
 * (`attempted`) or has touched the field and left it (#718).
 */
export function ClubRosterAgeField({
  attempted = false,
  error,
  memberId,
  value,
  onAge,
  onSaveToRoster,
  href,
  newTab = false,
  onNavigate,
  organizationId,
  saveToRoster,
}: {
  /** True once Continue has been pressed and was blocked, so every missing age shows its problem. */
  attempted?: boolean;
  /** What is wrong with the age (blank, or not a whole number from 0 to 120), or null. Shown only once attempted or touched. */
  error: string | null;
  memberId: string;
  /** What the director has typed (or the starting age), as text. */
  value: string;
  onAge: (raw: string) => void;
  onSaveToRoster: (save: boolean) => void;
  /** Where the roster link goes; defaults to the plain roster page. */
  href?: string;
  /** Open the roster in a new tab, so edits that are not saved yet stay on this page. */
  newTab?: boolean;
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void;
  organizationId: string;
  saveToRoster: boolean;
}) {
  const [touched, setTouched] = useState(false);
  const inputId = ageFieldId(memberId);
  const errorId = `${inputId}-error`;
  const shownError = shownAgeError(error, attempted, touched);
  return (
    <div className="club-roster-age">
      <label className="club-roster-age-label" htmlFor={inputId}>Age on event date</label>
      <div className="club-roster-age-control">
        <input
          aria-describedby={shownError ? errorId : undefined}
          aria-invalid={shownError !== null}
          className="club-roster-age-input"
          id={inputId}
          {...ageInputAttributes}
          onBlur={() => setTouched(true)}
          onChange={(event) => onAge(event.target.value)}
          required
          type="number"
          value={value}
        />
        <span aria-hidden="true">years</span>
      </div>
      {shownError && <small className="inline-notice error" id={errorId}>{shownError}</small>}
      <label className="checkbox-label">
        <input checked={saveToRoster} onChange={(event) => onSaveToRoster(event.target.checked)} type="checkbox" />
        <span>Also update their age on the roster</span>
      </label>
      <small className="field-help">
        No birth date on the roster. Enter their age on the event date, or{" "}
        <Link
          href={href ?? `/account/clubs/${organizationId}/roster`}
          onClick={onNavigate}
          {...(newTab ? { target: "_blank", rel: "noopener" } : {})}
        >add a birth date on the roster</Link>{newTab && <> (opens in a new tab)</>}.
      </small>
    </div>
  );
}
