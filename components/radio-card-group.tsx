import type { ReactNode } from "react";

export type RadioCardOption<Value extends string> = {
  value: Value;
  label: string;
  description?: ReactNode;
};

/**
 * A short choice list as radio cards (#743), used instead of a dropdown when
 * there are four options or fewer. Real radio inputs in a fieldset with a
 * legend, so arrow keys move the choice, the focus ring is the browser's own
 * made visible, and the whole card is the target (44px tall). The values are
 * the same ones the dropdown submitted.
 */
export function RadioCardGroup<Value extends string>({
  legend,
  name,
  options,
  value,
  onChange,
  help,
  id,
  required = false,
  disabled = false,
}: {
  legend: ReactNode;
  name: string;
  options: ReadonlyArray<RadioCardOption<Value>>;
  value: Value | "";
  onChange: (value: Value) => void;
  help?: ReactNode;
  /** Put on the first radio, so a "Go to" link can focus the group. */
  id?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <fieldset className="radio-card-group" disabled={disabled}>
      <legend>{legend}</legend>
      <div className="radio-card-group-options">
        {options.map((option, index) => (
          <label className="radio-card" key={option.value}>
            <input
              checked={value === option.value}
              id={index === 0 ? id : undefined}
              name={name}
              onChange={() => onChange(option.value)}
              required={required}
              type="radio"
              value={option.value}
            />
            <span>
              <strong>{option.label}</strong>
              {option.description && <small>{option.description}</small>}
            </span>
          </label>
        ))}
      </div>
      {help}
    </fieldset>
  );
}
