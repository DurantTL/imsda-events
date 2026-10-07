"use client";

import { useId, useMemo, useState } from "react";
import { comboboxKeyResult, filterHonorsByWordPrefix } from "@/modules/honors/honor-search";

export type HonorComboboxOption = { id: string; name: string };

/**
 * The type-to-search honor picker (#819), used wherever a honor is chosen. An
 * ARIA 1.2 editable combobox with a listbox popup: typing filters by the start
 * of any word in the name; Arrow Up/Down move through the matches, Enter
 * chooses, Escape closes the list (and never closes a dialog around it).
 * `allLabel` adds an "All honors" choice with the empty value, for filters.
 * `name` posts the chosen id with a plain form; `onChange` reports it.
 */
export function HonorCombobox({
  options,
  value,
  onChange,
  label,
  allLabel,
  name,
  required = false,
  describedBy,
  placeholder,
}: {
  options: readonly HonorComboboxOption[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  allLabel?: string;
  name?: string;
  required?: boolean;
  describedBy?: string;
  placeholder?: string;
}) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-opt-${index}`;
  const selectedName = value ? options.find((option) => option.id === value)?.name ?? "" : (allLabel ?? "");
  const [open, setOpen] = useState(false);
  // While the list is open the field shows what was typed; closed, it shows the choice.
  const [typed, setTyped] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const query = typed ?? "";
  const matches = useMemo(() => filterHonorsByWordPrefix(options, query), [options, query]);
  const choices: HonorComboboxOption[] = useMemo(
    () => (allLabel !== undefined && query.trim() === "" ? [{ id: "", name: allLabel }, ...matches] : [...matches]),
    [allLabel, matches, query],
  );
  const safeActive = Math.min(active, Math.max(choices.length - 1, 0));

  function choose(choice: HonorComboboxOption | undefined) {
    if (!choice) return;
    onChange(choice.id);
    setTyped(null);
    setOpen(false);
  }

  function close() {
    setOpen(false);
    setTyped(null);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const result = comboboxKeyResult(event.key, { open, active: safeActive, count: choices.length });
    if (result.handled) {
      // Handled keys stay here: Enter must not submit a form around the field, Escape must not close a dialog around it.
      event.preventDefault();
      event.stopPropagation();
    }
    if (result.choose) { choose(choices[result.active]); return; }
    if (!result.open && event.key === "Tab") { close(); return; }
    setOpen(result.open);
    setActive(result.active);
    if (!result.open && event.key === "Escape" && result.handled) setTyped(null);
  }

  return (
    <div className="honor-combobox">
      <label htmlFor={`${baseId}-input`}>{label}</label>
      <input
        aria-activedescendant={open && choices.length > 0 ? optionId(safeActive) : undefined}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-describedby={describedBy}
        aria-expanded={open}
        autoComplete="off"
        id={`${baseId}-input`}
        onBlur={close}
        onChange={(event) => { setTyped(event.target.value); setOpen(true); setActive(0); }}
        onClick={() => setOpen(true)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? "Type to search honors"}
        required={required && !value}
        role="combobox"
        type="text"
        value={typed ?? selectedName}
      />
      {name && <input name={name} type="hidden" value={value} />}
      <ul
        aria-label={`${label} matches`}
        className="honor-combobox-list"
        hidden={!open}
        id={listId}
        role="listbox"
      >
        {choices.map((choice, index) => (
          <li
            aria-selected={index === safeActive}
            className={index === safeActive ? "active" : undefined}
            id={optionId(index)}
            key={choice.id || "all"}
            // mousedown, not click: the input's blur would otherwise close the list first.
            onMouseDown={(event) => { event.preventDefault(); choose(choice); }}
            role="option"
          >
            {choice.name}
          </li>
        ))}
        {choices.length === 0 && <li className="honor-combobox-empty" role="presentation">No honor matches</li>}
      </ul>
      <span aria-live="polite" className="sr-only" role="status">
        {open ? `${matches.length} ${matches.length === 1 ? "honor matches" : "honors match"}` : ""}
      </span>
    </div>
  );
}
