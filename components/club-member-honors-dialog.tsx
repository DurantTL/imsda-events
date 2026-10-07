"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HonorCombobox } from "@/components/honor-combobox";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import {
  type MemberHonorEntryRecord,
  currentHonorsFromHistory,
  memberHonorsDialogMode,
  memberHonorStatusLabels,
} from "@/modules/honors/member-honor-domain";

type HonorOption = { id: string; code: string; name: string };

type HistoryResponse = {
  history: MemberHonorEntryRecord[];
  message?: string;
  issues?: Array<{ message?: string }>;
};

/**
 * One person's honors, opened from a roster row (#701). It reads and records
 * through the Honors page's own endpoints, so the server applies exactly the
 * same access, rules and audit logging: the list is the append-only history,
 * the record form posts the same single-member entry as the Honors page, and
 * a role that can't record gets a view-only popup (`canRecord` is only a hint
 * for the UI; the endpoint checks again, and the Honors list says whether the
 * caller may edit).
 */
export function ClubMemberHonorsDialog({
  organizationId,
  member,
  canRecord,
  onClose,
  onRecorded,
}: {
  organizationId: string;
  member: { id: string; firstName: string; lastName: string };
  canRecord: boolean;
  onClose: () => void;
  /** Called after a new honor is saved, so the roster row's chips can refresh. */
  onRecorded?: () => void;
}) {
  const base = `/api/attendee/clubs/${encodeURIComponent(organizationId)}`;
  const [history, setHistory] = useState<MemberHonorEntryRecord[] | null>(null);
  const [honors, setHonors] = useState<HonorOption[]>([]);
  const [mayRecord, setMayRecord] = useState(canRecord);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [honorId, setHonorId] = useState("");
  const [saving, setSaving] = useState(false);
  const dialogRef = useAccessibleDialog<HTMLElement>(true, onClose);
  // The honors list scrolls inside a capped height, so it is a keyboard stop only while it actually scrolls.
  const listRef = useRef<HTMLUListElement>(null);
  const [listScrolls, setListScrolls] = useState(false);
  useEffect(() => {
    const node = listRef.current;
    setListScrolls(Boolean(node && node.scrollHeight > node.clientHeight + 1));
  }, [history]);

  const load = useCallback(async () => {
    try {
      const [historyResponse, honorsResponse] = await Promise.all([
        fetch(`${base}/roster/${encodeURIComponent(member.id)}/honors`),
        canRecord ? fetch(`${base}/honors`) : Promise.resolve(null),
      ]);
      const historyBody = await historyResponse.json().catch(() => ({})) as HistoryResponse;
      if (!historyResponse.ok) throw new Error(historyBody.message ?? "Honors could not be loaded.");
      if (honorsResponse) {
        const body = await honorsResponse.json().catch(() => ({})) as { honors?: HonorOption[]; readOnly?: boolean };
        const mode = memberHonorsDialogMode(canRecord, { ok: honorsResponse.ok, readOnly: Boolean(body.readOnly) });
        if (mode === "LOAD_ERROR") throw new Error("The honor list could not be loaded.");
        setHonors(body.honors ?? []);
        setMayRecord(mode === "RECORD");
      }
      setHistory(historyBody.history);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "Honors could not be loaded.");
    }
  }, [base, canRecord, member.id]);

  useEffect(() => {
    // Loading the person's honors when the popup opens; state is set once the fetch settles.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function record(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const chosenStatus = String(form.get("status") ?? "IN_PROGRESS");
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${base}/roster/${encodeURIComponent(member.id)}/honors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          honorId: String(form.get("honorId") ?? ""),
          status: chosenStatus,
          completionDate: chosenStatus === "COMPLETED" ? String(form.get("completionDate") ?? "") : "",
          note: String(form.get("note") ?? ""),
        }),
      });
      const result = await response.json().catch(() => ({})) as HistoryResponse;
      if (!response.ok) throw new Error(result.message ?? result.issues?.[0]?.message ?? "That honor could not be recorded.");
      setHistory(result.history);
      setNotice("Honor recorded.");
      formElement.reset();
      setHonorId("");
      onRecorded?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That honor could not be recorded.");
    } finally {
      setSaving(false);
    }
  }

  const current = currentHonorsFromHistory(history ?? []);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
      <section aria-labelledby="roster-honors-title" aria-modal="true" className="modal-card member-honors-dialog" ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="modal-head">
          <div>
            <p className="public-registration-eyebrow">Honors</p>
            <h2 id="roster-honors-title" translate="no">{member.firstName} {member.lastName}</h2>
          </div>
          <button aria-label="Close" className="icon-button modal-close-button" onClick={onClose} type="button">×</button>
        </div>
        {loadError ? (
          <div className="inline-notice error" role="alert">{loadError}</div>
        ) : !history ? (
          <p className="public-manage-empty">Loading honors…</p>
        ) : current.length === 0 ? (
          <p className="public-manage-empty">No honors recorded yet.</p>
        ) : (
          <ul className="public-manage-club-list member-honors-list" aria-label="Recorded honors" ref={listRef} tabIndex={listScrolls ? 0 : undefined}>
            {current.map((entry) => (
              <li key={entry.honorId}>
                <span>
                  <strong translate="no">{entry.honorName}</strong>
                  <small>
                    <span className="member-honor-status">{memberHonorStatusLabels[entry.status]}</span>{entry.completionDate ? ` · ${entry.completionDate}` : ""}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        )}
        {notice && <div className="inline-notice success" role="status">{notice}</div>}
        {error && <div className="inline-notice error" role="alert">{error}</div>}
        {mayRecord && history && (
          <form className="form-stack" onSubmit={record}>
            <div className="form-grid two-column">
              <HonorCombobox label="Honor" name="honorId" onChange={setHonorId} options={honors} required value={honorId} />
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
                <input aria-describedby="roster-honor-note-help" maxLength={500} name="note" />
                <small className="field-help" id="roster-honor-note-help">Notes stay with the member&apos;s history, including in future clubs. No health details.</small>
              </label>
            </div>
            <div className="form-actions">
              <button className="secondary-button" onClick={onClose} type="button">Close</button>
              <button className="primary-button" disabled={saving || honors.length === 0} type="submit">Record honor</button>
            </div>
          </form>
        )}
        {!mayRecord && history && (
          <div className="form-actions">
            <p className="field-help">View only. You can see this person&apos;s honors but not record them here.</p>
            <button className="secondary-button" onClick={onClose} type="button">Close</button>
          </div>
        )}
      </section>
    </div>
  );
}
