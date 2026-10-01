"use client";

import { useRef } from "react";
import { CalendarDays } from "lucide-react";

/**
 * A date question (#719). The browser's own empty date can show today's date
 * (Safari), so an empty one shows an "mm/dd/yyyy" hint over it instead; a
 * "Choose date" button (a 44px target) and a click anywhere in the field open
 * the picker where `showPicker` exists, and otherwise focus the input. A
 * locked one (a private link's signing date) is read-only with no picker.
 */
export function DateInput({
  value,
  bounds,
  required = false,
  locked = false,
  onChange,
}: {
  value: string;
  bounds?: { min?: string; max?: string };
  required?: boolean;
  locked?: boolean;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  function openPicker() {
    const input = inputRef.current;
    if (!input || locked) return;
    try {
      if (typeof input.showPicker === "function") {
        input.showPicker();
        return;
      }
    } catch {
      // showPicker throws when it is not allowed here (no user activation, or a frame); fall back to focus.
    }
    input.focus();
  }
  return (
    <span className={`club-form-date${value ? "" : " is-empty"}${locked ? " is-locked" : ""}`}>
      <input
        max={bounds?.max}
        min={bounds?.min}
        onChange={(event) => onChange(event.target.value)}
        onClick={openPicker}
        readOnly={locked}
        ref={inputRef}
        required={required}
        type="date"
        value={value}
      />
      {!value && <span aria-hidden="true" className="club-form-date-hint">mm/dd/yyyy</span>}
      {!locked && (
        <button aria-label="Choose date" className="club-form-date-button" onClick={openPicker} title="Choose date" type="button">
          <CalendarDays aria-hidden="true" size={18} />
        </button>
      )}
    </span>
  );
}
