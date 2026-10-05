"use client";

import { SortOrderNote, SortableHeader } from "@/components/list-sort";
import { flipDirection, nameSortLabel, sortByName, sortOrderText, type SortDirection } from "@/lib/list-sort";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Download, ListPlus, Plus, Search, UsersRound } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { HonorPillList } from "@/components/honor-pill-list";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import { bulkScopeSummary } from "@/lib/confirmation-copy";
import { calendarDateIn } from "@/modules/calendar/domain";
import { clubClassLevelLabels } from "@/modules/club-rosters/domain";
import {
  type ClubHonorsRow,
  type MemberHonorEntryRecord,
  bulkHonorButtonState,
  clubHonorsEmptyCopy,
  clubHonorsEmptyState,
  filterClubHonorsRows,
  filterRowsByPersonName,
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

const MULTI_ADD_ID = "honors-multi-add";

/**
 * A club's Honors page (#486): filter by honor, status, and current class
 * (the roster's own class-level column); select several people, or every person a filter shows, and
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
  const [nameSearch, setNameSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkHonorId, setBulkHonorId] = useState("");
  const [bulkStatus, setBulkStatus] = useState<"IN_PROGRESS" | "COMPLETED">("IN_PROGRESS");
  const [bulkDate, setBulkDate] = useState("");
  const [bulkNote, setBulkNote] = useState("");
  const [saving, setSaving] = useState(false);
  // The bulk record shows its count and scope first and applies only on confirm (#743).
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [historyFor, setHistoryFor] = useState<ClubHonorsRow | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [historyError, setHistoryError] = useState("");
  const historyRequest = useRef(0);
  const [voidTarget, setVoidTarget] = useState<MemberHonorEntryRecord | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidError, setVoidError] = useState("");
  const closeHistory = () => { historyRequest.current += 1; setHistoryFor(null); };
  const dialogRef = useAccessibleDialog<HTMLElement>(Boolean(historyFor) && !voidTarget, closeHistory);
  const closeVoid = () => { setVoidTarget(null); setVoidReason(""); };
  const voidDialogRef = useAccessibleDialog<HTMLElement>(Boolean(voidTarget), closeVoid);

  const base = staff
    ? `/api/admin/organizations/${encodeURIComponent(organizationId)}`
    : `/api/attendee/clubs/${encodeURIComponent(organizationId)}`;
  const [nameDirection, setNameDirection] = useState<SortDirection>("asc");
  const visible = useMemo(
    () => sortByName(filterRowsByPersonName(filterClubHonorsRows(rows, {
      honorId: honorFilter || undefined,
      status: (statusFilter || undefined) as "IN_PROGRESS" | "COMPLETED" | undefined,
      classLevel: unitFilter || undefined,
    }), nameSearch), nameDirection),
    [rows, honorFilter, statusFilter, unitFilter, nameSearch, nameDirection],
  );

  const emptyState = clubHonorsEmptyState(rows, visible);
  const bulkState = bulkHonorButtonState(selected.size, Boolean(bulkHonorId));
  const bulkHonorName = honorOptions.find((honor) => honor.id === bulkHonorId)?.name ?? "";
  const selectedNames = rows.filter((row) => selected.has(row.memberId)).map((row) => `${row.firstName} ${row.lastName}`);

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
      setConfirmingBulk(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Honors could not be recorded.");
    } finally {
      setSaving(false);
    }
  }

  // Every history reload goes through here. Only the latest request may update
  // the dialog, so a slow reply for one member never lands in another's history.
  async function loadHistory(memberId: string, request: number) {
    setHistory(null);
    setHistoryError("");
    try {
      const response = await fetch(`${base}/roster/${encodeURIComponent(memberId)}/honors`);
      const result = await response.json().catch(() => ({})) as HistoryResponse;
      if (request !== historyRequest.current) return;
      if (!response.ok) {
        setHistoryError(result.message ?? "Honor history could not be loaded.");
      } else if (!Array.isArray(result.history)) {
        setHistoryError("Honor history could not be loaded.");
      } else {
        setHistory(result);
      }
    } catch {
      if (request !== historyRequest.current) return;
      setHistoryError("Honor history could not be loaded. Check your connection and try again.");
    }
  }

  async function openHistory(row: ClubHonorsRow) {
    const request = ++historyRequest.current;
    setHistoryFor(row);
    await loadHistory(row.memberId, request);
  }

  async function recordSingle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!historyFor) return;
    const formElement = event.currentTarget;
    const request = historyRequest.current;
    const form = new FormData(formElement);
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
      if (request === historyRequest.current) {
        setHistory(result);
        setHistoryError("");
      }
      const refreshed = await fetch(`${base}/honors`);
      const refreshedBody = await refreshed.json().catch(() => ({})) as { rows?: ClubHonorsRow[] };
      if (refreshedBody.rows) setRows(refreshedBody.rows);
      formElement.reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That honor could not be recorded.");
    } finally {
      setSaving(false);
    }
  }

  async function submitVoid(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!historyFor || !voidTarget) return;
    const memberId = historyFor.memberId;
    const request = historyRequest.current;
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
      // The void is done; whatever happens to the history reload below, the
      // entry stays voided.
      closeVoid();
      setVoidError("");
      if (staff) {
        // The staff void answers with no history; load it again.
        if (request === historyRequest.current) await loadHistory(memberId, request);
      } else if (request === historyRequest.current) {
        setHistory(result);
        setHistoryError("");
      }
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
            <div className="report-actions" role="group" aria-label="Export honors">
              <a className="secondary-button" href={`${base}/exports/honors`}>
                <Download aria-hidden="true" size={14} /> Export CSV
              </a>
              {!readOnly && (
                <Link className="secondary-button" href={`/account/clubs/${encodeURIComponent(organizationId)}/exports/honors`}>
                  Print report
                </Link>
              )}
            </div>
          )}
        </div>

        {!readOnly && emptyState !== "NO_MEMBERS" && (
          <p className="honor-multi-add-jump">
            <a className="secondary-button" href={`#${MULTI_ADD_ID}`}>
              <ListPlus aria-hidden="true" size={14} /> Add honors to several members
            </a>
          </p>
        )}

        <div className="club-roster-tools">
          <label className="honor-name-search">
            Find a person
            <span className="honor-name-search-field">
              <Search aria-hidden="true" size={14} />
              <input
                autoComplete="off"
                onChange={(event) => setNameSearch(event.target.value)}
                placeholder="Search by name"
                type="search"
                value={nameSearch}
              />
            </span>
          </label>
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
            Current class
            <select onChange={(event) => setUnitFilter(event.target.value)} value={unitFilter}>
              <option value="">All classes</option>
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

        {emptyState === "NO_MEMBERS" || emptyState === "NO_MATCH" ? (
          <p className="public-manage-empty" role="status"><UsersRound size={17} aria-hidden="true" /> {clubHonorsEmptyCopy[emptyState]}</p>
        ) : (
          <div className="report-table-wrap">
            <SortOrderNote>{sortOrderText(nameSortLabel, nameDirection)}</SortOrderNote>
            <table aria-labelledby="club-honors-heading" className="report-table">
              <thead>
                <tr>
                  {!readOnly && <th><span className="sr-only">Select</span></th>}
                  <SortableHeader active direction={nameDirection} label="Name" onSort={() => setNameDirection(flipDirection(nameDirection))} />
                  <th>Current class</th>
                  <th>Honors</th>
                  <th><span className="sr-only">Add honor and history</span></th>
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
                    <td data-label="Current class">{row.classLevel ? clubClassLevelLabels[row.classLevel as keyof typeof clubClassLevelLabels] : "—"}</td>
                    <td data-label="Honors">
                      <HonorPillList honors={row.honors} showStatus />
                    </td>
                    <td data-label="Add honor">
                      <button aria-label={`Add or view honors for ${row.firstName} ${row.lastName}`} className="secondary-button honor-add-button" onClick={() => openHistory(row)} type="button">
                        <Plus aria-hidden="true" size={13} /> Add
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {emptyState === "NO_HONORS" && (
          <p className="public-manage-empty" role="status">
            <UsersRound size={17} aria-hidden="true" /> {readOnly ? "No honors recorded yet." : clubHonorsEmptyCopy.NO_HONORS}
          </p>
        )}

        {!readOnly && emptyState !== "NO_MEMBERS" && (
          <section aria-labelledby="honors-multi-add-heading" className="honor-multi-add" id={MULTI_ADD_ID} tabIndex={-1}>
          <h3 id="honors-multi-add-heading">Add honors to several members</h3>
          <p className="field-help">Tick the names above (or Select all shown), choose an honor, then record it for everyone ticked.</p>
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
                Completion date (optional)
                <input onChange={(event) => setBulkDate(event.target.value)} type="date" value={bulkDate} />
              </label>
            )}
            <label>
              Note (optional)
              <input aria-describedby="honor-note-help" maxLength={500} onChange={(event) => setBulkNote(event.target.value)} value={bulkNote} />
              <small className="field-help" id="honor-note-help">Notes stay with the member&apos;s history, including in future clubs. No health details.</small>
            </label>
            <div className="honor-bulk-submit">
              <button
                aria-describedby={bulkState.disabledReason ? "honor-bulk-reason" : undefined}
                className="primary-button"
                disabled={saving || Boolean(bulkState.disabledReason)}
                onClick={() => { setError(""); setConfirmingBulk(true); }}
                type="button"
              >
                {bulkState.label}
              </button>
              {bulkState.disabledReason && <small className="field-help" id="honor-bulk-reason">{bulkState.disabledReason}</small>}
            </div>
          </div>
          </section>
        )}
      </section>
      <ConfirmDialog
        busy={saving}
        busyLabel="Recording…"
        confirmLabel={`Record ${bulkHonorName || "honor"}`}
        error={confirmingBulk ? error : ""}
        onCancel={() => setConfirmingBulk(false)}
        onConfirm={() => void applyBulk()}
        open={confirmingBulk}
        title={`Record ${bulkHonorName || "this honor"} for ${bulkScopeSummary({ count: selected.size, singular: "person", plural: "people" })}?`}
      >
        <p className="confirm-scope">
          <strong>{bulkScopeSummary({ count: selected.size, singular: "person", plural: "people", scope: `the ${clubYear} roster` })}</strong>
          {selectedNames.length > 0 && <>: {selectedNames.slice(0, 5).join(", ")}{selectedNames.length > 5 ? `, and ${selectedNames.length - 5} more` : ""}</>}.
        </p>
        <p>Each will be marked <strong>{memberHonorStatusLabels[bulkStatus]}</strong>{bulkStatus === "COMPLETED" && bulkDate ? ` on ${bulkDate}` : ""}.{bulkStatus === "COMPLETED" ? " An in-progress entry for the same honor is replaced, and stays in the history." : ""} Nothing is recorded until you confirm; a wrong entry can be voided afterwards.</p>
      </ConfirmDialog>

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
            {historyError ? (
              <div className="form-stack">
                <p className="form-error" role="alert">{historyError}</p>
                <button className="secondary-button" onClick={() => { dialogRef.current?.focus(); void loadHistory(historyFor.memberId, ++historyRequest.current); }} type="button">Retry</button>
              </div>
            ) : !history ? (
              <p className="public-manage-empty" role="status">Loading history…</p>
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
                        className="honor-void-button"
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
                    Completion date (optional)
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
