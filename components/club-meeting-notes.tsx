"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Download, Pencil, Plus, Trash2, X } from "lucide-react";
import { notePreview } from "@/components/club-form-state";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import { attendanceForSave } from "@/modules/club-meeting-notes/attendance-save";
import { countsFromAttendance, countsToSend, groupAttendanceRoster } from "@/modules/club-meeting-notes/attendance";
import type { AttendanceRosterEntry, ClubMeetingNoteRecord } from "@/modules/club-meeting-notes/repository";
import { clubYearFor } from "@/modules/club-rosters/domain";
import type { ReportHonor } from "@/modules/club-reports/domain";

type NoteResponse = { note?: ClubMeetingNoteRecord; message?: string; issues?: Array<{ message?: string }> };

type Draft = {
  meetingDate: string;
  pathfinderCount: string;
  tltCount: string;
  staffCount: string;
  honors: ReportHonor[];
  notes: string;
  /** Whether the optional check-off is in use for this meeting (#653). */
  attendanceOn: boolean;
  /** Set once the check-off is changed, so an untouched edit never rewrites its history. */
  attendanceTouched: boolean;
  /** Roster member id → present. Unlisted means absent. */
  present: Record<string, boolean>;
};

const emptyDraft = (meetingDate: string): Draft => ({
  meetingDate, pathfinderCount: "", tltCount: "", staffCount: "", honors: [], notes: "", attendanceOn: false, attendanceTouched: false, present: {},
});

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
    attendanceOn: note.attendance.length > 0,
    attendanceTouched: false,
    present: Object.fromEntries(note.attendance.map((entry) => [entry.rosterMemberId, entry.present])),
  } as Draft;
}

/**
 * A club's meeting notes for one month (#426, #653): meeting date, head counts,
 * honors worked on, free text, and an optional attendance check-off against the
 * club's active roster. The check-off fills the head counts, which stay editable.
 */
export function ClubMeetingNotes({
  initialNotes,
  organizationId,
  month,
  monthLabel,
  newMeetingDate,
  roster,
  rosterClubYear,
  attendanceAvailable,
  exportHref,
}: {
  initialNotes: ClubMeetingNoteRecord[];
  organizationId: string;
  month: string;
  monthLabel: string;
  newMeetingDate: string;
  roster: AttendanceRosterEntry[];
  rosterClubYear: string;
  /** False without an open roster (a reporter, or an expired unlock): head counts only. */
  attendanceAvailable: boolean;
  /** Null when this month's club year can't be exported. */
  exportHref: string | null;
}) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes);
  // Follow the server's list after a refresh (React's "adjust state while rendering" pattern).
  const [seenNotes, setSeenNotes] = useState(initialNotes);
  if (seenNotes !== initialNotes) {
    setSeenNotes(initialNotes);
    setNotes(initialNotes);
  }
  const [editingId, setEditingId] = useState<string | null>(null);
  // Notes whose full text is showing in the list (#703).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft(newMeetingDate));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/notes`;
  // The editor is a dialog (#789): useAccessibleDialog moves focus into it,
  // closes it on Escape, and puts focus back on the Add / Edit button that opened it.
  const editorOpen = adding || editingId !== null;
  // Escape, Close and Cancel never throw away typed changes silently: a changed draft asks first.
  const [baseline, setBaseline] = useState(() => JSON.stringify(emptyDraft(newMeetingDate)));
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const dirty = JSON.stringify(draft) !== baseline;
  // The green "Saved" banner pinned to the top of the popup (#810): it appears after a save and goes away when the draft changes again.
  const [justSaved, setJustSaved] = useState(false);
  // Whether the note being edited has a check-off on file. Kept from the note itself and from each save response, never looked up in `notes`, which only holds this month's meetings.
  const [hadAttendance, setHadAttendance] = useState(false);
  const dialogRef = useAccessibleDialog<HTMLElement>(editorOpen, requestClose);

  function startAdd() {
    setJustSaved(false);
    setHadAttendance(false);
    setBaseline(JSON.stringify(emptyDraft(newMeetingDate)));
    setConfirmingDiscard(false);
    setDraft(emptyDraft(newMeetingDate));
    setAdding(true);
    setEditingId(null);
    setError("");
    setNotice("");
  }

  function startEdit(note: ClubMeetingNoteRecord) {
    setJustSaved(false);
    setHadAttendance(note.attendance.length > 0);
    setBaseline(JSON.stringify(draftFromNote(note)));
    setConfirmingDiscard(false);
    setDraft(draftFromNote(note));
    setEditingId(note.id);
    setAdding(false);
    setError("");
    setNotice("");
  }

  function cancel() {
    if (saving) return;
    setJustSaved(false);
    setConfirmingDiscard(false);
    setAdding(false);
    setEditingId(null);
    setError("");
  }

  function requestClose() {
    if (saving) return;
    if (dirty) setConfirmingDiscard(true);
    else cancel();
  }

  function addHonor() {
    setDraft((current) => ({ ...current, honors: [...current.honors, { name: "", participants: null }] }));
  }

  function removeHonor(index: number) {
    setDraft((current) => ({ ...current, honors: current.honors.filter((_, i) => i !== index) }));
  }

  // Checking someone off refills the head counts from the check-off; the boxes stay editable.
  function setPresent(next: Record<string, boolean>) {
    setDraft((current) => {
      const counts = countsFromAttendance(roster.map((member) => ({ ...member, present: next[member.id] === true })));
      return {
        ...current,
        attendanceOn: true,
        attendanceTouched: true,
        present: next,
        pathfinderCount: String(counts.pathfinderCount),
        tltCount: String(counts.tltCount),
        staffCount: String(counts.staffCount),
      };
    });
  }

  function markAll(value: boolean) {
    setPresent(Object.fromEntries(roster.map((member) => [member.id, value])));
  }

  // The roster shown is for one club year; a meeting dated in another year can't be checked off here.
  const rosterMatchesDate = attendanceAvailable && roster.length > 0 && isRealDate(draft.meetingDate) && clubYearFor(new Date(`${draft.meetingDate}T12:00:00Z`)) === rosterClubYear;

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    const sendAttendance = attendanceAvailable && draft.attendanceTouched && draft.attendanceOn && rosterMatchesDate;
    const typedCounts = {
      pathfinderCount: toCount(String(draft.pathfinderCount)),
      tltCount: toCount(String(draft.tltCount)),
      staffCount: toCount(String(draft.staffCount)),
    };
    // Counts still equal to the editor's own roster-derived ones go blank; the server fills them from the merged marks.
    const counts = sendAttendance
      ? countsToSend(
        { pathfinderCount: String(draft.pathfinderCount), tltCount: String(draft.tltCount), staffCount: String(draft.staffCount) },
        countsFromAttendance(roster.map((member) => ({ ...member, present: draft.present[member.id] === true }))),
      )
      : typedCounts;
    const body = {
      meetingDate: draft.meetingDate,
      ...counts,
      honors: draft.honors.filter((honor) => honor.name.trim() || honor.participants !== null),
      notes: draft.notes,
      // Omitted leaves a meeting's check-off alone; an empty list clears it (#653).
      // Only a touched check-off is sent; the server merges it into the marks already there.
      ...attendanceForSave({ available: attendanceAvailable, touched: draft.attendanceTouched, on: draft.attendanceOn, rosterMatchesDate, hadAttendance, roster, present: draft.present }),
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
      // The popup stays open on the saved note so the confirmation is seen where the person is looking (#810).
      setEditingId(result.note.id);
      setHadAttendance(result.note.attendance.length > 0);
      setAdding(false);
      setBaseline(JSON.stringify(draft));
      setConfirmingDiscard(false);
      setJustSaved(true);
      // The report below prefills from this month's notes.
      router.refresh();
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
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The meeting note could not be deleted.");
    } finally {
      setSaving(false);
    }
  }

  const formOpen = adding || editingId !== null;

  return (
    <div className="club-roster-stack" data-month={month}>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && !formOpen && <div className="inline-notice error" role="alert">{error}</div>}

      <section className="public-manage-card" aria-labelledby="club-notes-heading">
        <div className="public-manage-card-heading club-roster-heading">
          <div>
            <p className="public-registration-eyebrow">Head counts, with an optional attendance check-off</p>
            <h2 id="club-notes-heading">Meetings in {monthLabel}</h2>
          </div>
          <span className="club-team-invite-actions">
            {exportHref && attendanceAvailable && (
              <a className="secondary-button club-event-action" href={exportHref}>
                <Download aria-hidden="true" size={14} /> Attendance export (CSV)
              </a>
            )}
            <button className="primary-button" data-meeting-note-add="" disabled={saving} onClick={startAdd} type="button">
              <Plus aria-hidden="true" size={16} /> Add meeting note
            </button>
          </span>
        </div>

        {notes.length === 0 && !formOpen && <p className="public-manage-empty">No meetings recorded for {monthLabel} yet.</p>}

        <ul className="public-manage-club-list">
          {notes.map((note) => (
            <li key={note.id}>
              <CalendarDays aria-hidden="true" size={17} />
              <span>
                <strong>{formatMeetingDate(note.meetingDate)}</strong>
                <small>
                  Pathfinders {note.pathfinderCount ?? "—"} · TLTs {note.tltCount ?? "—"} · Staff {note.staffCount ?? "—"}
                  {note.attendance.length > 0 ? ` · Attendance taken (${note.attendance.filter((entry) => entry.present).length} of ${note.attendance.length} present)` : ""}
                  {note.honors.length > 0 ? ` · ${note.honors.map((honor) => honor.name).filter(Boolean).join(", ")}` : ""}
                </small>
                {note.notes.trim() !== "" && (
                  <MeetingNoteText
                    expanded={expanded.has(note.id)}
                    onToggle={() => setExpanded((current) => {
                      const next = new Set(current);
                      if (!next.delete(note.id)) next.add(note.id);
                      return next;
                    })}
                    dateLabel={formatMeetingDate(note.meetingDate)}
                    id={`meeting-note-${note.id}`}
                    text={note.notes}
                  />
                )}
              </span>
              <span className="club-team-invite-actions">
                <button aria-label={`Edit the meeting note for ${formatMeetingDate(note.meetingDate)}`} className="secondary-button club-event-action" data-meeting-note-edit={note.id} disabled={saving} onClick={() => startEdit(note)} type="button">
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
        <div className="modal-backdrop" role="presentation">
        <section aria-labelledby="meeting-note-dialog-title" aria-modal="true" className="modal-card modal-card-wide" ref={dialogRef} role="dialog" tabIndex={-1}>
        <form className="form-stack" onSubmit={save}>
          {justSaved && !dirty && <div className="inline-notice success meeting-note-saved" data-meeting-note-saved="" role="status">Saved</div>}
          <div className="modal-head">
            <div>
              <p className="public-registration-eyebrow">{editingId ? "Edit meeting note" : "New meeting note"}</p>
              <h2 id="meeting-note-dialog-title">{editingId ? "Edit" : "Add"} meeting note</h2>
            </div>
            <button aria-label="Close" className="icon-button modal-close-button" disabled={saving} onClick={requestClose} type="button">
              <X aria-hidden="true" size={18} />
            </button>
          </div>
          {error && <div className="inline-notice error" role="alert">{error}</div>}
          {confirmingDiscard && (
            <div className="inline-notice error" role="alert">
              <p>Discard this meeting note? Your changes will be lost.</p>
              <div className="intro-actions">
                <button autoFocus className="secondary-button" onClick={() => setConfirmingDiscard(false)} type="button">Keep editing</button>
                <button className="primary-button" onClick={cancel} type="button">Discard</button>
              </div>
            </div>
          )}
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

          <AttendanceSection
            draft={draft}
            onMarkAll={markAll}
            onSkip={() => setDraft((current) => ({ ...current, attendanceOn: false, attendanceTouched: true, present: {} }))}
            onStart={() => setDraft((current) => ({ ...current, attendanceOn: true }))}
            onToggle={(id, value) => setPresent({ ...draft.present, [id]: value })}
            roster={roster}
            rosterMatchesDate={rosterMatchesDate}
            attendanceAvailable={attendanceAvailable}
          />

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
            <button className="secondary-button" disabled={saving} onClick={requestClose} type="button">{justSaved && !dirty ? "Close" : "Cancel"}</button>
          </div>
        </form>
        </section>
        </div>
      )}
    </div>
  );
}

/** The note text under a list row: a one-line preview that expands in place (#703). */
function MeetingNoteText({ text, id, dateLabel, expanded, onToggle }: { text: string; id: string; dateLabel: string; expanded: boolean; onToggle: () => void }) {
  const preview = notePreview(text);
  if (preview === null) return <small className="club-meeting-note-text" id={id}>{text.trim()}</small>;
  return (
    <>
      <small className={`club-meeting-note-text${expanded ? "" : " club-meeting-note-collapsed"}`} id={id}>{expanded ? text.trim() : preview}</small>
      <button aria-controls={id} aria-expanded={expanded} aria-label={`${expanded ? "Show less of" : "Show full"} meeting note for ${dateLabel}`} className="text-button club-meeting-note-toggle" onClick={onToggle} type="button">
        {expanded ? "Show less" : "Show full note"}
      </button>
    </>
  );
}

function isRealDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00Z`).getTime());
}

/** The optional check-off list inside the meeting editor (#653), grouped Pathfinders / TLT / Staff. */
function AttendanceSection({
  draft,
  roster,
  rosterMatchesDate,
  attendanceAvailable,
  onStart,
  onSkip,
  onMarkAll,
  onToggle,
}: {
  draft: Draft;
  roster: AttendanceRosterEntry[];
  rosterMatchesDate: boolean;
  attendanceAvailable: boolean;
  onStart: () => void;
  onSkip: () => void;
  onMarkAll: (value: boolean) => void;
  onToggle: (id: string, value: boolean) => void;
}) {
  if (!rosterMatchesDate) {
    return (
      <div className="club-report-sub">
        <strong>Attendance (optional)</strong>
        <p className="field-help">
          {!attendanceAvailable
            ? "The attendance check-off needs roster access. Type the head counts above, or ask your club director."
            : roster.length === 0
            ? "Add members to this year's roster to check off who came. You can still type the head counts above."
            : "Attendance uses the roster for the club year shown, so this date can't be checked off here."}
        </p>
      </div>
    );
  }
  // Same basis as the saved list line: every mark on the meeting, including people no longer on the active roster.
  const rosterIds = new Set(roster.map((member) => member.id));
  const otherMarks = Object.entries(draft.present).filter(([id]) => !rosterIds.has(id));
  const presentCount = roster.filter((member) => draft.present[member.id] === true).length + otherMarks.filter(([, present]) => present).length;
  const totalCount = roster.length + otherMarks.length;
  return (
    <div className="club-report-sub">
      <strong>Attendance (optional)</strong>
      {!draft.attendanceOn ? (
        <>
          <p className="field-help">Check off who came and the head counts fill in for you. Skip it to keep typing counts.</p>
          <button className="secondary-button club-event-action" onClick={onStart} type="button">Take attendance</button>
        </>
      ) : (
        <>
          <p className="field-help" role="status">{presentCount} of {totalCount} present. The counts above update as you check people off, and you can still change them.</p>
          <div className="intro-actions">
            <button className="secondary-button club-event-action" onClick={() => onMarkAll(true)} type="button">Mark all present</button>
            <button className="secondary-button club-event-action" onClick={() => onMarkAll(false)} type="button">Clear all</button>
            <button className="text-button" onClick={onSkip} type="button">Skip attendance</button>
          </div>
          {groupAttendanceRoster(roster).map((entry) => (
            <fieldset className="club-attendance-group" key={entry.group}>
              <legend>{entry.label}</legend>
              {entry.members.map((member) => (
                <label className="checkbox-label" key={member.id}>
                  <input
                    checked={draft.present[member.id] === true}
                    onChange={(event) => onToggle(member.id, event.target.checked)}
                    type="checkbox"
                  />
                  {member.lastName}, {member.firstName}
                </label>
              ))}
            </fieldset>
          ))}
        </>
      )}
    </div>
  );
}
