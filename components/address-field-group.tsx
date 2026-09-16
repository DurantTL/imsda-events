"use client";

import { addressComponentKeys, type AddressValue } from "@/modules/forms/address";

const addressComponentFields: Array<{
  key: typeof addressComponentKeys[number];
  label: string;
  placeholder: string;
  autoComplete: string;
  wide?: boolean;
}> = [
  { key: "line1", label: "Address line 1", placeholder: "Street address", autoComplete: "address-line1", wide: true },
  { key: "line2", label: "Address line 2", placeholder: "Apartment, suite, or unit", autoComplete: "address-line2", wide: true },
  { key: "locality", label: "City / locality", placeholder: "City", autoComplete: "address-level2" },
  { key: "region", label: "State / province / region", placeholder: "State or province", autoComplete: "address-level1" },
  { key: "postalCode", label: "ZIP / postal code", placeholder: "Postal code", autoComplete: "postal-code" },
  { key: "country", label: "Country", placeholder: "Country", autoComplete: "country-name" },
];

/**
 * One accessible composite address field: a single `fieldset`/`legend`
 * group with the structured components (address lines, locality, region,
 * postal code, country) as its members. Shared across the public
 * registration form, the staff amendment editor, self-service attendee
 * answers, and the builder preview so the field behaves and reads
 * identically everywhere it appears.
 */
export function AddressFieldGroup({
  legend,
  idPrefix,
  value,
  onChange,
  disabled,
  required,
  invalid,
  describedBy,
  helpText,
  supporting,
  className,
}: {
  legend: React.ReactNode;
  idPrefix: string;
  value: AddressValue;
  onChange: (next: AddressValue) => void;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  helpText?: string;
  supporting?: React.ReactNode;
  className?: string;
}) {
  function updateComponent(key: typeof addressComponentKeys[number], nextValue: string) {
    const next: AddressValue = { ...value };
    if (nextValue) next[key] = nextValue;
    else delete next[key];
    onChange(next);
  }

  return (
    <fieldset
      className={["address-field-group", className].filter(Boolean).join(" ")}
      aria-invalid={invalid || undefined}
      aria-required={required || undefined}
      aria-describedby={describedBy}
    >
      <legend>{legend}</legend>
      <div className="address-field-grid">
        {addressComponentFields.map((component) => {
          const id = `${idPrefix}_${component.key}`;
          return (
            <label
              className={component.wide ? "address-field-wide" : undefined}
              htmlFor={id}
              key={component.key}
            >
              {component.label}
              {required && (component.key === "line1" || component.key === "locality" || component.key === "country") && <b> *</b>}
              <input
                id={id}
                type="text"
                value={value[component.key] ?? ""}
                disabled={disabled}
                maxLength={200}
                placeholder={component.placeholder}
                autoComplete={component.autoComplete}
                onChange={(event) => updateComponent(component.key, event.target.value)}
              />
            </label>
          );
        })}
      </div>
      {helpText && <small>{helpText}</small>}
      {supporting}
    </fieldset>
  );
}
