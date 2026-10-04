"use client";

import { FieldError } from "@/components/field-error";
import { NONE_OF_US_LABEL, RESPONSIBLE_ADULT_NONE } from "@/modules/guardian-authority/domain";

export type ResponsibleAdultChoiceMinor = {
  key: string;
  name: string;
  /** Staff decided: shown, but not changeable here. */
  locked?: boolean;
};

export type ResponsibleAdultChoiceProps = {
  /** Unique per page; ids and radio group names are built from it. */
  idPrefix: string;
  minors: readonly ResponsibleAdultChoiceMinor[];
  adults: ReadonlyArray<{ key: string; name: string }>;
  /** The effective choice for each minor: an adult key or "NONE". */
  values: Readonly<Record<string, string>>;
  onChange: (minorKey: string, value: string) => void;
  /** A problem with a minor's choice, by minor key. */
  errors?: Readonly<Record<string, string>>;
  disabled?: boolean;
};

const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * "Responsible adult" for each minor on a registration (#131): a radio group per minor listing the adults on
 * the same registration and "None of us". One choice is always selected (the form preselects it), so the
 * choice cannot be left blank; submitting it is the registrant's declaration. Shared by the public form and the
 * private registration page.
 */
export function ResponsibleAdultChoice({ idPrefix, minors, adults, values, onChange, errors = {}, disabled = false }: ResponsibleAdultChoiceProps) {
  return (
    <div className="responsible-adult-choice">
      {adults.length === 0 && (
        <p className="public-registration-review-empty">
          There is no adult on this registration, so the event team will follow up about who is responsible for {minors.length === 1 ? "this minor" : "these minors"}.
        </p>
      )}
      {minors.map((minor) => {
        const groupId = `${idPrefix}_${safe(minor.key)}`;
        const error = errors[minor.key];
        const selected = values[minor.key] ?? RESPONSIBLE_ADULT_NONE;
        const options = [...adults.map((adult) => ({ value: adult.key, label: adult.name })), { value: RESPONSIBLE_ADULT_NONE, label: NONE_OF_US_LABEL }];
        return (
          <fieldset
            className={`public-registration-field${error ? " public-registration-field-invalid" : ""}`}
            id={groupId}
            key={minor.key}
            tabIndex={-1}
            aria-describedby={error ? `${groupId}_error` : undefined}
            disabled={disabled || minor.locked}
          >
            <legend>Responsible adult for <span translate="no">{minor.name}</span> <span aria-hidden="true">*</span></legend>
            {options.map((option) => (
              <label className="responsible-adult-option" key={option.value}>
                <input
                  type="radio"
                  name={groupId}
                  value={option.value}
                  checked={selected === option.value}
                  onChange={() => onChange(minor.key, option.value)}
                  required
                />
                <span translate={option.value === RESPONSIBLE_ADULT_NONE ? undefined : "no"}>{option.label}</span>
              </label>
            ))}
            {minor.locked && <small>The event team set this. Contact them to change it.</small>}
            <FieldError id={`${groupId}_error`}>{error}</FieldError>
          </fieldset>
        );
      })}
    </div>
  );
}
