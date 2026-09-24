"use client";

import { useState } from "react";
import { CalendarDays, Pencil, Plus, Trash2, X } from "lucide-react";
import type { ClubMeetingNoteRecord } from "@/modules/club-meeting-notes/repository";
import type { ReportHonor } from "@/modules/club-reports/domain";

type NoteResponse = { note?: ClubMeetingNoteRecord; message?: string; issues?: Array<{ message?: string }> };

type Draft = {
  meetingDate: string;
  pathfinderCount: string;
  tltCount: string;
  staffCount: string;
  honors: ReportHonor[];
  notes: string;
};

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const emptyDraft = (): Draft => ({ meetingDate: today(), pathfinderCount: "", tltCount: "", staffCount: "", honors: [], notes: "" });

function toCount(value: string) {
  if (value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function formatMeetingDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function draftFromNote(note: ClubMeetingNoteRecord): Draft {
  return {
    meetingDate: note.meetingDate,
    pathfinderCount: note.pathfinderCount ?? "",
    tltCount: note.tltCount ?? "",
    staffCount: note.staffCount ?? "",
    honors: note.honors,
    notes: note.notes,
  } as Draft;
}

/**
 * A club's meeting notes (#426): meeting date, attendance counts, honors
 * worked on, and free text. Counts only — no names of young people.
 */
export function ClubMeetingNotes({ initialNotes, organizationId }: { initialNotes: ClubMeetingNoteRecord[]; organizationId: string }) {
  const [notes, setNotes] = useState(initialNotes);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/notes`;

  function startAdd() {
    setDraft(emptyDraft());
    setAdding(true);
    setEditingId(null);
    setError("");
    setNotice("");
  }

  function startEdit(note: ClubMeetingNoteRecord) {
    setDraft(draftFromNote(note));
    setEditingId(note.id);
    setAdding(false);
    setError("");
    setNotice("");
  }

  function cancel() {
    setAdding(false);
    setEditingId(null);
    setError("");
  }

  function addHonor() {
    setDraft((current) => ({ ...current, honors: [...current.honors, { name: "", participants: null }] }));
  }

  function removeHonor(index: number) {
    setDraft((current) => ({ ...current, honors: current.honors.filter((_, i) => i !== index) }));
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    const body = {
      meetingDate: draft.meetingDate,
      pathfinderCount: toCount(String(draft.pathfinderCount)),
      tltCount: toCount(String(draft.tltCount)),
      staffCount: toCount(String(draft.staffCount)),
      honors: draft.honors.filter((honor) => honor.name.trim() || honor.participants !== null),
      notes: draft.notes,
    };
    try {
      const response = await fetch(editingId ? `${base}/${encodeURIComponent(editingId)}` : base, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as NoteResponse;
      if (!response.ok || !result.note) throw new Error(result.message ?? result.issues?.[0]?.message ?? "The meeting note could not be saved.");
      setNotes((current) => {
        const withoutThis = current.filter((note) => note.id !== result.note!.id);
        return [...withoutThis, result.note!].sort((a, b) => (a.meetingDate < b.meetingDate ? 1 : -1));
      });
      setNotice(editingId ? "Meeting note updated." : "Meeting note added.");
      setAdding(false);
      setEditingId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The meeting note could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(note: ClubMeetingNoteRecord) {
    if (!window.confirm(`Delete the meeting note for ${formatMeetingDate(note.meetingDate)}? This can't be undone.`)) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`${base}/${encodeURIComponent(note.id)}`, { method: "DELETE" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as NoteResponse;
        throw new Error(result.message ?? "The meeting note could not be deleted.");
      }
      setNotes((current) => current.filter((item) => item.id !== note.id));
      setNotice("Meeting note deleted.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The meeting note could not be deleted.");
    } finally {
      setSaving(false);
    }
  }

  const formOpen = adding || editingId !== null;

  return (
    <div className="club-roster-stack">
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      <section className="public-manage-card" aria-labelledby="club-notes-heading">
        <div className="public-manage-card-heading club-roster-heading">
          <div>
            <p className="public-registration-eyebrow">Counts only, no names</p>
            <h2 id="club-notes-heading">Meeting notes</h2>
          </div>
          {!formOpen && (
            <button className="primary-button" disabled={saving} onClick={startAdd} type="button">
              <Plus aria-hidden="true" size={16} /> Add meeting note
            </button>
          )}
        </div>

        {notes.length === 0 && !formOpen && <p className="public-manage-empty">No meeting notes yet.</p>}

        <ul className="public-manage-club-list">
          {notes.map((note) => (
            <li key={note.id}>
              <CalendarDays aria-hidden="true" size={17} />
              <span>
                <strong>{formatMeetingDate(note.meetingDate)}</strong>
                <small>
                  Pathfinders {note.pathfinderCount ?? "—"} · TLTs {note.tltCount ?? "—"} · Staff {note.staffCount ?? "—"}
                  {note.honors.length > 0 ? ` · ${note.honors.map((honor) => honor.name).filter(Boolean).join(", ")}` : ""}
                </small>
              </span>
              <span className="club-team-invite-actions">
                <button aria-label={`Edit the meeting note for ${formatMeetingDate(note.meetingDate)}`} className="secondary-button club-event-action" disabled={saving} onClick={() => startEdit(note)} type="button">
                  <Pencil aria-hidden="true" size={14} /> Edit
                </button>
                <button aria-label={`Delete the meeting note for ${formatMeetingDate(note.meetingDate)}`} className="secondary-button club-event-action" disabled={saving} onClick={() => remove(note)} type="button">
                  <Trash2 aria-hidden="true" size={14} /> Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {formOpen && (
        <form className="public-manage-card form-stack" onSubmit={save}>
          <div className="public-manage-card-heading">
            <p className="public-registration-eyebrow">{editingId ? "Edit meeting note" : "New meeting note"}</p>
            <h2>{editingId ? "Edit" : "Add"} meeting note</h2>
          </div>
          <div className="form-grid two-column">
            <label>Meeting date
              <input onChange={(event) => setDraft((current) => ({ ...current, meetingDate: event.target.value }))} required type="date" value={draft.meetingDate} />
            </label>
          </div>
          <div className="form-grid two-column">
            <label>Pathfinders
              <input inputMode="numeric" max={999} min={0} onChange={(event) => setDraft((current) => ({ ...current, pathfinderCount: event.target.value }))} type="number" value={draft.pathfinderCount} />
            </label>
            <label>TLTs
              <input inputMode="numeric" max={999} min={0} onChange={(event) => setDraft((current) => ({ ...current, tltCount: event.target.value }))} type="number" value={draft.tltCount} />
            </label>
            <label>Staff
              <input inputMode="numeric" max={999} min={0} onChange={(event) => setDraft((current) => ({ ...current, staffCount: event.target.value }))} type="number" value={draft.staffCount} />
            </label>
          </div>

          <div className="club-report-sub">
            <strong>Honors worked on</strong>
            {draft.honors.map((honor, index) => (
              <div className="form-grid two-column club-report-honor" key={index}>
                <label>
                  Honor
                  <input
                    maxLength={80}
                    onChange={(event) => setDraft((current) => ({ ...current, honors: current.honors.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)) }))}
                    value={honor.name}
                  />
                </label>
                <label>
                  Number participating
                  <span className="club-report-honor-row">
                    <input
                      inputMode="numeric"
                      max={999}
                      min={0}
                      onChange={(event) => setDraft((current) => ({ ...current, honors: current.honors.map((item, i) => (i === index ? { ...item, participants: toCount(event.target.value) } : item)) }))}
                      type="number"
                      value={honor.participants ?? ""}
                    />
                    <button aria-label="Remove this honor" className="text-button" onClick={() => removeHonor(index)} type="button"><X aria-hidden="true" size={14} /></button>
                  </span>
                </label>
              </div>
            ))}
            <button className="secondary-button club-event-action" onClick={addHonor} type="button"><Plus aria-hidden="true" size={14} /> Add an honor</button>
          </div>

          <label>Notes
            <textarea maxLength={4000} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} rows={4} value={draft.notes} />
          </label>

          <div className="intro-actions">
            <button className="primary-button" disabled={saving} type="submit">{editingId ? "Save changes" : "Add meeting note"}</button>
            <button className="secondary-button" disabled={saving} onClick={cancel} type="button">Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
