"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeftRight, ChevronDown, Filter } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { TransferDate, transferEventLabel } from "@/components/transfer-format";
import {
  memberTransferStaffReasonLabels,
  memberTransferStaffStatusLabels,
  staffQueueFilters,
  type MemberTransferStaffReason,
  type MemberTransferStatus,
  type StaffQueueFilter,
} from "@/modules/club-transfers/domain";
import type { StaffTransferRecord } from "@/modules/club-transfers/repository";

/**
 * The conference staff transfer queue (#489): overdue (14+ days
 * unanswered), declined, unmatched, pending, or every open transfer.
 * Finish is offered only once a request is overdue; override is offered any
 * time and needs a note; an unmatched request is overridden by choosing the
 * sending club's member. Close ends a request without moving anyone.
 */

const filterLabels: Record<StaffQueueFilter, string> = {
  open: "All open",
  overdue: "Overdue (14+ days)",
  declined: "Declined",
  unmatched: "Unmatched",
  pending: "Pending",
};

const API = "/api/admin/club-transfers";

type Action = { transfer: StaffTransferRecord; kind: "finish" | "override" | "cancel" };
type Candidate = { rosterMemberId: string; firstName: string; lastName: string; attendeeType: string };

/** One queue card. Hook-free so it renders on its own in tests. */
export function StaffTransferCard({ transfer, onAction }: { transfer: StaffTransferRecord; onAction: (action: Action) => void }) {
  return (
    <li className="transfer-card">
      <div className="transfer-card-head">
        <strong translate="no">{transfer.matchedMemberName ?? transfer.requestedName}</strong>
        <span className={`status-chip ${transfer.overdue || transfer.status === "DECLINED" || transfer.status === "UNMATCHED" ? "coral" : "gold"}`}>
          {transfer.overdue ? "Overdue" : memberTransferStaffStatusLabels[transfer.status as MemberTransferStatus]}
        </span>
      </div>
      <p>
        <span translate="no">{transfer.fromOrganizationName}</span> → <span translate="no">{transfer.toOrganizationName}</span> · requested <TransferDate iso={transfer.initiatedAt} /> · due <TransferDate iso={transfer.acknowledgeDueAt} />
      </p>
      {transfer.matchedMemberName && transfer.matchedMemberName !== transfer.requestedName && (
        <p>Typed as: <span translate="no">{transfer.requestedName}</span></p>
      )}
      {transfer.staffReason && <p>Needs staff: {memberTransferStaffReasonLabels[transfer.staffReason as MemberTransferStaffReason]}</p>}
      <p>Reason: {transfer.reason}</p>
      {transfer.events.length > 0 && (
        <ul className="transfer-history" aria-label="History">
          {transfer.events.filter((event) => event.type !== "NOTIFIED").map((event) => (
            <li key={event.id}>
              {transferEventLabel(event.type)}, <TransferDate iso={event.createdAt} />
              {event.actorName && <> by <span translate="no">{event.actorName}</span></>}
              {event.note && event.type !== "REQUESTED" && <>: {event.note}</>}
            </li>
          ))}
        </ul>
      )}
      <div className="transfer-card-actions">
        {transfer.canFinish && <button className="primary-button" onClick={() => onAction({ transfer, kind: "finish" })} type="button">Finish</button>}
        {transfer.canOverride && <button className="secondary-button" onClick={() => onAction({ transfer, kind: "override" })} type="button">Override</button>}
        {transfer.canCancel && <button className="secondary-button" onClick={() => onAction({ transfer, kind: "cancel" })} type="button">Close</button>}
      </div>
    </li>
  );
}

export function ClubTransferQueue() {
  const [filter, setFilter] = useState<StaffQueueFilter>("open");
  const [transfers, setTransfers] = useState<StaffTransferRecord[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [note, setNote] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [memberChoice, setMemberChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(`${API}?filter=${encodeURIComponent(filter)}`);
      const result = await response.json().catch(() => ({})) as { transfers?: StaffTransferRecord[]; message?: string };
      if (!response.ok) throw new Error(result.message ?? "The transfer queue could not be loaded.");
      setTransfers(result.transfers ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The transfer queue could not be loaded.");
      setTransfers([]);
    }
  }, [filter]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function start(next: Action) {
    setAction(next);
    setNote("");
    setMemberChoice("");
    setActionError("");
    setCandidates(null);
    if (next.kind === "override" && next.transfer.needsMemberChoice) {
      try {
        const response = await fetch(`${API}/${encodeURIComponent(next.transfer.id)}/candidates`);
        const result = await response.json().catch(() => ({})) as { candidates?: Candidate[]; message?: string };
        if (!response.ok) throw new Error(result.message ?? "The sending club's roster could not be loaded.");
        setCandidates(result.candidates ?? []);
      } catch (caught) {
        setActionError(caught instanceof Error ? caught.message : "The sending club's roster could not be loaded.");
        setCandidates([]);
      }
    }
  }

  function close() {
    setAction(null);
    setActionError("");
  }

  async function confirm() {
    if (!action) return;
    setBusy(true);
    setActionError("");
    try {
      const body = action.kind === "override"
        ? { note, ...(action.transfer.needsMemberChoice ? { fromRosterMemberId: memberChoice } : {}) }
        : { note };
      const response = await fetch(`${API}/${encodeURIComponent(action.transfer.id)}/${action.kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as { message?: string; registrationMovesQueued?: number };
      if (!response.ok) throw new Error(result.message ?? "That didn't work. Try again.");
      const moves = result.registrationMovesQueued ?? 0;
      setNotice(action.kind === "cancel"
        ? "Closed. No one moved."
        : `Transfer completed.${moves > 0 ? ` ${moves} registration move${moves === 1 ? "" : "s"} now wait${moves === 1 ? "s" : ""} for approval below.` : ""}`);
      setAction(null);
      await load();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const needsNote = action?.kind === "override" || action?.kind === "cancel";
  const needsChoice = action?.kind === "override" && action.transfer.needsMemberChoice;
  const confirmDisabled = (needsNote && !note.trim()) || (needsChoice && !memberChoice);

  return (
    <section aria-labelledby="transfer-queue-heading" className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Clubs</p>
          <h2 id="transfer-queue-heading"><ArrowLeftRight aria-hidden="true" size={18} /> Member transfer queue</h2>
          <p>
            Requests a sending club hasn&apos;t answered in 14 days, declined requests, and requests that didn&apos;t
            match anyone. Override needs a note.
          </p>
        </div>
      </div>
      <div className="transfer-filter-row">
        <label className="filter-field transfer-filter-field">
          <Filter aria-hidden="true" size={16} />
          <span>Show</span>
          <span className="transfer-filter-select">
            <select onChange={(event) => setFilter(event.target.value as StaffQueueFilter)} value={filter}>
              {staffQueueFilters.map((value) => <option key={value} value={value}>{filterLabels[value]}</option>)}
            </select>
            <ChevronDown aria-hidden="true" size={15} />
          </span>
        </label>
      </div>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      {transfers === null ? <p className="report-empty">Loading…</p> : transfers.length === 0 ? (
        <p className="report-empty">Nothing here.</p>
      ) : (
        <ul className="transfer-list">
          {transfers.map((transfer) => <StaffTransferCard key={transfer.id} onAction={(next) => void start(next)} transfer={transfer} />)}
        </ul>
      )}
      <ConfirmDialog
        busy={busy}
        busyLabel="Working…"
        confirmDisabled={confirmDisabled}
        confirmLabel={action?.kind === "finish" ? "Finish transfer" : action?.kind === "override" ? "Override and complete" : "Close request"}
        destructive={action?.kind === "cancel"}
        error={actionError}
        onCancel={close}
        onConfirm={confirm}
        open={action !== null}
        title={action?.kind === "finish" ? "Finish this transfer?" : action?.kind === "override" ? "Override this transfer?" : "Close this request?"}
      >
        {action && (
          <div className="form-stack">
            <p>
              {action.kind === "cancel"
                ? "The request is closed and no one moves. Both clubs see it as cancelled."
                : "The member moves to the receiving club's roster and is erased from the sending club's. Their open club registrations wait for your approval, one at a time."}
            </p>
            {needsChoice && (
              <label>
                Sending club member
                <select disabled={candidates === null} onChange={(event) => setMemberChoice(event.target.value)} value={memberChoice}>
                  <option value="">{candidates === null ? "Loading…" : "Choose a member"}</option>
                  {(candidates ?? []).map((candidate) => (
                    <option key={candidate.rosterMemberId} translate="no" value={candidate.rosterMemberId}>
                      {candidate.lastName}, {candidate.firstName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              {needsNote ? "Note (required)" : "Note (optional)"}
              <textarea maxLength={500} onChange={(event) => setNote(event.target.value)} rows={3} value={note} />
              <small className="field-help">Staff only. Don&apos;t include personal details such as health or family circumstances.</small>
            </label>
          </div>
        )}
      </ConfirmDialog>
    </section>
  );
}
