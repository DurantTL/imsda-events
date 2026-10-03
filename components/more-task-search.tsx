"use client";

import { useId, useState } from "react";
import { Search } from "lucide-react";
import { filterTasks } from "@/components/event-modules-page-model";

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
    const cardElements = [...container.querySelectorAll<HTMLElement>("[data-task-name]")];
    const groupElements = [...container.querySelectorAll<HTMLElement>("[data-task-group]")];
    // Start from everything shown, so what the browser draws does not depend on the previous query.
    [...cardElements, ...groupElements].forEach((element) => { element.hidden = false; });
    const result = filterTasks({
      query: next,
      cards: cardElements.map((card, index) => ({
        id: String(index),
        name: card.dataset.taskName ?? "",
        groupIds: groupElements.flatMap((group, groupIndex) => (group.contains(card) ? [String(groupIndex)] : [])),
        drawn: isRendered(card),
      })),
    });
    cardElements.forEach((card, index) => { card.hidden = !result.shownCardIds.has(String(index)); });
    groupElements.forEach((group, index) => { group.hidden = !result.shownGroupIds.has(String(index)); });
    setShown(next.trim() === "" ? null : result.count);
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
