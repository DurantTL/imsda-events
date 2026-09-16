"use client";

import { useEffect, useState } from "react";
import { NotebookPen, Tags } from "lucide-react";

type TagOption = { id: string; name: string; color: string; description: string; isActive: boolean };
type TagAssignment = {
  id: string;
  tag: TagOption;
  appliedBy: { id: string; displayName: string };
  appliedAt: string;
  removedBy: { id: string; displayName: string } | null;
  removedAt: string | null;
};
type NoteRecord = {
  id: string;
  visibility: "STAFF" | "RESTRICTED";
  restrictedPermission: string | null;
  author: { id: string; displayName: string };
  createdAt: string;
  updatedAt: string;
  body: string;
  revisionCount: number;
};

const restrictablePermissions = [
  "VIEW_SENSITIVE_DATA",
  "MANAGE_FINANCE",
  "MANAGE_STAFF",
  "MANAGE_CHECK_IN",
] as const;

/**
 * Notes and tags for one registration or one attendee within it. Self-fetching
 * so it can be dropped into a detail view without the parent workspace
 * needing to thread notes/tags state through its own fetch cycle.
 */
export function RegistrationNotesTagsPanel({
  eventId,
  subjectPath,
  canManage,
}: {
  eventId: string;
  /** e.g. `registrations/${registrationId}` or `registrations/${registrationId}/attendees/${attendeeId}` */
  subjectPath: string;
  canManage: boolean;
}) {
  const [tags, setTags] = useState<TagOption[]>([]);
  const [assignments, setAssignments] = useState<TagAssignment[]>([]);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [noteVisibility, setNoteVisibility] = useState<"STAFF" | "RESTRICTED">("STAFF");
  const [restrictedPermission, setRestrictedPermission] = useState<string>(restrictablePermissions[0]);
  const [saving, setSaving] = useState(false);
  const [selectedTagId, setSelectedTagId] = useState("");

  const basePath = `/api/events/${eventId}/${subjectPath}`;

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [tagsResponse, assignmentsResponse, notesResponse] = await Promise.all([
        fetch(`/api/events/${eventId}/tags`),
        fetch(`${basePath}/tags`),
        fetch(`${basePath}/notes`),
      ]);
      const tagsResult = await tagsResponse.json();
      const assignmentsResult = await assignmentsResponse.json();
      const notesResult = await notesResponse.json();
      if (!tagsResponse.ok || !assignmentsResponse.ok || !notesResponse.ok) {
        throw new Error(tagsResult.message ?? assignmentsResult.message ?? notesResult.message ?? "Unable to load notes and tags.");
      }
      setTags((tagsResult.tags ?? []).filter((tag: TagOption) => tag.isActive));
      setAssignments(assignmentsResult.assignments ?? []);
      setNotes(notesResult.notes ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load notes and tags.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePath]);

  async function applyTag() {
    if (!selectedTagId) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`${basePath}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tagId: selectedTagId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to apply that tag.");
      setSelectedTagId("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to apply that tag.");
    } finally {
      setSaving(false);
    }
  }

  async function removeTag(tagId: string) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`${basePath}/tags/${tagId}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to remove that tag.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to remove that tag.");
    } finally {
      setSaving(false);
    }
  }

  async function submitNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = String(form.get("body") ?? "").trim();
    if (!body) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`${basePath}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body,
          visibility: noteVisibility,
          restrictedPermission: noteVisibility === "RESTRICTED" ? restrictedPermission : null,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? result.issues?.[0]?.message ?? "Unable to save that note.");
      setAddingNote(false);
      setNoteVisibility("STAFF");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save that note.");
    } finally {
      setSaving(false);
    }
  }

  const activeAssignments = assignments.filter((assignment) => !assignment.removedAt);
  const appliedTagIds = new Set(activeAssignments.map((assignment) => assignment.tag.id));
  const applicableTags = tags.filter((tag) => !appliedTagIds.has(tag.id));

  return (
    <section className="registration-related-panel" aria-labelledby="registration-notes-tags">
      <header>
        <span><Tags aria-hidden="true" size={17} /></span>
        <div><p className="eyebrow">Staff-only</p><h3 id="registration-notes-tags">Notes &amp; tags</h3></div>
        <strong>{notes.length}</strong>
      </header>
      {error && <p className="form-error" role="alert">{error}</p>}
      {loading ? <p className="quiet-copy">Loading…</p> : (
        <div className="registration-related-list">
          <div className="tag-chip-row">
            {activeAssignments.length === 0 && <p className="quiet-copy">No tags applied.</p>}
            {activeAssignments.map((assignment) => (
              <span key={assignment.id} className="status-chip tag-chip" style={{ backgroundColor: assignment.tag.color }}>
                {assignment.tag.name}
                {canManage && (
                  <button type="button" className="text-button" disabled={saving} onClick={() => void removeTag(assignment.tag.id)}>
                    Remove
                  </button>
                )}
              </span>
            ))}
          </div>
          {canManage && applicableTags.length > 0 && (
            <div className="inline-heading">
              <select value={selectedTagId} onChange={(event) => setSelectedTagId(event.target.value)}>
                <option value="">Apply a tag…</option>
                {applicableTags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
              </select>
              <button type="button" className="text-button" disabled={!selectedTagId || saving} onClick={() => void applyTag()}>Apply</button>
            </div>
          )}

          <p className="quiet-copy">
            Notes are for scheduling and follow-up facts only — never medical, allergy, accommodation, or
            incident detail. Those belong to dedicated protected records.
          </p>
          {notes.length === 0 && <p className="quiet-copy">No notes yet.</p>}
          {notes.map((note) => (
            <article key={note.id}>
              <div>
                <strong>{note.author.displayName}{note.visibility === "RESTRICTED" ? ` · Restricted (${note.restrictedPermission})` : ""}</strong>
                <small>{new Date(note.updatedAt).toLocaleString()}{note.revisionCount > 1 ? ` · ${note.revisionCount} revisions` : ""}</small>
              </div>
              <p>{note.body}</p>
            </article>
          ))}
          {canManage && !addingNote && (
            <button type="button" className="text-button" onClick={() => { setError(""); setAddingNote(true); }}>
              <NotebookPen aria-hidden="true" size={14} /> Add note
            </button>
          )}
          {canManage && addingNote && (
            <form className="form-stack inset-form" onSubmit={submitNote}>
              <label>Note<textarea name="body" rows={3} maxLength={4000} required /></label>
              <label>
                Visibility
                <select value={noteVisibility} onChange={(event) => setNoteVisibility(event.target.value as "STAFF" | "RESTRICTED")}>
                  <option value="STAFF">Staff-wide</option>
                  <option value="RESTRICTED">Restricted to a permission</option>
                </select>
              </label>
              {noteVisibility === "RESTRICTED" && (
                <label>
                  Required permission
                  <select value={restrictedPermission} onChange={(event) => setRestrictedPermission(event.target.value)}>
                    {restrictablePermissions.map((permission) => <option key={permission} value={permission}>{permission}</option>)}
                  </select>
                </label>
              )}
              <div className="form-actions">
                <button className="secondary-button" type="button" onClick={() => { setAddingNote(false); setError(""); }}>Cancel</button>
                <button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save note"}</button>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
