import Link from "next/link";
import { Activity } from "lucide-react";
import type { ActivitySelection, EventKind } from "@/modules/events/settings-sections";

export type ActivityPanelEntry = {
  id: string;
  action: string;
  summary: string;
  actorName: string;
  createdAt: string;
};

/** Recent audit activity for the event, filtered to its type (#624). */
export function EventActivityPanel({
  eventId,
  kind,
  selection,
  showAll,
}: {
  eventId: string;
  kind: EventKind;
  selection: ActivitySelection<ActivityPanelEntry>;
  showAll: boolean;
}) {
  const label = kind === "club" ? "club" : "general";
  const { entries } = selection;
  return (
    <section className="panel">
      <div className="section-heading">
        <div><p className="eyebrow">Audit trail</p><h2>Recent activity</h2></div>
        <span className="count-badge"><Activity aria-hidden="true" size={16} /> {entries.length} {entries.length === 1 ? "entry" : "entries"}</span>
      </div>
      <div className="activity-list">
        {entries.map((entry) => (
          <article className="activity-row" key={entry.id}>
            <span className="activity-icon"><Activity aria-hidden="true" size={16} /></span>
            <span><strong>{entry.summary}</strong><small>{entry.actorName} · {new Date(entry.createdAt).toLocaleString()}</small></span>
            <code>{entry.action}</code>
          </article>
        ))}
        {entries.length === 0 && (
          <p className="quiet-copy">
            {selection.allFilteredOut
              ? `Every recent entry is for other kinds of events, so none are shown for this ${label} event.`
              : "No activity has been recorded for this event."}
          </p>
        )}
      </div>
      {selection.filtered && (
        <p className="quiet-copy">Showing activity for {label} events. <Link href={`/more?event=${eventId}&activity=all`}>Show all activity</Link></p>
      )}
      {showAll && (
        <p className="quiet-copy"><Link href={`/more?event=${eventId}`}>Show only {label} event activity</Link></p>
      )}
    </section>
  );
}
