"use client";

import Link from "next/link";
import type { MouseEvent } from "react";

/**
 * The "Age on event date" field for a roster person with no birth date (#639).
 * The age is used for this registration; the checkbox also saves it on the
 * roster as their reported age when the registration is saved. A birth date is
 * never written or guessed.
 */
export function ClubRosterAgeField({
  error,
  value,
  onAge,
  onSaveToRoster,
  href,
  onNavigate,
  organizationId,
  saveToRoster,
}: {
  /** What the director has typed (or the starting age), as text. */
  value: string;
  /** Shown under the field when the age is blank or not a whole number from 0 to 120. */
  error: string | null;
  onAge: (raw: string) => void;
  onSaveToRoster: (save: boolean) => void;
  /** Where the roster link goes; defaults to the plain roster page. */
  href?: string;
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void;
  organizationId: string;
  saveToRoster: boolean;
}) {
  return (
    <div className="club-roster-age">
      <label>
        Age on event date
        <input
          aria-invalid={error !== null}
          value={value}
          inputMode="numeric"
          max={120}
          min={0}
          onChange={(event) => onAge(event.target.value)}
          required
          type="number"
        />
      </label>
      {error && <small className="inline-notice error" role="alert">{error}</small>}
      <label className="checkbox-label">
        <input checked={saveToRoster} onChange={(event) => onSaveToRoster(event.target.checked)} type="checkbox" />
        <span>Also update their age on the roster</span>
      </label>
      <small className="field-help">
        No birth date on the roster.{" "}
        <Link href={href ?? `/account/clubs/${organizationId}/roster`} onClick={onNavigate}>Add their birth date on the roster</Link>
      </small>
    </div>
  );
}
