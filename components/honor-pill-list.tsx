"use client";

import { useId, useState } from "react";
import { Award } from "lucide-react";
import {
  type CurrentMemberHonor,
  honorPillWindow,
  memberHonorStatusLabels,
} from "@/modules/honors/member-honor-domain";

/**
 * One member's current honors as pills (#790). A member with many honors would
 * push their row to full page height, so the list shows the first few and
 * offers "Show all (N)" / "Show fewer". Expanded, the list scrolls inside a
 * capped height instead of stretching the table row. Shared by the club
 * Honors page and the roster card, which the club portal, the admin club view
 * and the Area Coordinator view all render.
 *
 * `showStatus` adds "In progress" / "Completed" to each pill, in its own span
 * that never shrinks (the Honors page); the roster keeps the compact icon form,
 * where colour carries status.
 */
export function HonorPillList({
  honors,
  showStatus = false,
  withIcon = false,
}: {
  honors: readonly CurrentMemberHonor[];
  showStatus?: boolean;
  withIcon?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const pills = honorPillWindow(honors, expanded);
  if (pills.total === 0) return <>—</>;
  // Collapsed pills stay in the page, `hidden`, so a printout still lists every honor.
  // An expanded list scrolls inside a capped height, so it is a keyboard stop.
  const scrolls = expanded && pills.collapsible;
  return (
    <div className="honor-pill-cell">
      <div
        aria-label={scrolls ? `All ${pills.total} honors` : undefined}
        className={`roster-flag-list honor-pill-list${scrolls ? " expanded" : ""}`}
        id={listId}
        role={scrolls ? "group" : undefined}
        tabIndex={scrolls ? 0 : undefined}
      >
        {honors.map((honor, index) => {
          const statusLabel = memberHonorStatusLabels[honor.status];
          return (
            <span
              className={`status-chip honor-pill ${honor.status === "COMPLETED" ? "green" : "gold"}`}
              hidden={index >= pills.visible.length}
              key={honor.honorId}
              title={`${honor.honorName}: ${statusLabel}${honor.completionDate ? ` ${honor.completionDate}` : ""}`}
            >
              {withIcon && <Award aria-hidden="true" size={12} />}
              <span className="honor-pill-text">{honor.honorName}</span>
              {/* Its own span, so a long name is what gets cut with an ellipsis, never the status. */}
              {showStatus && <span className="honor-pill-status">{statusLabel}</span>}
            </span>
          );
        })}
      </div>
      {pills.collapsible && (
        <button
          aria-controls={listId}
          aria-expanded={expanded}
          className="text-button honor-pill-toggle honor-pill-toggle-screen"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? "Show fewer" : `Show all (${pills.total})`}
        </button>
      )}
    </div>
  );
}
