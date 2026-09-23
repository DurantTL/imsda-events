"use client";

import { useState } from "react";

const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function split(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? { year: match[1], month: String(Number(match[2])), day: String(Number(match[3])) } : { year: "", month: "", day: "" };
}

/**
 * A birth date as month, day, and typed year (#383). The browser's date
 * wheel spins through years too fast to land on a birthday; three plain
 * fields can't run away. Submits one `YYYY-MM-DD` value under `name`, or an
 * empty one until all three parts are filled.
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
  const [parts, setParts] = useState(() => split(defaultValue));
  const complete = parts.year.length === 4 && parts.month && parts.day;
  const value = complete ? `${parts.year}-${parts.month.padStart(2, "0")}-${parts.day.padStart(2, "0")}` : "";

  return (
    <fieldset className="birth-date-field">
      <legend>{label}</legend>
      <div className="birth-date-parts">
        <select
          aria-label={`${label}: month`}
          onChange={(event) => setParts((current) => ({ ...current, month: event.target.value }))}
          required={required}
          value={parts.month}
        >
          <option value="">Month</option>
          {months.map((month, index) => <option key={month} value={String(index + 1)}>{month}</option>)}
        </select>
        <select
          aria-label={`${label}: day`}
          onChange={(event) => setParts((current) => ({ ...current, day: event.target.value }))}
          required={required}
          value={parts.day}
        >
          <option value="">Day</option>
          {Array.from({ length: 31 }, (_, index) => String(index + 1)).map((day) => <option key={day} value={day}>{day}</option>)}
        </select>
        <input
          aria-label={`${label}: year`}
          autoComplete="off"
          inputMode="numeric"
          maxLength={4}
          onChange={(event) => setParts((current) => ({ ...current, year: event.target.value.replace(/\D/g, "").slice(0, 4) }))}
          pattern="\d{4}"
          placeholder="Year"
          required={required}
          value={parts.year}
        />
      </div>
      <input name={name} type="hidden" value={value} />
    </fieldset>
  );
}
