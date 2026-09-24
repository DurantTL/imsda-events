"use client";

import { useState } from "react";
import { CircleAlert, Mail, Pencil, Send } from "lucide-react";
import type { ClubAssignmentRow } from "@/modules/club-registrations/assignments-repository";
import { clubAssignmentStatusLabels } from "@/modules/club-registrations/assignments";
import type { ClubAssignmentPreview } from "@/modules/communications/club-assignment-audience";

type EditableFields = ClubAssignmentRow["fields"];

const emptyEdit: EditableFields = {
  campsiteLocation: "",
  campsiteNotes: "",
  dutyLabel: "",
  dutyDay: "",
  dutyTime: "",
  activityLabel: "",
  notes: "",
};

function statusClass(status: ClubAssignmentRow["status"]) {
  if (status === "SET") return "status-chip green";
  if (status === "PARTIAL") return "status-chip gold";
  return "status-chip";
}

function preferenceLines(preferences: ClubAssignmentRow["preferences"]) {
  const lines: string[] = [];
  if (preferences.dutyAreas.length) lines.push(`Duty: ${preferences.dutyAreas.join(", ")}`);
  if (preferences.flagSlots.length) lines.push(`Flag slots: ${preferences.flagSlots.join(", ")}`);
  if (preferences.bathroomDays.length) lines.push(`Bathroom days: ${preferences.bathroomDays.join(", ")}`);
  if (preferences.specialActivities.length) lines.push(`Activities: ${preferences.specialActivities.join(", ")}`);
  if (preferences.campNextTo) lines.push(`Camp next to: ${preferences.campNextTo}`);
  const footprint = [preferences.tents, preferences.trailers, preferences.kitchenCanopy, preferences.totalSquareFeet]
    .filter(Boolean).join(" · ");
  if (footprint) lines.push(`Footprint: ${footprint}`);
  return lines;
}

export function ClubAssignmentsWorkspace({
  eventId,
  eventName,
  initialAssignments,
  canSend,
}: {
  eventId: string;
  eventName: string;
  initialAssignments: ClubAssignmentRow[];
  canSend: boolean;
}) {
  const [assignments, setAssignments] = useState(initialAssignments);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditableFields>(emptyEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<ClubAssignmentPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [sendScope, setSendScope] = useState<{ scope: "ONE"; organizationId: string } | { scope: "ALL_SET" }>({ scope: "ALL_SET" });
  const [sendResult, setSendResult] = useState<string>("");

  function beginEdit(row: ClubAssignmentRow) {
    setEditingId(row.organizationId);
    setDraft(row.fields);
    setError("");
  }

  async function save(organizationId: string) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/events/${eventId}/club-assignments/${organizationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "Could not save this assignment.");
      setAssignments((rows) => rows.map((row) => (
        row.organizationId === organizationId
          ? {
            ...row,
            fields: draft,
            status: statusFromFields(draft),
            version: data.assignment.version,
            lastEmailedVersion: data.assignment.lastEmailedVersion,
            lastEmailSentAt: data.assignment.lastEmailSentAt,
            changedSinceSent: data.assignment.lastEmailedVersion !== null
              && data.assignment.version > data.assignment.lastEmailedVersion,
          }
          : row
      )));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this assignment.");
    } finally {
      setSaving(false);
    }
  }

  function statusFromFields(fields: EditableFields): ClubAssignmentRow["status"] {
    const filled = [fields.campsiteLocation, fields.dutyLabel, fields.activityLabel]
      .filter((value) => value.trim().length > 0).length;
    if (filled === 0) return "UNASSIGNED";
    if (filled === 3) return "SET";
    return "PARTIAL";
  }

  async function loadPreview(scope: { scope: "ONE"; organizationId: string } | { scope: "ALL_SET" }) {
    setSendScope(scope);
    setLoadingPreview(true);
    setSendResult("");
    try {
      const search = new URLSearchParams({ scope: scope.scope });
      if (scope.scope === "ONE") search.set("organizationId", scope.organizationId);
      const response = await fetch(`/api/events/${eventId}/club-assignment-messages?${search.toString()}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "Could not load the preview.");
      setPreview(data.clubAssignmentPreview);
    } catch (err) {
      setSendResult(err instanceof Error ? err.message : "Could not load the preview.");
      setPreview(null);
    } finally {
      setLoadingPreview(false);
    }
  }

  async function sendBatch() {
    if (!preview) return;
    setLoadingPreview(true);
    try {
      const response = await fetch(`/api/events/${eventId}/club-assignment-messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId: crypto.randomUUID(),
          previewFingerprint: preview.fingerprint,
          scope: sendScope.scope,
          ...(sendScope.scope === "ONE" ? { organizationId: sendScope.organizationId } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "Could not send the batch.");
      setSendResult(`Sent to ${data.operation.includedCount} club${data.operation.includedCount === 1 ? "" : "s"}.`);
      setPreview(null);
      setAssignments((rows) => rows.map((row) => {
        const included = preview.recipients.some((recipient) => recipient.organizationId === row.organizationId);
        return included ? { ...row, lastEmailedVersion: row.version, changedSinceSent: false, lastEmailSentAt: new Date().toISOString() } : row;
      }));
    } catch (err) {
      setSendResult(err instanceof Error ? err.message : "Could not send the batch.");
    } finally {
      setLoadingPreview(false);
    }
  }

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Club assignments</p>
          <h2>{eventName}</h2>
          <p>Set each club&rsquo;s campsite, duty, and activity. Directors see only what&rsquo;s set once you save it.</p>
        </div>
      </div>
      {error && <p className="form-error"><CircleAlert aria-hidden="true" size={15} /> {error}</p>}
      <section className="panel">
        {assignments.length === 0 ? (
          <p className="quiet-copy">No clubs have registered yet.</p>
        ) : (
          <div className="report-table-wrap">
            <table className="report-table">
              <caption className="sr-only">Club assignments</caption>
              <thead>
                <tr>
                  <th scope="col">Club</th>
                  <th scope="col">Preferences</th>
                  <th scope="col">Assignment</th>
                  <th scope="col">Status</th>
                  <th scope="col">Email</th>
                  <th scope="col"><span className="sr-only">Edit</span></th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((row) => (
                  <tr key={row.organizationId}>
                    <th scope="row" translate="no">
                      {row.organizationName}
                      {row.sponsoringChurch && <small> · {row.sponsoringChurch}</small>}
                      <br /><small>{row.confirmationCode} · {row.attendeeCount} going</small>
                    </th>
                    <td>
                      {preferenceLines(row.preferences).length === 0
                        ? <small className="quiet-copy">No preferences submitted</small>
                        : <ul className="quiet-copy compact-list">{preferenceLines(row.preferences).map((line) => <li key={line}>{line}</li>)}</ul>}
                    </td>
                    <td>
                      {editingId === row.organizationId ? (
                        <div className="assignment-edit-form">
                          <label>Campsite<input value={draft.campsiteLocation} onChange={(event) => setDraft({ ...draft, campsiteLocation: event.target.value })} maxLength={200} /></label>
                          <label>Campsite notes<input value={draft.campsiteNotes} onChange={(event) => setDraft({ ...draft, campsiteNotes: event.target.value })} maxLength={2000} /></label>
                          <label>Duty<input value={draft.dutyLabel} onChange={(event) => setDraft({ ...draft, dutyLabel: event.target.value })} maxLength={200} /></label>
                          <label>Duty day<input value={draft.dutyDay} onChange={(event) => setDraft({ ...draft, dutyDay: event.target.value })} maxLength={200} /></label>
                          <label>Duty time<input value={draft.dutyTime} onChange={(event) => setDraft({ ...draft, dutyTime: event.target.value })} maxLength={200} /></label>
                          <label>Activity<input value={draft.activityLabel} onChange={(event) => setDraft({ ...draft, activityLabel: event.target.value })} maxLength={200} /></label>
                          <label>Notes<textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} maxLength={2000} /></label>
                          <div className="intro-actions">
                            <button type="button" className="primary-button" disabled={saving} onClick={() => save(row.organizationId)}>Save</button>
                            <button type="button" className="secondary-button" disabled={saving} onClick={() => setEditingId(null)}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <ul className="quiet-copy compact-list">
                          {row.fields.campsiteLocation && <li>Campsite: {row.fields.campsiteLocation}</li>}
                          {row.fields.dutyLabel && <li>Duty: {row.fields.dutyLabel}{row.fields.dutyDay ? ` — ${row.fields.dutyDay}` : ""}{row.fields.dutyTime ? ` ${row.fields.dutyTime}` : ""}</li>}
                          {row.fields.activityLabel && <li>Activity: {row.fields.activityLabel}</li>}
                          {row.fields.notes && <li>Notes: {row.fields.notes}</li>}
                        </ul>
                      )}
                    </td>
                    <td><span className={statusClass(row.status)}>{clubAssignmentStatusLabels[row.status]}</span></td>
                    <td>
                      {row.lastEmailSentAt
                        ? row.changedSinceSent ? <span className="status-chip gold">Changed since sent</span> : <span className="status-chip green">Sent</span>
                        : <span className="status-chip">Not sent</span>}
                      {canSend && (
                        <div>
                          <button type="button" className="text-button" onClick={() => loadPreview({ scope: "ONE", organizationId: row.organizationId })}>
                            <Mail aria-hidden="true" size={13} /> Preview
                          </button>
                        </div>
                      )}
                    </td>
                    <td>
                      {editingId !== row.organizationId && (
                        <button type="button" className="secondary-button" onClick={() => beginEdit(row)}>
                          <Pencil aria-hidden="true" size={13} /> Edit
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {canSend && (
        <section className="panel">
          <h3>Assignment email</h3>
          <p className="field-help">Preview before sending. Staff can send to one club or to every club that is fully set.</p>
          <div className="intro-actions">
            <button type="button" className="secondary-button" onClick={() => loadPreview({ scope: "ALL_SET" })} disabled={loadingPreview}>
              Preview every fully assigned club
            </button>
          </div>
          {preview && (
            <div className="club-assignment-preview">
              <p>
                {preview.includedCount} club{preview.includedCount === 1 ? "" : "s"} will be emailed
                {preview.skippedCount > 0 ? `, ${preview.skippedCount} skipped` : ""}.
              </p>
              {preview.skipped.length > 0 && (
                <ul className="quiet-copy compact-list">
                  {preview.skipped.map((skip) => <li key={skip.organizationId}>{skip.organizationName || skip.organizationId}: {skip.label}</li>)}
                </ul>
              )}
              {preview.includedCount > 0 && (
                <button type="button" className="primary-button" disabled={loadingPreview} onClick={sendBatch}>
                  <Send aria-hidden="true" size={14} /> Send
                </button>
              )}
            </div>
          )}
          {sendResult && <p className="field-help">{sendResult}</p>}
        </section>
      )}
    </section>
  );
}
