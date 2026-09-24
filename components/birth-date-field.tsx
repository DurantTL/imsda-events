"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseRosterBirthDateInput } from "@/modules/club-rosters/domain";

const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2014-03-09" → "3/9/2014", for the box's starting text. */
function typedFrom(iso: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return "";
  return `${Number(match[2])}/${Number(match[3])}/${match[1]}`;
}

function describe(iso: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return "";
  return `${monthNames[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

/**
 * A birth date typed as month/day/year (#424), for example `04/17/2014` or
 * `4/17/14`. Replaces the old month/day/year dropdowns: the browser's date
 * wheel spins through years too fast to land on a birthday, and three plain
 * fields can't run away either, but a director copying dates from a paper
 * roster wants to just type them. Shows the parsed date back so it can be
 * checked. Submits one `YYYY-MM-DD` value under `name`, or an empty one
 * until the typed text is a real date.
 */
export function BirthDateField({
  name,
  label,
  defaultValue = "",
  required = false,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
}) {
  const [text, setText] = useState(() => typedFrom(defaultValue));
  const parsed = useMemo(() => (text.trim() ? parseRosterBirthDateInput(text) : null), [text]);
  const invalid = text.trim().length > 0 && parsed === null;
  const inputRef = useRef<HTMLInputElement>(null);

  // A typed date that isn't real (or, if required, isn't there at all) blocks
  // submission the same way a required dropdown once did.
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.setCustomValidity(invalid ? "Enter a date like 4/17/2014, or 4/17/14." : "");
  }, [invalid]);

  return (
    <label className="birth-date-field">
      {label}
      <input
        aria-describedby={`${name}-parsed`}
        aria-invalid={invalid}
        autoComplete="off"
        inputMode="numeric"
        onChange={(event) => setText(event.target.value)}
        placeholder="M/D/YYYY"
        ref={inputRef}
        required={required}
        value={text}
      />
      <span className="field-help birth-date-parsed" id={`${name}-parsed`}>
        {parsed ? `Reads as ${describe(parsed)}.` : invalid ? "Enter a date like 4/17/2014, or 4/17/14." : "Month/day/year, e.g. 4/17/2014."}
      </span>
      <input name={name} type="hidden" value={parsed ?? ""} />
    </label>
  );
}
