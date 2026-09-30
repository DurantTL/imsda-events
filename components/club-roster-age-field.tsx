"use client";

import Link from "next/link";

/**
 * The "Age on event date" field for a roster person with no birth date (#639).
 * The age is used for this registration; the checkbox also saves it on the
 * roster as their reported age when the registration is saved. A birth date is
 * never written or guessed.
 */
export function ClubRosterAgeField({
  age,
  invalid,
  onAge,
  onSaveToRoster,
  onNavigate,
  organizationId,
  saveToRoster,
}: {
  age: number | undefined;
  invalid: boolean;
  onAge: (raw: string) => void;
  onSaveToRoster: (save: boolean) => void;
  onNavigate?: () => void;
  organizationId: string;
  saveToRoster: boolean;
}) {
  return (
    <div className="club-roster-age">
      <label>
        Age on event date
        <input
          aria-invalid={invalid}
          defaultValue={age ?? ""}
          inputMode="numeric"
          max={120}
          min={0}
          onChange={(event) => onAge(event.target.value)}
          required
          type="number"
        />
      </label>
      <label className="checkbox-label">
        <input checked={saveToRoster} onChange={(event) => onSaveToRoster(event.target.checked)} type="checkbox" />
        <span>Also update their age on the roster</span>
      </label>
      <small className="field-help">
        No birth date on the roster.{" "}
        <Link href={`/account/clubs/${organizationId}/roster`} onClick={onNavigate}>Add their birth date on the roster</Link>
      </small>
    </div>
  );
}
