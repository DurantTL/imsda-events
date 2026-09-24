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

const deliveryModeLabels: Record<ClubAssignmentPreview["deliveryMode"], string> = {
  EXTERNAL_EMAIL: "Emails are queued, not sent; Process email queue in the Delivery log sends them.",
  LOCAL_CAPTURE: "Local capture: messages are captured inside IMSDA Events and no email is sent.",
  DISABLED: "Delivery is off: rows are recorded as suppressed and no email is sent.",
};

function sendButtonLabel(preview: ClubAssignmentPreview) {
  const count = preview.includedCount;
  const plural = count === 1 ? "" : "s";
  if (preview.deliveryMode === "DISABLED" || !preview.templateEnabled) return `Record ${count} suppressed row${plural}`;
  if (preview.deliveryMode === "LOCAL_CAPTURE") return `Capture ${count} local preview${plural}`;
  return `Queue ${count} assignment email${plural}`;
}

type BatchOperation = {
  replayed: boolean;
  deliveryMode: ClubAssignmentPreview["deliveryMode"];
  queuedCount: number;
  capturedCount: number;
  suppressedCount: number;
};

function batchNotice(operation: BatchOperation) {
  if (operation.replayed) {
    return "This exact batch was already recorded, so no duplicate messages were created.";
  }
  if (operation.suppressedCount > 0) {
    return `${operation.suppressedCount} club assignment row${operation.suppressedCount === 1 ? " was" : "s were"} recorded as suppressed. Delivery or the template is off, so no email was sent and these clubs still show as not sent.`;
  }
  if (operation.deliveryMode === "EXTERNAL_EMAIL") {
    return `${operation.queuedCount} club assignment email${operation.queuedCount === 1 ? " is" : "s are"} queued but not sent. Review the Delivery log, then use Process email queue when ready.`;
  }
  return `${operation.capturedCount} club assignment email${operation.capturedCount === 1 ? " was" : "s were"} captured locally. No email was sent.`;
}

/** The email block's Markdown list, as plain lines for the preview table. */
function blockLines(block: string) {
  return block.split("\n").map((line) => line.replace(/^- /, "").replaceAll("**", "")).filter(Boolean);
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
  const [sendError, setSendError] = useState<string>("");
  const [batchId, setBatchId] = useState("");
  const [confirmed, setConfirmed] = useState(false);

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

  async function refreshAssignments() {
    try {
      const response = await fetch(`/api/events/${eventId}/club-assignments`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(data.assignments)) setAssignments(data.assignments);
    } catch {
      // The send already succeeded; a stale sent badge is fixed by a reload.
    }
  }

  function showPreview(next: ClubAssignmentPreview | null) {
    setPreview(next);
    // A batch ID belongs to one reviewed preview: a new preview is a new
    // review, so it gets a new ID and a fresh confirmation.
    setBatchId("");
    setConfirmed(false);
  }

  async function loadPreview(scope: { scope: "ONE"; organizationId: string } | { scope: "ALL_SET" }) {
    setSendScope(scope);
    setLoadingPreview(true);
    setSendResult("");
    setSendError("");
    try {
      const search = new URLSearchParams({ scope: scope.scope });
      if (scope.scope === "ONE") search.set("organizationId", scope.organizationId);
      const response = await fetch(`/api/events/${eventId}/club-assignment-messages?${search.toString()}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message ?? "Could not load the preview.");
      showPreview(data.clubAssignmentPreview);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Could not load the preview.");
      showPreview(null);
    } finally {
      setLoadingPreview(false);
    }
  }

  async function sendBatch(submitEvent: React.FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    if (!preview || !confirmed) return;
    // Minted once per reviewed preview and reused on a retry (a double click,
    // a dropped response), so the server replays instead of queueing twice.
    const clientBatchId = batchId || crypto.randomUUID();
    setBatchId(clientBatchId);
    setLoadingPreview(true);
    setSendResult("");
    setSendError("");
    try {
      const response = await fetch(`/api/events/${eventId}/club-assignment-messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId: clientBatchId,
          previewFingerprint: preview.fingerprint,
          scope: sendScope.scope,
          ...(sendScope.scope === "ONE" ? { organizationId: sendScope.organizationId } : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.operation) {
        if (data.clubAssignmentPreview) showPreview(data.clubAssignmentPreview);
        throw new Error(data.message ?? "Could not create the batch.");
      }
      showPreview(null);
      setSendResult(batchNotice(data.operation));
      await refreshAssignments();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Could not create the batch.");
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
          <p className="field-help">Preview before sending. Send to one club, or to every fully set club that hasn&rsquo;t already received its current assignment.</p>
          <div className="intro-actions">
            <button type="button" className="secondary-button" onClick={() => loadPreview({ scope: "ALL_SET" })} disabled={loadingPreview}>
              Preview every fully assigned club
            </button>
          </div>
          {preview && (
            <form className="club-assignment-preview" onSubmit={sendBatch}>
              <p>
                <strong>{preview.includedCount}</strong> club{preview.includedCount === 1 ? "" : "s"} included
                {preview.skippedCount > 0 ? `, ${preview.skippedCount} skipped` : ""}.
                {" "}{deliveryModeLabels[preview.deliveryMode]}
              </p>
              {!preview.templateEnabled && (
                <p className="form-error" role="alert">
                  <CircleAlert aria-hidden="true" size={15} /> The Club assignments template is disabled. This batch will be recorded as suppressed and no email will be sent.
                </p>
              )}
              {preview.recipients.some((recipient) => recipient.alreadySentThisVersion) && (
                <p className="form-error" role="alert">
                  <CircleAlert aria-hidden="true" size={15} /> {preview.recipients.filter((recipient) => recipient.alreadySentThisVersion).map((recipient) => recipient.organizationName).join(", ")} already received this exact assignment. Sending again resends the same email.
                </p>
              )}
              {preview.recipients.length > 0 && (
                <div className="report-table-wrap">
                  <table className="report-table">
                    <caption className="sr-only">Clubs that will be emailed</caption>
                    <thead>
                      <tr>
                        <th scope="col">Club</th>
                        <th scope="col">Director</th>
                        <th scope="col">Email</th>
                        <th scope="col">Assignment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.recipients.map((recipient) => (
                        <tr key={recipient.organizationId}>
                          <th scope="row" translate="no">
                            {recipient.organizationName}
                            <br /><small>{recipient.confirmationCode}</small>
                            {recipient.alreadySentThisVersion && <><br /><span className="status-chip gold">Already sent this version</span></>}
                          </th>
                          <td translate="no">{recipient.recipientName}</td>
                          <td translate="no">{recipient.recipientEmail}</td>
                          <td>
                            <ul className="quiet-copy compact-list">
                              {blockLines(recipient.assignmentBlock).map((line) => <li key={line}>{line}</li>)}
                            </ul>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {preview.skipped.length > 0 && (
                <>
                  <p className="field-help">Skipped</p>
                  <ul className="quiet-copy compact-list">
                    {preview.skipped.map((skip) => <li key={skip.organizationId}>{skip.organizationName || skip.organizationId}: {skip.label}</li>)}
                  </ul>
                </>
              )}
              {preview.sample && (
                <div className="club-assignment-sample">
                  <p className="field-help">
                    Sample message for {preview.recipients.find((recipient) => recipient.organizationId === preview.sample?.organizationId)?.organizationName ?? "the first club"}
                    {preview.templateVersionNumber !== null ? ` (template version ${preview.templateVersionNumber})` : ""}
                  </p>
                  <p><strong>Subject:</strong> {preview.sample.subject}</p>
                  <pre className="message-body-snapshot">{preview.sample.body}</pre>
                </div>
              )}
              {preview.includedCount > 0 && (
                <>
                  <label className="message-enabled-toggle reminder-confirm-check">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      required
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    <span>
                      <strong>I reviewed all {preview.includedCount} club{preview.includedCount === 1 ? "" : "s"} and the sample message above.</strong>
                      <small>If an assignment, contact, template, or sender setting changes before this is created, IMSDA Events will stop and require a new review.</small>
                    </span>
                  </label>
                  <button type="submit" className="primary-button" disabled={loadingPreview || !confirmed}>
                    <Send aria-hidden="true" size={14} /> {sendButtonLabel(preview)}
                  </button>
                </>
              )}
            </form>
          )}
          {sendError && <p className="form-error" role="alert"><CircleAlert aria-hidden="true" size={15} /> {sendError}</p>}
          {sendResult && <p className="field-help" role="status">{sendResult}</p>}
        </section>
      )}
    </section>
  );
}
