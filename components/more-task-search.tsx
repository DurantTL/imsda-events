"use client";

import { useId, useState } from "react";
import { Search } from "lucide-react";
import { taskNameMatches } from "@/components/event-modules-page-model";

/**
 * Optional task search for the More page (#743). The cards stay server-rendered
 * and are all there with scripts off; this only hides the ones whose name does
 * not match what was typed (`[data-task-name]` inside the container), then
 * hides a group left with no card. The filter touches only the `hidden`
 * attribute, so it never changes what a viewer is allowed to see.
 */
export function MoreTaskSearch({ containerId }: { containerId: string }) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<number | null>(null);

  function apply(next: string) {
    setQuery(next);
    const container = document.getElementById(containerId);
    if (!container) return;
    let visible = 0;
    container.querySelectorAll<HTMLElement>("[data-task-name]").forEach((card) => {
      const match = taskNameMatches(card.dataset.taskName ?? "", next);
      card.hidden = !match;
      if (match) visible += 1;
    });
    // A group with no matching card hides, heading and all; a blank search shows every group again.
    container.querySelectorAll<HTMLElement>("[data-task-group]").forEach((group) => {
      group.hidden = next.trim() !== "" && group.querySelectorAll("[data-task-name]:not([hidden])").length === 0;
    });
    setShown(next.trim() === "" ? null : visible);
  }

  return (
    <div className="more-task-search" role="search">
      <label className="search-field" htmlFor={inputId}>
        <Search aria-hidden="true" size={17} />
        <span className="sr-only">Find a task or tool</span>
        <input
          autoComplete="off"
          id={inputId}
          onChange={(event) => apply(event.target.value)}
          placeholder="Find a task or tool"
          type="search"
          value={query}
        />
      </label>
      <p aria-live="polite" className="more-task-search-status" role="status">
        {shown === null ? "" : shown === 0 ? "No task or tool matches. Clear the search to see them all." : `${shown} ${shown === 1 ? "match" : "matches"}`}
      </p>
    </div>
  );
}
