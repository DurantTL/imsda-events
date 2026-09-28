"use client";

import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { registrationMoveBlockerLabels, type RegistrationMoveBlocker } from "@/modules/club-transfers/domain";
import type { RegistrationMoveRecord } from "@/modules/club-transfers/repository";

/**
 * The registration-move approval list (#489 decision 2). Completing a
 * transfer moves no registration on its own: each of the member's open club
 * registrations waits here for staff to approve or skip. Both
 * registrations' totals are shown; approving never reprices anything. Only
 * this person's own adjustment lines go with them, and the totals show
 * exactly what that changes.
 */

const API = "/api/admin/club-transfers/registration-moves";

export function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

type Decision = { move: RegistrationMoveRecord; kind: "approve" | "skip" };

/** One move card. Hook-free so it renders on its own in tests. */
export function RegistrationMoveCard({ move, onDecide }: { move: RegistrationMoveRecord; onDecide: (decision: Decision) => void }) {
  const blocker = move.blocker as RegistrationMoveBlocker | null;
  return (
    <li className="transfer-card">
      <div className="transfer-card-head">
        <strong translate="no">{move.memberName}</strong>
        <span className={`status-chip ${move.status === "APPROVED" ? "green" : move.status === "SKIPPED" ? "neutral" : blocker ? "coral" : "gold"}`}>
          {move.status === "PENDING" ? (blocker ? "Blocked" : "Ready to approve") : move.status === "APPROVED" ? "Moved" : "Skipped"}
        </span>
      </div>
      <p translate="no">{move.eventName}</p>
      <dl className="transfer-totals">
        <div>
          <dt>From <span translate="no">{move.fromClubName}</span></dt>
          <dd>{move.fromRegistration ? `${move.fromRegistration.confirmationCode} · ${money(move.fromRegistration.totalCents)}` : "Gone"}</dd>
        </div>
        <div>
          <dt>To <span translate="no">{move.toClubName}</span></dt>
          <dd>{move.toRegistration ? `${move.toRegistration.confirmationCode} · ${money(move.toRegistration.totalCents)}` : "No registration yet"}</dd>
        </div>
        <div>
          <dt>This person&apos;s adjustment lines</dt>
          <dd>{money(move.adjustmentCents)}</dd>
        </div>
      </dl>
      {blocker && <p className="form-error">{registrationMoveBlockerLabels[blocker]}</p>}
      {move.status !== "PENDING" && move.decidedAt && (
        <p className="quiet-copy">
          {move.status === "APPROVED" ? "Approved" : "Skipped"} {new Date(move.decidedAt).toLocaleDateString("en-US", { timeZone: "America/Chicago" })}
          {move.decidedByName && <> by <span translate="no">{move.decidedByName}</span></>}{move.note && <>: {move.note}</>}
        </p>
      )}
      {move.status === "PENDING" && (
        <div className="transfer-card-actions">
          <button className="primary-button" disabled={Boolean(blocker)} onClick={() => onDecide({ move, kind: "approve" })} type="button">Approve move</button>
          <button className="secondary-button" onClick={() => onDecide({ move, kind: "skip" })} type="button">Skip</button>
        </div>
      )}
    </li>
  );
}

export function RegistrationMoveApprovals() {
  const [showDecided, setShowDecided] = useState(false);
  const [moves, setMoves] = useState<RegistrationMoveRecord[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(`${API}${showDecided ? "?status=decided" : ""}`);
      const result = await response.json().catch(() => ({})) as { moves?: RegistrationMoveRecord[]; message?: string };
      if (!response.ok) throw new Error(result.message ?? "Registration moves could not be loaded.");
      setMoves(result.moves ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Registration moves could not be loaded.");
      setMoves([]);
    }
  }, [showDecided]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function confirm() {
    if (!decision) return;
    setBusy(true);
    setActionError("");
    try {
      const body = decision.kind === "approve" ? { confirm: true, note } : { note };
      const response = await fetch(`${API}/${encodeURIComponent(decision.move.id)}/${decision.kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "That didn't work. Try again.");
      setNotice(decision.kind === "approve" ? "Moved. Adjust amounts with the registration's own tools if needed." : "Skipped. The registration stays with the old club.");
      setDecision(null);
      setNote("");
      await load();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const move = decision?.move;
  const shift = move?.adjustmentCents ?? 0;

  return (
    <section aria-labelledby="registration-moves-heading" className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Clubs</p>
          <h2 id="registration-moves-heading"><ClipboardCheck aria-hidden="true" size={18} /> Registration moves to approve</h2>
          <p>
            After a transfer, each of the member&apos;s open club registrations waits here. Approving moves the person
            and their records to the new club&apos;s registration. Nothing is repriced; adjust amounts with the
            registration&apos;s own tools.
          </p>
        </div>
      </div>
      <div className="transfer-filter-row">
        <label className="checkbox-label">
          <input checked={showDecided} onChange={(event) => setShowDecided(event.target.checked)} type="checkbox" />
          Show approved and skipped
        </label>
      </div>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      {moves === null ? <p className="report-empty">Loading…</p> : moves.length === 0 ? (
        <p className="report-empty">{showDecided ? "No decided moves yet." : "No registration moves waiting."}</p>
      ) : (
        <ul className="transfer-list">
          {moves.map((entry) => <RegistrationMoveCard key={entry.id} move={entry} onDecide={(next) => { setDecision(next); setNote(""); setActionError(""); }} />)}
        </ul>
      )}
      <ConfirmDialog
        busy={busy}
        busyLabel="Working…"
        confirmLabel={decision?.kind === "approve" ? "Approve move" : "Skip move"}
        error={actionError}
        onCancel={() => { setDecision(null); setActionError(""); }}
        onConfirm={confirm}
        open={decision !== null}
        title={decision?.kind === "approve" ? "Move this registration?" : "Skip this move?"}
      >
        {move && decision && (
          <div className="form-stack">
            {decision.kind === "approve" && move.fromRegistration && move.toRegistration ? (
              <>
                <p translate="no">
                  {move.memberName} moves from {move.fromRegistration.confirmationCode} ({move.fromClubName}) to{" "}
                  {move.toRegistration.confirmationCode} ({move.toClubName}) for {move.eventName}, with their adjustments,
                  honor class seats, capacity choices and history.
                </p>
                <dl className="transfer-totals">
                  <div><dt>{move.fromClubName} total</dt><dd>{money(move.fromRegistration.totalCents)} → {money(move.fromRegistration.totalCents - shift)}</dd></div>
                  <div><dt>{move.toClubName} total</dt><dd>{money(move.toRegistration.totalCents)} → {money(move.toRegistration.totalCents + shift)}</dd></div>
                </dl>
                <p className="quiet-copy">
                  Totals change only by this person&apos;s own adjustment lines ({money(shift)}). The priced amount is
                  not recalculated; payments stay where they were made.
                </p>
              </>
            ) : (
              <p>The registration stays with the old club. You can move the person yourself later with the registration tools.</p>
            )}
            <label>
              Note (optional)
              <textarea maxLength={500} onChange={(event) => setNote(event.target.value)} rows={2} value={note} />
            </label>
          </div>
        )}
      </ConfirmDialog>
    </section>
  );
}
