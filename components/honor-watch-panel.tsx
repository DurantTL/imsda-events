"use client";

import { useId, useState } from "react";
import { Plus, Save, Trash2, X } from "lucide-react";
import { parseAlertRecipients } from "@/modules/club-forms/alert-recipients";
import { HONOR_WATCHES_MAX_PER_EVENT, HONOR_WATCH_MAX_RECIPIENTS } from "@/modules/honors/watch-domain";

/**
 * The "Honor watches" panel on the honor classes page (#1099). Event administrators and system administrators only: the page does
 * not render it for anyone else and the route checks again. Saved on its own and takes effect at once. A watch lists up to ten
 * typed addresses and the honors (or specific classes) to watch; they get one summary a day, only on a day something changed.
 */

type CatalogHonor = { id: string; code: string; name: string };
type WatchClass = { id: string; label: string; session: string; isActive: boolean };
type Watch = { id: string; name: string; recipients: string[]; honorIds: string[]; offeringIds: string[]; warnings: string[] };
type Panel = { watches: Watch[]; classes: WatchClass[] };

type Draft = {
  localKey: string;
  id?: string;
  name: string;
  recipientsText: string;
  /** The addresses saved for this watch: an old one left alone is not held against a re-save (#1193). */
  savedRecipients: string[];
  honorIds: string[];
  offeringIds: string[];
  warnings: string[];
  honorSearch: string;
};

let localCounter = 0;
function nextKey() {
  localCounter += 1;
  return `w${localCounter}`;
}

function toDraft(row: Watch): Draft {
  return { localKey: row.id, id: row.id, name: row.name, recipientsText: row.recipients.join("\n"), savedRecipients: row.recipients, honorIds: row.honorIds, offeringIds: row.offeringIds, warnings: row.warnings, honorSearch: "" };
}

function blankDraft(): Draft {
  return { localKey: nextKey(), name: "", recipientsText: "", savedRecipients: [], honorIds: [], offeringIds: [], warnings: [], honorSearch: "" };
}

const SEARCH_RESULTS = 8;

export function HonorWatchPanel({ eventId, catalog, initial }: { eventId: string; catalog: CatalogHonor[]; initial: Panel }) {
  const headingId = useId();
  const [classes, setClasses] = useState(initial.classes);
  const [drafts, setDrafts] = useState<Draft[]>(initial.watches.map(toDraft));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const honorById = new Map(catalog.map((honor) => [honor.id, honor]));

  function update(localKey: string, patch: Partial<Draft>) {
    setNotice("");
    setDrafts((current) => current.map((draft) => (draft.localKey === localKey ? { ...draft, ...patch } : draft)));
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    const watches = [];
    for (const [index, draft] of drafts.entries()) {
      const label = draft.name.trim() || `Watch ${index + 1}`;
      if (draft.name.trim().length < 2) return setError(`Watch ${index + 1}: give it a name.`);
      const checked = parseAlertRecipients(draft.recipientsText, draft.savedRecipients);
      if (!checked.ok) return setError(`${label}: ${checked.message}`);
      if (checked.emails.length === 0) return setError(`${label}: add at least one email address.`);
      if (draft.honorIds.length + draft.offeringIds.length === 0) return setError(`${label}: choose at least one honor or class to watch.`);
      watches.push({ ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), recipients: checked.emails, honorIds: draft.honorIds, offeringIds: draft.offeringIds });
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/honors/watches`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ watches }) });
      const result = await response.json().catch(() => null) as (Panel & { message?: string }) | null;
      if (!response.ok || !result) {
        setError(result?.message ?? "The honor watches could not be saved. Try again.");
        return;
      }
      setClasses(result.classes);
      setDrafts(result.watches.map(toDraft));
      setNotice(watches.length === 0 ? "Saved. No honor is being watched." : `Saved. ${watches.length} honor watch${watches.length === 1 ? "" : "es"} will be sent each morning something changes.`);
    } catch {
      setError("The honor watches could not be saved. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="panel form-stack honor-watch-panel">
      <div>
        <p className="eyebrow">Who is told</p>
        <h2 id={headingId}>Honor watches</h2>
      </div>
      <p className="field-help">
        Each watch emails the addresses you type, once a morning (about 6:00 AM Central) and only on a day something changed, with the youth who joined or left
        a class that teaches a watched honor, or a class you choose: name, club and age, never a birth date. A youth who joined and left the same day is not
        listed. A class that teaches several honors counts for each of them. Email that is paused for this event is recorded as not sent. Saved on its own.
      </p>
      <form className="form-stack" noValidate onSubmit={save}>
        {drafts.length === 0 && <p className="quiet-copy">No honor watches yet.</p>}
        {drafts.map((draft, index) => {
          const prefix = `${headingId}-${draft.localKey}`;
          const term = draft.honorSearch.trim().toLowerCase();
          const matches = term.length < 2 ? [] : catalog
            .filter((honor) => !draft.honorIds.includes(honor.id) && (honor.name.toLowerCase().includes(term) || honor.code.toLowerCase().includes(term)))
            .slice(0, SEARCH_RESULTS);
          return (
            <fieldset className="panel form-stack" key={draft.localKey}>
              <legend>Watch {index + 1}</legend>
              {draft.warnings.map((warning) => <div className="inline-notice" key={warning} role="status">{warning}</div>)}
              <label>
                <span>Name</span>
                <input autoComplete="off" maxLength={80} onChange={(event) => update(draft.localKey, { name: event.target.value })} placeholder="Nature honors" value={draft.name} />
              </label>
              <label>
                <span>Email these addresses</span>
                <textarea
                  aria-describedby={`${prefix}-addresses`}
                  autoComplete="off"
                  maxLength={2000}
                  onChange={(event) => update(draft.localKey, { recipientsText: event.target.value })}
                  rows={3}
                  spellCheck={false}
                  value={draft.recipientsText}
                />
              </label>
              <p className="field-help" id={`${prefix}-addresses`}>One address per line, up to {HONOR_WATCH_MAX_RECIPIENTS}.</p>

              <div role="group" aria-label={`Honors watched by watch ${index + 1}`}>
                <label>
                  <span>Watch these honors</span>
                  <input
                    autoComplete="off"
                    onChange={(event) => update(draft.localKey, { honorSearch: event.target.value })}
                    placeholder="Search the catalog by name or code"
                    type="search"
                    value={draft.honorSearch}
                  />
                </label>
                {matches.length > 0 && (
                  <ul className="quiet-copy" style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
                    {matches.map((honor) => (
                      <li key={honor.id}>
                        <button className="text-button" onClick={() => update(draft.localKey, { honorIds: [...draft.honorIds, honor.id], honorSearch: "" })} style={{ minHeight: 44 }} type="button">
                          <Plus aria-hidden="true" size={14} /> {honor.name} ({honor.code})
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {draft.honorIds.length > 0 && (
                  <ul style={{ listStyle: "none", padding: 0, margin: "8px 0", display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {draft.honorIds.map((id) => {
                      const honor = honorById.get(id);
                      return (
                        <li key={id}>
                          <button className="secondary-button" onClick={() => update(draft.localKey, { honorIds: draft.honorIds.filter((candidate) => candidate !== id) })} style={{ minHeight: 44 }} type="button">
                            {honor ? honor.name : "Honor no longer in the catalog"} <X aria-hidden="true" size={14} /><span className="sr-only"> Remove from this watch</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {classes.length > 0 && (
                <div role="group" aria-label={`Classes watched by watch ${index + 1}`}>
                  <p><strong>Or watch these classes</strong></p>
                  <div style={{ maxHeight: 220, overflowY: "auto" }}>
                    {classes.map((entry) => (
                      <label className="checkbox-label" key={entry.id} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44 }}>
                        <input
                          checked={draft.offeringIds.includes(entry.id)}
                          onChange={(event) => update(draft.localKey, {
                            offeringIds: event.target.checked ? [...draft.offeringIds, entry.id] : draft.offeringIds.filter((id) => id !== entry.id),
                          })}
                          style={{ width: "auto" }}
                          type="checkbox"
                        />
                        <span>{entry.label} ({entry.session}){entry.isActive ? "" : " (not offered)"}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <button className="secondary-button" onClick={() => { setNotice(""); setDrafts((current) => current.filter((candidate) => candidate.localKey !== draft.localKey)); }} type="button">
                  <Trash2 aria-hidden="true" size={14} /> Remove watch {index + 1}
                </button>
              </div>
            </fieldset>
          );
        })}
        <div aria-live="polite" role="status">{notice && <p className="quiet-copy">{notice}</p>}</div>
        {error && <div className="inline-notice error" role="alert">{error}</div>}
        <div className="form-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
          <button className="secondary-button" disabled={drafts.length >= HONOR_WATCHES_MAX_PER_EVENT} onClick={() => { setNotice(""); setDrafts((current) => [...current, blankDraft()]); }} type="button">
            <Plus aria-hidden="true" size={14} /> Add a watch
          </button>
          <button className="primary-button" disabled={saving} type="submit">
            <Save aria-hidden="true" size={14} /> {saving ? "Saving…" : "Save honor watches"}
          </button>
        </div>
        <p className="field-help">Up to {HONOR_WATCHES_MAX_PER_EVENT} watches per event. Event administrators and system administrators can change them. A watch you change still gets what happened since its last summary, for what it looks at now.</p>
      </form>
    </section>
  );
}
