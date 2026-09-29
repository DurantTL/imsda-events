"use client";

import { useMemo, useState } from "react";
import { Download, History, UsersRound } from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import { calendarDateIn } from "@/modules/calendar/domain";
import { clubClassLevelLabels } from "@/modules/club-rosters/domain";
import {
  type ClubHonorsRow,
  type MemberHonorEntryRecord,
  filterClubHonorsRows,
  memberHonorStatusLabels,
} from "@/modules/honors/member-honor-domain";

type HonorOption = { id: string; code: string; name: string };

type HistoryResponse = {
  firstName: string;
  lastName: string;
  current: ReturnType<typeof filterClubHonorsRows>[number]["honors"];
  history: MemberHonorEntryRecord[];
  message?: string;
  issues?: Array<{ message?: string }>;
};

const statusTone = { IN_PROGRESS: "gold", COMPLETED: "green" } as const;

/**
 * A club's Honors page (#486): filter by honor, status, and unit (the
 * roster's own class-level grouping — there's no separate "unit" on the
 * roster today); select several people, or every person a filter shows, and
 * mark one honor in one action; open one person for their full history and a
 * single-member edit. Area Coordinators get this same view with `readOnly`
 * (their own mechanism, not a club role, so no edit endpoint is ever called).
 * `canVoid` shows the Void action to a director or deputy (the server checks
 * again); `staff` is the conference staff's read-only view with a Void action
 * on every entry, through the staff endpoints (#591).
 */
export function ClubHonorsWorkspace({
  organizationId,
  clubYear,
  initialRows,
  honorOptions,
  readOnly = false,
  canVoid = false,
  staff = false,
}: {
  organizationId: string;
  clubYear: string;
  initialRows: ClubHonorsRow[];
  honorOptions: HonorOption[];
  readOnly?: boolean;
  canVoid?: boolean;
  staff?: boolean;
}) {
  const [rows, setRows] = useState(initialRows);
  const [honorFilter, setHonorFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [unitFilter, setUnitFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkHonorId, setBulkHonorId] = useState("");
  const [bulkStatus, setBulkStatus] = useState<"IN_PROGRESS" | "COMPLETED">("IN_PROGRESS");
  const [bulkDate, setBulkDate] = useState("");
  const [bulkNote, setBulkNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [historyFor, setHistoryFor] = useState<ClubHonorsRow | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [voidTarget, setVoidTarget] = useState<MemberHonorEntryRecord | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidError, setVoidError] = useState("");
  const closeHistory = () => setHistoryFor(null);
  const dialogRef = useAccessibleDialog<HTMLElement>(Boolean(historyFor) && !voidTarget, closeHistory);
  const closeVoid = () => { setVoidTarget(null); setVoidReason(""); };
  const voidDialogRef = useAccessibleDialog<HTMLElement>(Boolean(voidTarget), closeVoid);

  const base = staff
    ? `/api/admin/organizations/${encodeURIComponent(organizationId)}`
    : `/api/attendee/clubs/${encodeURIComponent(organizationId)}`;
  const visible = useMemo(
    () => filterClubHonorsRows(rows, {
      honorId: honorFilter || undefined,
      status: (statusFilter || undefined) as "IN_PROGRESS" | "COMPLETED" | undefined,
      classLevel: unitFilter || undefined,
    }),
    [rows, honorFilter, statusFilter, unitFilter],
  );

  function toggle(memberId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) next.delete(memberId); else next.add(memberId);
      return next;
    });
  }

  function selectAllShown() {
    setSelected(new Set(visible.map((row) => row.memberId)));
  }

  async function applyBulk() {
    if (!bulkHonorId || selected.size === 0) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${base}/honors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberIds: [...selected],
          honorId: bulkHonorId,
          status: bulkStatus,
          completionDate: bulkStatus === "COMPLETED" ? bulkDate : "",
          note: bulkNote,
        }),
      });
      const result = await response.json().catch(() => ({})) as { rows?: ClubHonorsRow[]; message?: string; issues?: Array<{ message?: string }> };
      if (!response.ok) throw new Error(result.message ?? result.issues?.[0]?.message ?? "Honors could not be recorded.");
      if (result.rows) setRows(result.rows);
      setNotice(`Recorded for ${selected.size} ${selected.size === 1 ? "person" : "people"}.`);
      setSelected(new Set());
      setBulkNote("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Honors could not be recorded.");
    } finally {
      setSaving(false);
    }
  }

  async function openHistory(row: ClubHonorsRow) {
    setHistoryFor(row);
    setHistory(null);
    try {
      const response = await fetch(`${base}/roster/${encodeURIComponent(row.memberId)}/honors`);
      const result = await response.json().catch(() => ({})) as HistoryResponse;
      if (response.ok) setHistory(result);
    } catch {
      // The dialog just stays on "Loading history…" below; nothing to record.
    }
  }

  async function recordSingle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!historyFor) return;
    const form = new FormData(event.currentTarget);
    const status = String(form.get("status") ?? "IN_PROGRESS");
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`${base}/roster/${encodeURIComponent(historyFor.memberId)}/honors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          honorId: String(form.get("honorId") ?? ""),
          status,
          completionDate: status === "COMPLETED" ? String(form.get("completionDate") ?? "") : "",
          note: String(form.get("note") ?? ""),
        }),
      });
      const result = await response.json().catch(() => ({})) as HistoryResponse;
      if (!response.ok) throw new Error(result.message ?? result.issues?.[0]?.message ?? "That honor could not be recorded.");
      setHistory(result);
      const refreshed = await fetch(`${base}/honors`);
      const refreshedBody = await refreshed.json().catch(() => ({})) as { rows?: ClubHonorsRow[] };
      if (refreshedBody.rows) setRows(refreshedBody.rows);
      event.currentTarget.reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That honor could not be recorded.");
    } finally {
      setSaving(false);
    }
  }

  async function submitVoid(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!historyFor || !voidTarget) return;
    setSaving(true);
    setVoidError("");
    try {
      const voidUrl = staff
        ? `/api/admin/honor-entries/${encodeURIComponent(voidTarget.id)}/void`
        : `${base}/roster/${encodeURIComponent(historyFor.memberId)}/honors/${encodeURIComponent(voidTarget.id)}/void`;
      const response = await fetch(voidUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: voidReason }),
      });
      const result = await response.json().catch(() => ({})) as HistoryResponse;
      if (!response.ok) throw new Error(result.message ?? result.issues?.[0]?.message ?? "That entry could not be voided.");
      if (staff) {
        // The staff void answers with no history; load it again.
        const reloaded = await fetch(`${base}/roster/${encodeURIComponent(historyFor.memberId)}/honors`);
        const reloadedBody = await reloaded.json().catch(() => null) as HistoryResponse | null;
        setHistory(reloaded.ok ? reloadedBody : null);
      } else {
        setHistory(result);
      }
      closeVoid();
      const refreshed = await fetch(`${base}/honors`);
      const refreshedBody = await refreshed.json().catch(() => ({})) as { rows?: ClubHonorsRow[] };
      if (refreshedBody.rows) setRows(refreshedBody.rows);
      setNotice("Entry voided. It stays in the history.");
    } catch (caught) {
      setVoidError(caught instanceof Error ? caught.message : "That entry could not be voided.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="club-roster-stack">
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      <section className="public-manage-card" aria-labelledby="club-honors-heading">
        <div className="public-manage-card-heading club-roster-heading">
          <div>
            <p className="public-registration-eyebrow">Club year {clubYear}</p>
            <h2 id="club-honors-heading">Honors</h2>
          </div>
          {!staff && (
            <a className="secondary-button" href={`${base}/honors/csv`}>
              <Download aria-hidden="true" size={14} /> Export CSV
            </a>
          )}
        </div>

        <div className="club-roster-tools">
          <label>
            Honor
            <select onChange={(event) => setHonorFilter(event.target.value)} value={honorFilter}>
              <option value="">All honors</option>
              {honorOptions.map((honor) => (
                <option key={honor.id} value={honor.id}>{honor.name}</option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}>
              <option value="">All statuses</option>
              {Object.entries(memberHonorStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Unit
            <select onChange={(event) => setUnitFilter(event.target.value)} value={unitFilter}>
              <option value="">All units</option>
              {Object.entries(clubClassLevelLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          {!readOnly && (
            <button className="text-button" disabled={visible.length === 0} onClick={selectAllShown} type="button">
              <UsersRound aria-hidden="true" size={14} /> Select all shown ({visible.length})
            </button>
          )}
        </div>

        {visible.length === 0 ? (
          <p className="public-manage-empty"><UsersRound size={17} aria-hidden="true" /> No one matches these filters.</p>
        ) : (
          <div className="report-table-wrap">
            <table aria-labelledby="club-honors-heading" className="report-table">
              <thead>
                <tr>
                  {!readOnly && <th><span className="sr-only">Select</span></th>}
                  <th>Name</th>
                  <th>Unit</th>
                  <th>Honors</th>
                  <th><span className="sr-only">History</span></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.memberId}>
                    {!readOnly && (
                      <td data-label="Select">
                        <input
                          aria-label={`Select ${row.firstName} ${row.lastName}`}
                          checked={selected.has(row.memberId)}
                          onChange={() => toggle(row.memberId)}
                          type="checkbox"
                        />
                      </td>
                    )}
                    <td data-label="Name"><strong translate="no">{row.lastName}, {row.firstName}</strong></td>
                    <td data-label="Unit">{row.classLevel ? clubClassLevelLabels[row.classLevel as keyof typeof clubClassLevelLabels] : "—"}</td>
                    <td data-label="Honors">
                      {row.honors.length === 0 ? "—" : (
                        <div className="roster-flag-list">
                          {row.honors.map((honor) => (
                            <span
                              className={`status-chip ${statusTone[honor.status]}`}
                              key={honor.honorId}
                              title={honor.completionDate ? `Completed ${honor.completionDate}` : undefined}
                            >
                              {honor.honorName} · {memberHonorStatusLabels[honor.status]}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td data-label="History">
                      <button aria-label={`Honor history for ${row.firstName} ${row.lastName}`} className="secondary-button" onClick={() => openHistory(row)} type="button">
                        <History aria-hidden="true" size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!readOnly && (
          <div className="club-roster-tools honor-bulk-actions">
            <label>
              Honor
              <select onChange={(event) => setBulkHonorId(event.target.value)} value={bulkHonorId}>
                <option value="">Choose an honor</option>
                {honorOptions.map((honor) => (
                  <option key={honor.id} value={honor.id}>{honor.name}</option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select onChange={(event) => setBulkStatus(event.target.value as "IN_PROGRESS" | "COMPLETED")} value={bulkStatus}>
                {Object.entries(memberHonorStatusLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            {bulkStatus === "COMPLETED" && (
              <label>
                Completion date
                <input onChange={(event) => setBulkDate(event.target.value)} type="date" value={bulkDate} />
              </label>
            )}
            <label>
              Note (optional)
              <input aria-describedby="honor-note-help" maxLength={500} onChange={(event) => setBulkNote(event.target.value)} value={bulkNote} />
              <small className="field-help" id="honor-note-help">Notes stay with the member&apos;s history, including in future clubs. No health details.</small>
            </label>
            <button
              className="primary-button"
              disabled={saving || selected.size === 0 || !bulkHonorId}
              onClick={applyBulk}
              type="button"
            >
              Mark for {selected.size} selected
            </button>
          </div>
        )}
      </section>

      {historyFor && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeHistory(); }} role="presentation">
          <section aria-labelledby="honor-history-title" aria-modal="true" className="modal-card" ref={dialogRef} role="dialog" tabIndex={-1}>
            <div className="modal-head">
              <div>
                <p className="public-registration-eyebrow">Honor history</p>
                <h2 id="honor-history-title" translate="no">{historyFor.firstName} {historyFor.lastName}</h2>
              </div>
              <button aria-label="Close" className="icon-button modal-close-button" onClick={closeHistory} type="button">×</button>
            </div>
            {!history ? (
              <p className="public-manage-empty">Loading history…</p>
            ) : history.history.length === 0 ? (
              <p className="public-manage-empty">No honors recorded yet.</p>
            ) : (
              <ul className="public-manage-club-list">
                {history.history.map((entry) => (
                  <li key={entry.id}>
                    <span>
                      <strong style={entry.voided ? { textDecoration: "line-through" } : undefined}>{entry.honorName}</strong>
                      <small style={entry.voided ? { textDecoration: "line-through" } : undefined}>
                        {memberHonorStatusLabels[entry.status]}{entry.completionDate ? ` · ${entry.completionDate}` : ""}
                        {" · "}{entry.recordedByName}, {entry.recordedAtOrganizationName}
                        {entry.note ? ` · ${entry.note}` : ""}
                      </small>
                      {entry.voided && (
                        <small>
                          Voided by <span translate="no">{entry.voided.voidedByName}</span> on {calendarDateIn(new Date(entry.voided.voidedAt))}: {entry.voided.reason}
                        </small>
                      )}
                    </span>
                    {!entry.voided && (staff || (!readOnly && canVoid && entry.recordedAtOrganizationId === organizationId)) && (
                      <button
                        aria-label={`Void ${entry.honorName} entry`}
                        className="text-button"
                        onClick={() => { setVoidError(""); setVoidReason(""); setVoidTarget(entry); }}
                        type="button"
                      >
                        Void
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && (
              <form className="form-stack" key={historyFor.memberId} onSubmit={recordSingle}>
                <div className="form-grid two-column">
                  <label>
                    Honor
                    <select defaultValue="" name="honorId" required>
                      <option disabled value="">Choose an honor</option>
                      {honorOptions.map((honor) => (
                        <option key={honor.id} value={honor.id}>{honor.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Status
                    <select defaultValue="IN_PROGRESS" name="status">
                      {Object.entries(memberHonorStatusLabels).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Completion date
                    <input name="completionDate" type="date" />
                  </label>
                  <label>
                    Note (optional)
                    <input aria-describedby="honor-member-note-help" maxLength={500} name="note" />
                    <small className="field-help" id="honor-member-note-help">Notes stay with the member&apos;s history, including in future clubs. No health details.</small>
                  </label>
                </div>
                <div className="form-actions">
                  <button className="secondary-button" onClick={closeHistory} type="button">Close</button>
                  <button className="primary-button" disabled={saving} type="submit">Record</button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}

      {historyFor && voidTarget && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeVoid(); }} role="presentation">
          <section aria-labelledby="honor-void-title" aria-modal="true" className="modal-card" ref={voidDialogRef} role="dialog" tabIndex={-1}>
            <div className="modal-head">
              <div>
                <p className="public-registration-eyebrow">Void honor entry</p>
                <h2 id="honor-void-title">{voidTarget.honorName} · {memberHonorStatusLabels[voidTarget.status]}</h2>
              </div>
              <button aria-label="Close" className="icon-button modal-close-button" onClick={closeVoid} type="button">×</button>
            </div>
            <form className="form-stack" onSubmit={submitVoid}>
              <p>
                The entry stays in the history, struck through, with your name, the date and this reason. It no longer counts
                toward the member&apos;s current honors, awards or reports. A void can&apos;t be undone; to restore it, record a new entry.
              </p>
              {voidError && <div className="inline-notice error" role="alert">{voidError}</div>}
              <label>
                Reason (required)
                <textarea maxLength={500} minLength={3} onChange={(event) => setVoidReason(event.target.value)} required rows={3} value={voidReason} />
                <small className="field-help">3 to 500 characters. No health details.</small>
              </label>
              <div className="form-actions">
                <button className="secondary-button" onClick={closeVoid} type="button">Cancel</button>
                <button className="primary-button" disabled={saving || voidReason.trim().length < 3} type="submit">Void entry</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
