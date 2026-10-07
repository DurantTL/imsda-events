"use client";

import { useId, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { filterHonorsByWordPrefix } from "@/modules/honors/honor-search";

export type HonorMultiSelectOption = { id: string; name: string; code: string };

/** The most matches drawn at once; the catalog can hold hundreds, and typing narrows it. */
const MAX_LISTED = 80;

/**
 * Choose one or more honors from the catalog for one class (#812): a
 * type-to-search box (the #819 word-prefix rule) over a checkbox list. The
 * chosen honors stay listed above the search in the order they were chosen;
 * the first is the class's primary honor. The parent owns `value`; nothing is
 * posted by the field.
 */
export function HonorMultiSelect({
  options,
  value,
  onChange,
  label = "Honors",
}: {
  options: readonly HonorMultiSelectOption[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  label?: string;
}) {
  const baseId = useId();
  const [query, setQuery] = useState("");
  const byId = useMemo(() => new Map(options.map((option) => [option.id, option])), [options]);
  const chosen = new Set(value);
  const matches = useMemo(() => filterHonorsByWordPrefix(options, query), [options, query]);
  const listed = matches.slice(0, MAX_LISTED);

  function toggle(id: string) {
    onChange(chosen.has(id) ? value.filter((existing) => existing !== id) : [...value, id]);
  }

  return (
    <fieldset className="honor-bulk-members honor-multi-select">
      <legend>{label}</legend>
      <ul aria-label={`Chosen honors (${value.length})`} className="honor-multi-chosen">
        {value.map((id, index) => {
          const option = byId.get(id);
          return (
            <li key={id}>
              <span translate="no">{option ? `${option.name} (${option.code})` : id}</span>
              {index === 0 && value.length > 1 && <small>primary</small>}
              <button aria-label={`Remove ${option?.name ?? "honor"}`} className="text-button" onClick={() => toggle(id)} type="button">Remove</button>
            </li>
          );
        })}
        {value.length === 0 && <li className="field-help">No honor chosen yet.</li>}
      </ul>
        <div className="honor-bulk-members-tools">
          <label className="honor-name-search">
            <span className="sr-only">Search the honor catalog</span>
            <span className="honor-name-search-field">
              <Search aria-hidden="true" size={14} />
              <input
                autoComplete="off"
                id={`${baseId}-search`}
                onChange={(event) => setQuery(event.target.value)}
                // Enter in the search box must not submit the class form.
                onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
                placeholder="Type to search honors"
                type="search"
                value={query}
              />
            </span>
          </label>
        </div>
        <ul className="honor-bulk-member-list" data-testid="honor-multi-options">
          {listed.map((honor) => (
            <li key={honor.id}>
              <label className="checkbox-hit">
                <input checked={chosen.has(honor.id)} onChange={() => toggle(honor.id)} type="checkbox" />
                <span>
                  <strong translate="no">{honor.name}</strong>
                  <small translate="no">{honor.code}</small>
                </span>
              </label>
            </li>
          ))}
          {matches.length === 0 && <li className="field-help">No honor matches that search.</li>}
          {matches.length > listed.length && <li className="field-help">Showing the first {listed.length} of {matches.length}. Type more to narrow the list.</li>}
        </ul>
    </fieldset>
  );
}
