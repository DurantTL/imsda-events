"use client";

import { useId, useState } from "react";
import { Search } from "lucide-react";
import { taskNameMatches } from "@/components/event-modules-page-model";

/**
 * Hides the whole search while fewer than MORE_SEARCH_MIN_TASKS tasks and tools are actually drawn
 * (not counting the list the current screen size hides), and re-checks when the window resizes.
 */
function watchRenderedTasks(containerId: string) {
  return (box: HTMLDivElement | null) => {
    if (!box) return;
    const update = () => {
      // While a search is typed, the filter itself hides cards; leave the box alone.
      if (box.querySelector("input")?.value) return;
      const container = document.getElementById(containerId);
      const drawn = container ? [...container.querySelectorAll<HTMLElement>("[data-task-name]")].filter(isRendered).length : 0;
      box.hidden = drawn < MORE_SEARCH_MIN_TASKS;
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  };
}

/**
 * Optional task search for the More page (#743). The cards stay server-rendered
 * and are all there with scripts off; this only hides the ones whose name does
 * not match what was typed (`[data-task-name]` inside the container), then
 * hides a group left with no card. The filter touches only the `hidden`
 * attribute, so it never changes what a viewer is allowed to see.
 */
/** Tasks and tools shown on a page before the search is worth having. */
export const MORE_SEARCH_MIN_TASKS = 7;

/** Whether the browser actually draws the element: the phone-only list is display:none on desktop, and the reverse. */
const isRendered = (element: HTMLElement) => element.getClientRects().length > 0;

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
      // Count only what is drawn, so a card hidden by the screen size never inflates the number.
      if (match && isRendered(card)) visible += 1;
    });
    // A group with no matching card hides, heading and all; a blank search shows every group again.
    container.querySelectorAll<HTMLElement>("[data-task-group]").forEach((group) => {
      group.hidden = next.trim() !== "" && group.querySelectorAll("[data-task-name]:not([hidden])").length === 0;
    });
    setShown(next.trim() === "" ? null : visible);
  }

  return (
    <div className="more-task-search" ref={watchRenderedTasks(containerId)} role="search">
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
