"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { filterSearchableChoices } from "@/modules/forms/searchable-choice";

export type SearchableSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export function SearchableSelect({
  id,
  value,
  options,
  required = false,
  placeholder = "Search choices…",
  describedBy,
  invalid = false,
  sheet = false,
  onChange,
}: {
  id: string;
  value: string;
  options: readonly SearchableSelectOption[];
  required?: boolean;
  placeholder?: string;
  describedBy?: string;
  invalid?: boolean;
  /** On a phone, show the open list as a bottom sheet (public registration only). */
  sheet?: boolean;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listId = `${id}_choices`;
  const selectedLabel = options.find((option) => option.value === value)?.label
    ?? value;
  const filteredOptions = useMemo(
    () => filterSearchableChoices(options, query ?? ""),
    [options, query],
  );

  // On a phone the open list is a bottom sheet (CSS, #743). It sits above the
  // on-screen keyboard: --searchable-sheet-inset is how far the keyboard covers
  // the layout viewport, so the search box and the choices stay visible together.
  useEffect(() => {
    const viewport = window.visualViewport;
    const wrapper = wrapperRef.current;
    if (!sheet || !open || !viewport || !wrapper) return;
    function update() {
      if (!viewport || !wrapper) return;
      const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      wrapper.style.setProperty("--searchable-sheet-inset", `${Math.round(covered)}px`);
    }
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      wrapper.style.removeProperty("--searchable-sheet-inset");
    };
  }, [open, sheet]);

  function choose(nextValue: string) {
    const option = options.find((candidate) => candidate.value === nextValue);
    if (!option || option.disabled) return;
    onChange(option.value);
    setQuery(null);
    setOpen(false);
  }

  function close() {
    setOpen(false);
    setQuery(null);
  }

  return (
    <div
      className={`searchable-select${sheet ? " is-sheet-picker" : ""}`}
      ref={wrapperRef}
      onBlur={(event) => {
        if (!wrapperRef.current?.contains(event.relatedTarget as Node | null)) {
          close();
        }
      }}
    >
      <div className="searchable-select-control">
        <Search size={16} aria-hidden="true" />
        <input
          id={id}
          type="search"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          required={required}
          value={query ?? selectedLabel}
          placeholder={placeholder}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={
            open && activeIndex >= 0 && filteredOptions[activeIndex]
              ? `${listId}_${activeIndex}`
              : undefined
          }
          aria-describedby={describedBy}
          aria-invalid={invalid}
          onFocus={(event) => {
            setOpen(true);
            setActiveIndex(-1);
            event.currentTarget.select();
            // On a phone the list is a bottom sheet over the lower part of the screen: lift the box clear of it.
            if (sheet && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 768px)").matches) {
              event.currentTarget.scrollIntoView({ block: "start", behavior: "smooth" });
            }
          }}
          onChange={(event) => {
            const nextQuery = event.target.value;
            setQuery(nextQuery);
            setOpen(true);
            setActiveIndex(-1);
            if (value && nextQuery !== value) onChange("");
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => Math.min(
                index + 1,
                Math.max(0, filteredOptions.length - 1),
              ));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => Math.max(0, index - 1));
            } else if (event.key === "Enter" && open) {
              event.preventDefault();
              const option = filteredOptions[activeIndex];
              if (option) choose(option.value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              // An open list takes the Escape; it must not also close an attendee sheet around it.
              if (open) event.stopPropagation();
              close();
            }
          }}
        />
        {value ? (
          <button
            type="button"
            aria-label="Clear selection"
            onClick={() => {
              onChange("");
              setQuery("");
              setOpen(true);
            }}
          >
            <X size={15} aria-hidden="true" />
          </button>
        ) : (
          <ChevronDown size={16} aria-hidden="true" />
        )}
      </div>
      {open && (
        <div className="searchable-select-options" id={listId} role="listbox">
          {filteredOptions.length === 0 ? (
            <p>No matching choices. Try another search.</p>
          ) : filteredOptions.map((option, index) => (
            <button
              id={`${listId}_${index}`}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={index === activeIndex ? "is-active" : ""}
              disabled={option.disabled}
              key={option.value}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option.value)}
            >
              <span>{option.label}</span>
              {option.value === value && <small>Selected</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
