"use client";

import { useId, useState, type InputHTMLAttributes } from "react";
import { inlinePhoneProblem, inputAttributesFor } from "@/lib/field-validation";

type PhoneInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue" | "onChange" | "inputMode"> & {
  /** What the message calls the field, for example "Phone". */
  label: string;
  /** The value saved on the record now. A number equal to it is an old one left alone and only warns (#871). */
  stored?: string | null;
  /** Controlled use: pass `value` and `onValueChange`. Otherwise the input keeps its own value, so a plain form post still sees `name`. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Show the message now, not only after the person leaves the field (a failed save attempt). */
  showNow?: boolean;
};

/**
 * A phone input with the shared inline message (#871). Drop it inside the existing label. A changed number that is
 * not a valid phone shows the fixable message after the person leaves the field; an old saved number left as it is
 * is flagged "needs correcting" but never blocks. The server decides again from the stored value. The message
 * describes the problem and never repeats the number.
 */
export function PhoneInput({ label, stored, value, defaultValue = "", onValueChange, showNow = false, ...rest }: PhoneInputProps) {
  const [own, setOwn] = useState(defaultValue);
  const [left, setLeft] = useState(false);
  const messageId = useId();
  const current = value ?? own;
  const problem = inlinePhoneProblem(label, current, stored, left || showNow);
  const attributes = inputAttributesFor("phone");
  return (
    <>
      <input
        autoComplete={attributes.autoComplete}
        maxLength={40}
        {...rest}
        aria-describedby={problem.message ? messageId : rest["aria-describedby"]}
        aria-invalid={problem.blocking && problem.message ? true : undefined}
        inputMode={attributes.inputMode}
        onBlur={(event) => {
          setLeft(true);
          rest.onBlur?.(event);
        }}
        onChange={(event) => {
          setOwn(event.target.value);
          onValueChange?.(event.target.value);
        }}
        type={attributes.type}
        value={current}
      />
      {problem.message ? <small className={problem.blocking ? "field-error field-error-message phone-input-message is-error" : "phone-input-message is-notice"} id={messageId} role={problem.blocking ? "alert" : "status"}>{problem.message}</small> : null}
    </>
  );
}

/** True when a changed phone would fail the shared check, for a submit handler to stop on. */
export function phoneBlocks(label: string, value: string, stored?: string | null) {
  return inlinePhoneProblem(label, value, stored, true).blocking;
}
