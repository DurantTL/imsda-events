"use client";

import { useState } from "react";
import { CheckCircle2, UsersRound } from "lucide-react";
import type { TeamSettings } from "@/modules/club-teams/domain";

type Draft = {
  allowMultipleTeams: boolean;
  minTeamMembers: string;
  maxTeamMembers: string;
  maxAlternates: string;
  ageAsOf: string;
  maxMemberAge: string;
  booksLine: string;
  conferenceDate: string;
  conferencePlace: string;
  unionDate: string;
  unionPlace: string;
};

function draftFrom(settings: TeamSettings | null): Draft {
  const level = (name: "CONFERENCE" | "UNION") => settings?.levelInfo.find((entry) => entry.level === name);
  return {
    allowMultipleTeams: settings?.allowMultipleTeams ?? false,
    minTeamMembers: settings?.minTeamMembers?.toString() ?? "",
    maxTeamMembers: settings?.maxTeamMembers?.toString() ?? "",
    maxAlternates: String(settings?.maxAlternates ?? 0),
    ageAsOf: settings?.ageAsOf ?? "",
    maxMemberAge: settings?.maxMemberAge?.toString() ?? "",
    booksLine: settings?.booksLine ?? "",
    conferenceDate: level("CONFERENCE")?.date ?? "",
    conferencePlace: level("CONFERENCE")?.place ?? "",
    unionDate: level("UNION")?.date ?? "",
    unionPlace: level("UNION")?.place ?? "",
  };
}

const count = (value: string) => (value.trim() ? Number(value) : null);

function bodyFrom(draft: Draft) {
  const levels = [
    { level: "CONFERENCE", date: draft.conferenceDate || null, place: draft.conferencePlace },
    { level: "UNION", date: draft.unionDate || null, place: draft.unionPlace },
  ].filter((entry) => entry.date || entry.place.trim());
  return {
    allowMultipleTeams: draft.allowMultipleTeams,
    minTeamMembers: count(draft.minTeamMembers),
    maxTeamMembers: count(draft.maxTeamMembers),
    maxAlternates: Number(draft.maxAlternates || 0),
    ageAsOf: draft.ageAsOf || null,
    maxMemberAge: count(draft.maxMemberAge),
    booksLine: draft.booksLine,
    levelInfo: levels,
  };
}

/**
 * Team rules for a club event (#809): several named teams per club, how many members a team has, the alternate,
 * and the date ages are counted on. Staff with event settings access only. An event without these keeps one
 * registration per club and no limits.
 */
export function EventTeamSettingsPanel({ eventId, initialSettings }: { eventId: string; initialSettings: TeamSettings | null }) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initialSettings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/team-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyFrom(draft)),
      });
      const result = await response.json().catch(() => ({})) as { teamSettings?: TeamSettings; message?: string };
      if (!response.ok) {
        setError(result.message ?? "The team rules couldn't be saved.");
        return;
      }
      setDraft(draftFrom(result.teamSettings ?? null));
      setNotice("Team rules saved.");
    } catch {
      setError("We couldn't reach the server. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="team-settings-heading" id="team-settings">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Club registration</p>
          <h2 id="team-settings-heading"><UsersRound aria-hidden="true" size={18} /> Teams</h2>
          <p>
            For events where a club enters named teams, like the Pathfinder Bible Experience. Leave everything off for an event
            with one registration per club and no limits on who goes.
          </p>
        </div>
      </div>
      <form className="form-stack" onSubmit={save}>
        {error && <div className="inline-notice error" role="alert">{error}</div>}
        {notice && <div className="inline-notice" role="status"><CheckCircle2 aria-hidden="true" size={14} /> {notice}</div>}
        <label className="checkbox-label">
          <input checked={draft.allowMultipleTeams} onChange={(event) => set("allowMultipleTeams", event.target.checked)} type="checkbox" />
          <span>
            <strong>A club can register more than one team</strong>
            <small>Each team has its own name, unique across the event, and is registered, billed and checked in on its own.</small>
          </span>
        </label>
        <div className="form-grid two-column">
          <label>Fewest team members<input inputMode="numeric" max={100} min={1} onChange={(event) => set("minTeamMembers", event.target.value)} type="number" value={draft.minTeamMembers} /></label>
          <label>Most team members<input inputMode="numeric" max={100} min={1} onChange={(event) => set("maxTeamMembers", event.target.value)} type="number" value={draft.maxTeamMembers} /></label>
          <label>
            Most alternates
            <input inputMode="numeric" max={10} min={0} onChange={(event) => set("maxAlternates", event.target.value)} type="number" value={draft.maxAlternates} />
            <small className="field-help">The alternate counts within the most team members. Coaches never count.</small>
          </label>
          <label>
            Count ages on
            <input onChange={(event) => set("ageAsOf", event.target.value)} type="date" value={draft.ageAsOf} />
            <small className="field-help">Blank counts ages on the event&apos;s first day.</small>
          </label>
          <label>
            Oldest team member
            <input inputMode="numeric" max={120} min={0} onChange={(event) => set("maxMemberAge", event.target.value)} type="number" value={draft.maxMemberAge} />
            <small className="field-help">Counted on the date above. Coaches are not held to it.</small>
          </label>
          <label className="wide-field">Books or subject line on the printed form<input maxLength={300} onChange={(event) => set("booksLine", event.target.value)} value={draft.booksLine} /></label>
        </div>
        <fieldset className="form-grid two-column">
          <legend>Levels after the first</legend>
          <label>Conference date<input onChange={(event) => set("conferenceDate", event.target.value)} type="date" value={draft.conferenceDate} /></label>
          <label>Conference place<input maxLength={120} onChange={(event) => set("conferencePlace", event.target.value)} value={draft.conferencePlace} /></label>
          <label>Union date<input onChange={(event) => set("unionDate", event.target.value)} type="date" value={draft.unionDate} /></label>
          <label>Union place<input maxLength={120} onChange={(event) => set("unionPlace", event.target.value)} value={draft.unionPlace} /></label>
        </fieldset>
        <div className="intro-actions">
          <button className="primary-button" disabled={busy} type="submit">{busy ? "Saving…" : "Save team rules"}</button>
        </div>
      </form>
    </section>
  );
}
