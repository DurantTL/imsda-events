"use client";

import { useState } from "react";

/**
 * The field that accepts either a six-digit authenticator code or a recovery
 * code, wherever one is asked for.
 *
 * Two things it exists to get right, both of which come from how these codes
 * actually arrive rather than how they are meant to be typed.
 *
 * Password managers and phone autofill frequently deliver a code with a space
 * in it — "123 456" is what a user sees, so it is what gets copied. The server
 * trims the ends but cannot safely guess about the middle, so whitespace is
 * removed here, at the point where the intent is unambiguous. Nothing else is
 * stripped: a recovery code is `NNNNN-NNNNN`, and its dash is part of the
 * secret the server hashes.
 *
 * Autofilling a code and then having to reach for the button is the small
 * indignity this is meant to remove, so a complete code submits itself. It does
 * that only when the value arrived whole — pasted or autofilled — never while
 * someone types. Typing a recovery code passes through six digits on its way to
 * ten, and a form that submitted at that moment would fail the login and burn
 * the attempt.
 */
export function OneTimeCodeInput({
  name = "code",
  label,
  autoFocus = false,
  disabled = false,
}: {
  name?: string;
  label: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const raw = event.target.value;
    const cleaned = raw.replace(/\s+/g, "");
    setValue(cleaned);

    // `insertText` is a person at a keyboard. Anything else — a paste, an
    // autofill, a replacement — delivered the value in one piece.
    const inputType = (event.nativeEvent as InputEvent).inputType;
    const arrivedWhole = inputType !== "insertText";
    if (arrivedWhole && /^\d{6}$/.test(cleaned)) {
      event.target.form?.requestSubmit();
    }
  }

  return (
    <label>
      {label}
      <input
        name={name}
        value={value}
        onChange={handleChange}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus={autoFocus}
        disabled={disabled}
        required
        maxLength={32}
        placeholder="123456"
      />
    </label>
  );
}
