"use client";

import { useState } from "react";
import { CheckCircle2, Download, Trophy } from "lucide-react";
import { TEAM_LEVELS, teamLabel, teamLevelLabels, type TeamLevel } from "@/modules/club-teams/domain";
import type { TeamResultView, TeamResultsRow } from "@/modules/club-teams/results-domain";

type Draft = { placement: string; qualified: boolean; notes: string };

const draftOf = (result: TeamResultView | null): Draft => ({ placement: result?.placement ?? "", qualified: result?.qualified ?? false, notes: result?.notes ?? "" });

/**
 * One level of one team's result (#809): staff type a placement or score, tick whether the team qualified for the next
 * level, and add a note. Saving a blank level clears it. Read only without the permission to manage registrations.
 */
function LevelEditor({
  eventId,
  row,
  level,
  canEdit,
  onSaved,
}: {
  eventId: string;
  row: TeamResultsRow;
  level: TeamLevel;
  canEdit: boolean;
  onSaved: (result: TeamResultView | null) => void;
}) {
  const stored = row.results[level];
  const [draft, setDraft] = useState<Draft>(() => draftOf(stored));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const base = `team-result-${row.clubEventRegistrationId}-${level}`;
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(stored));
  const label = teamLabel(row.clubName, row.teamName);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/team-results/${encodeURIComponent(row.clubEventRegistrationId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level, ...draft }),
      });
      const result = await response.json().catch(() => ({})) as { result?: TeamResultView | null; message?: string };
      if (!response.ok) {
        setMessage({ kind: "error", text: result.message ?? "That result couldn't be saved." });
        return;
      }
      onSaved(result.result ?? null);
      setDraft(draftOf(result.result ?? null));
      setMessage({ kind: "ok", text: result.result ? "Saved." : "Cleared." });
    } catch {
      setMessage({ kind: "error", text: "We couldn't reach the server. Nothing was changed." });
    } finally {
      setBusy(false);
    }
  }

  if (!canEdit) {
    return (
      <div className="team-result-level">
        <strong>{teamLevelLabels[level]}</strong>
        {stored ? <span>{stored.placement || "No placement"} · {stored.qualified ? "Qualified" : "Not qualified"}{stored.notes ? ` · ${stored.notes}` : ""}</span> : <span className="quiet-copy">No result yet</span>}
      </div>
    );
  }
  return (
    <form className="team-result-level" onSubmit={save} aria-label={`${teamLevelLabels[level]} result for ${label}`}>
      <strong id={`${base}-title`}>{teamLevelLabels[level]}</strong>
      <label htmlFor={`${base}-placement`}>Placement or score
        <input id={`${base}-placement`} maxLength={200} onChange={(event) => setDraft({ ...draft, placement: event.target.value })} value={draft.placement} />
      </label>
      <label className="checkbox-label" htmlFor={`${base}-qualified`}>
        <input checked={draft.qualified} id={`${base}-qualified`} onChange={(event) => setDraft({ ...draft, qualified: event.target.checked })} type="checkbox" />
        <span>Qualified for the next level</span>
      </label>
      <label htmlFor={`${base}-notes`}>Notes (shown to the club)
        <input id={`${base}-notes`} maxLength={2000} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} value={draft.notes} />
      </label>
      <div className="intro-actions">
        <button className="secondary-button" disabled={busy || !dirty} type="submit">{busy ? "Saving…" : "Save"}</button>
        {message && <span className={message.kind === "error" ? "inline-notice error" : "field-help"} role={message.kind === "error" ? "alert" : "status"}>{message.kind === "ok" && <CheckCircle2 aria-hidden="true" size={13} />} {message.text}</span>}
      </div>
    </form>
  );
}

export function TeamResultsWorkspace({ eventId, initialRows, canEdit }: { eventId: string; initialRows: TeamResultsRow[]; canEdit: boolean }) {
  const [rows, setRows] = useState(initialRows);
  const update = (id: string, level: TeamLevel, result: TeamResultView | null) => setRows((current) => current.map((row) => (
    row.clubEventRegistrationId === id ? { ...row, results: { ...row.results, [level]: result } } : row
  )));
  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Club registration</p>
          <h2><Trophy aria-hidden="true" size={18} /> Team results</h2>
          <p>How each registered team did at the Area, Conference and Union levels. The team&apos;s director sees these on their registration, read only.</p>
        </div>
        <div className="intro-actions">
          <a className="secondary-button" href={`/api/events/${encodeURIComponent(eventId)}/team-results?format=csv`}><Download aria-hidden="true" size={14} /> Download CSV</a>
        </div>
      </div>
      {rows.length === 0 && <section className="panel"><p className="quiet-copy">No team is registered yet.</p></section>}
      {rows.map((row) => (
        <section className="panel team-result-card" key={row.clubEventRegistrationId} aria-labelledby={`team-${row.clubEventRegistrationId}`}>
          <h3 id={`team-${row.clubEventRegistrationId}`} translate="no">{row.teamName || row.clubName}</h3>
          <p className="field-help" translate="no">{row.teamName ? `${row.clubName} · ` : ""}{row.church ?? "No church on file"} · {row.confirmationCode}{row.locationName ? ` · ${row.locationName}` : ""}</p>
          <p><a className="text-button" href={`/more/reports/clubs/team-form/${encodeURIComponent(row.clubEventRegistrationId)}?event=${encodeURIComponent(eventId)}`}>Print this team&apos;s form</a></p>
          <div className="team-result-levels">
            {TEAM_LEVELS.map((level) => (
              <LevelEditor canEdit={canEdit} eventId={eventId} key={level} level={level} onSaved={(result) => update(row.clubEventRegistrationId, level, result)} row={row} />
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}
