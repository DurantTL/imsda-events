"use client";

import { useState } from "react";
import { Check, CheckCheck, Eraser } from "lucide-react";
import type { InstructorRosterRow } from "@/modules/honors/instructor-domain";

type MarkResponse = { people?: InstructorRosterRow[]; locked?: number; writeBack?: { skipped: number } | null; message?: string };

/**
 * A class roster the instructor marks (#833): name and club only. Attended and
 * Completed per person, plus one-click "All attended", "All completed" and
 * "Clear". Completed also marks attended. The server decides everything: this
 * only sends the choice and shows what comes back.
 */
export function InstructorRoster({
  offeringId,
  initialRows,
  editable,
  editDeadline,
  notOpenYet = false,
}: {
  offeringId: string;
  initialRows: InstructorRosterRow[];
  editable: boolean;
  editDeadline: string;
  /** The event hasn't started: the roster is readable, marks open on its start. */
  notOpenYet?: boolean;
}) {
  const [rows, setRows] = useState(initialRows);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const url = `/api/attendee/honor-instructor/classes/${encodeURIComponent(offeringId)}/marks`;

  async function send(body: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({})) as MarkResponse;
      if (!response.ok || !result.people) throw new Error(result.message ?? "The marks could not be saved.");
      setRows(result.people);
      const notes = [
        result.locked ? `${result.locked} already in the honor record were left as they are; ask the conference office to void one if it was a mistake.` : "",
        result.writeBack?.skipped ? `${result.writeBack.skipped} marked completed here have no club roster record to update.` : "",
      ].filter(Boolean);
      setNotice(["Saved.", ...notes].join(" "));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The marks could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const deadline = new Date(editDeadline).toLocaleDateString("en-US", { dateStyle: "long" });
  const attended = rows.filter((row) => row.attended).length;
  const completed = rows.filter((row) => row.completed).length;

  return (
    <section className="public-manage-card">
      {notOpenYet
        ? <div className="inline-notice error" role="status">Marks open when the event starts. You can already see your roster.</div>
        : editable
        ? <p className="field-help">You can change marks until {deadline}.</p>
        : <div className="inline-notice error" role="status">Marks closed on {deadline}. This roster is read only; ask the conference office if something needs to change.</div>}
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <p><strong>{rows.length}</strong> in this class · {attended} attended · {completed} completed</p>
      {editable && rows.length > 0 && (
        <p className="club-invite-actions">
          <button className="secondary-button" disabled={busy} onClick={() => void send({ action: "ALL_ATTENDED" })} type="button"><Check aria-hidden="true" size={14} /> All attended</button>
          <button className="primary-button" disabled={busy} onClick={() => void send({ action: "ALL_COMPLETED" })} type="button"><CheckCheck aria-hidden="true" size={14} /> All completed</button>
          <button className="secondary-button" disabled={busy} onClick={() => void send({ action: "CLEAR" })} type="button"><Eraser aria-hidden="true" size={14} /> Clear</button>
        </p>
      )}
      {rows.length === 0 ? (
        <p className="public-manage-empty">No one has chosen this class yet.</p>
      ) : (
        <div className="report-table-wrap">
          <table className="report-table">
            <caption className="sr-only">People in this class</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Club</th><th scope="col">Attended</th><th scope="col">Completed</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.enrollmentId}>
                  <th scope="row" translate="no">{row.lastName}, {row.firstName}</th>
                  <td translate="no">{row.clubName}</td>
                  <td>
                    <input
                      aria-label={`Attended: ${row.firstName} ${row.lastName}`}
                      checked={row.attended}
                      disabled={busy || !editable || row.completed}
                      onChange={(event) => void send({ action: "SET", enrollmentId: row.enrollmentId, attended: event.target.checked })}
                      type="checkbox"
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Completed: ${row.firstName} ${row.lastName}`}
                      checked={row.completed}
                      disabled={busy || !editable || row.recorded}
                      onChange={(event) => void send({ action: "SET", enrollmentId: row.enrollmentId, completed: event.target.checked })}
                      type="checkbox"
                    />
                    {row.recorded && <small> {row.recordedVoided ? "Recorded, later voided by staff" : "In honor record"}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
