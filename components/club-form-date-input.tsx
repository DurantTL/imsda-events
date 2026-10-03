"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { CalendarDays } from "lucide-react";
import { DateGuidance } from "@/components/date-guidance";
import { CALENDAR_DATE_GUIDANCE, parseTypedDate } from "@/modules/forms/typed-date";

/**
 * A date question (#719). The browser's own empty date can show today's date
 * (Safari), so an empty one shows an "mm/dd/yyyy" hint over it instead; a
 * "Choose date" button (a 44px target) and a click anywhere in the field open
 * the picker where `showPicker` exists, and otherwise focus the input. A
 * locked one (a private link's signing date) is read-only with no picker.
 *
 * Typing works too (#743): on a desktop (a fine pointer) a click goes straight
 * to the date parts so the year can be typed, and only the calendar button opens
 * the picker; a pasted "M/D/YYYY" is read into the date. The value stays
 * YYYY-MM-DD, and the helper line says how to type it.
 */
function prefersTyping() {
  try {
    return typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;
  } catch {
    return false;
  }
}

export function DateInput({
  label,
  labelText,
  help,
  className,
  value,
  bounds,
  required = false,
  locked = false,
  onChange,
}: {
  /** The visible label content; it labels the input only, so the button's name stays out of the input's. */
  label: ReactNode;
  /** Plain text of the label, for the button's accessible name. */
  labelText: string;
  help?: ReactNode;
  className?: string;
  value: string;
  bounds?: { min?: string; max?: string };
  required?: boolean;
  locked?: boolean;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const guidanceId = `${id}-guidance`;
  // A partly typed date (month and day only) leaves `value` empty but is not empty to the person typing:
  // keep its digits visible instead of hiding them under the hint (#733).
  const [partial, setPartial] = useState(false);
  function syncPartial() {
    setPartial(Boolean(inputRef.current?.validity.badInput));
  }
  function openPicker(fromInput = false) {
    const input = inputRef.current;
    if (!input || locked) return;
    // A click in a filled field is for editing its parts; only an empty one opens the picker.
    if (fromInput && input.value) return;
    // A fine pointer is a desktop: the person is about to type, so don't cover the field with the picker.
    if (fromInput && prefersTyping()) return;
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
    <div className={`club-form-date-field${className ? ` ${className}` : ""}`}>
      <label htmlFor={id}>{label}</label>
      <span className={`club-form-date${value || partial ? "" : " is-empty"}${locked ? " is-locked" : ""}`}>
        <input
          id={id}
          aria-describedby={guidanceId}
          max={bounds?.max}
          min={bounds?.min}
          onBlur={syncPartial}
          onChange={(event) => {
            onChange(event.target.value);
            syncPartial();
          }}
          onInput={syncPartial}
          onKeyUp={syncPartial}
          onClick={() => openPicker(true)}
          onPaste={(event) => {
            if (locked) return;
            const typed = parseTypedDate(event.clipboardData.getData("text"));
            if (!typed) return;
            event.preventDefault();
            onChange(typed);
          }}
          readOnly={locked}
          ref={inputRef}
          required={required}
          type="date"
          value={value}
        />
        {!value && !partial && <span aria-hidden="true" className="club-form-date-hint">mm/dd/yyyy</span>}
        {!locked && (
          <button aria-label={`Choose date for ${labelText}`} className="club-form-date-button" onClick={() => openPicker()} title="Choose date" type="button">
            <CalendarDays aria-hidden="true" size={18} />
          </button>
        )}
      </span>
      {locked
        ? <small className="field-help club-form-date-guidance" id={guidanceId}>This date is set and cannot be changed.</small>
        : <DateGuidance className="club-form-date-guidance" id={guidanceId} typed={CALENDAR_DATE_GUIDANCE} />}
      {help}
    </div>
  );
}
