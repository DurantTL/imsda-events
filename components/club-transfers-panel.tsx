"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeftRight, Send } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import type { ClubTransferRecord } from "@/modules/club-transfers/repository";

/**
 * Club member transfers in the club portal (#489). Two pieces, both for a
 * club's director or deputy only:
 *
 * - `RequestTransferButton`, shown beside "Add to roster": the receiving
 *   director types the member's exact name, picks their current club, and
 *   gives a reason. The answer is always "Request sent".
 * - `ClubTransfersPanel`: this club's open requests both ways (accept,
 *   decline, cancel where they apply) and its transfer history.
 *
 * Nothing here ever shows another club's member details before acceptance,
 * and nothing here ever shows a birth date: the payloads carry none.
 * Every prop is a plain string or array, since these render from a Server
 * Component page.
 */

const TRANSFERS_CHANGED = "club-transfers:changed";

export type TransferClubOption = { id: string; name: string };

function transfersEndpoint(organizationId: string) {
  return `/api/attendee/clubs/${encodeURIComponent(organizationId)}/transfers`;
}

export function transferActionEndpoint(organizationId: string, transferId: string, action: "accept" | "decline" | "cancel") {
  return `${transfersEndpoint(organizationId)}/${encodeURIComponent(transferId)}/${action}`;
}

function formatDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "America/Chicago" });
}

const eventLabels: Record<string, string> = {
  REQUESTED: "Requested",
  ACCEPTED: "Accepted",
  DECLINED: "Declined; sent to conference staff",
  CANCELLED: "Cancelled",
  STAFF_FINISHED: "Finished by conference staff",
  STAFF_OVERRIDDEN: "Completed by conference staff",
  COMPLETED: "Completed",
};

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(result.message ?? "That didn't work. Try again.");
  return result;
}

export function RequestTransferButton({ organizationId, clubOptions }: { organizationId: string; clubOptions: TransferClubOption[] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ firstName: "", lastName: "", fromOrganizationId: "", reason: "" });
  const ready = Boolean(form.firstName.trim() && form.lastName.trim() && form.fromOrganizationId && form.reason.trim());

  function close() {
    setOpen(false);
    setError("");
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const result = await postJson(transfersEndpoint(organizationId), form);
      setNotice(result.message ?? "Request sent.");
      setForm({ firstName: "", lastName: "", fromOrganizationId: "", reason: "" });
      setOpen(false);
      window.dispatchEvent(new Event(TRANSFERS_CHANGED));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="secondary-button" onClick={() => { setNotice(""); setOpen(true); }} type="button">
        <ArrowLeftRight aria-hidden="true" size={16} /> Request a transfer
      </button>
      {notice && <span className="sr-only" role="status">{notice}</span>}
      <ConfirmDialog
        busy={busy}
        busyLabel="Sending…"
        confirmDisabled={!ready}
        confirmLabel="Send request"
        error={error}
        onCancel={close}
        onConfirm={submit}
        open={open}
        title="Request a transfer"
      >
        <div className="form-stack">
          <p>
            For someone already on another club&apos;s roster. Enter their name exactly as that club has it. Their
            club is asked to accept; you&apos;ll see the request as pending until it&apos;s answered, and they join
            your roster only once it is.
          </p>
          <label>
            First name
            <input autoComplete="off" maxLength={80} onChange={(event) => setForm({ ...form, firstName: event.target.value })} value={form.firstName} />
          </label>
          <label>
            Last name
            <input autoComplete="off" maxLength={80} onChange={(event) => setForm({ ...form, lastName: event.target.value })} value={form.lastName} />
          </label>
          <label>
            Current club
            <select onChange={(event) => setForm({ ...form, fromOrganizationId: event.target.value })} value={form.fromOrganizationId}>
              <option value="">Choose a club</option>
              {clubOptions.map((club) => <option key={club.id} translate="no" value={club.id}>{club.name}</option>)}
            </select>
          </label>
          <label>
            Reason
            <textarea maxLength={500} onChange={(event) => setForm({ ...form, reason: event.target.value })} rows={3} value={form.reason} />
            <small className="field-help">Both clubs and conference staff can read this. It is never emailed. Don&apos;t include personal details such as health or family circumstances.</small>
          </label>
        </div>
      </ConfirmDialog>
    </>
  );
}

type PendingAction = { transfer: ClubTransferRecord; action: "accept" | "decline" | "cancel" };

/** One transfer card. Hook-free so it renders on its own in tests. */
export function ClubTransferCard({ transfer, onAction }: { transfer: ClubTransferRecord; onAction: (action: PendingAction) => void }) {
  const incoming = transfer.direction === "INCOMING";
  const tone = transfer.status === "COMPLETED" ? "green" : transfer.status === "CANCELLED" ? "neutral" : "gold";
  return (
    <li className="transfer-card">
      <div className="transfer-card-head">
        <strong translate="no">{transfer.memberName}</strong>
        <span className={`status-chip ${tone}`}>{transfer.statusLabel}</span>
      </div>
      <p>
        {incoming ? "From " : "To "}<span translate="no">{transfer.otherClubName}</span> · requested {formatDate(transfer.initiatedAt)}
        {"acknowledgeDueAt" in transfer && transfer.status === "PENDING" && <> · answer by {formatDate(transfer.acknowledgeDueAt)}</>}
      </p>
      <p>Reason: {transfer.reason}</p>
      {transfer.events.length > 0 && (
        <ul className="transfer-history" aria-label="History">
          {transfer.events.map((event) => <li key={event.id}>{eventLabels[event.type] ?? event.type}, {formatDate(event.createdAt)}</li>)}
        </ul>
      )}
      {(transfer.canAccept || transfer.canDecline || transfer.canCancel) && (
        <div className="transfer-card-actions">
          {transfer.canAccept && <button className="primary-button" onClick={() => onAction({ transfer, action: "accept" })} type="button">Accept</button>}
          {transfer.canDecline && <button className="secondary-button" onClick={() => onAction({ transfer, action: "decline" })} type="button">Decline</button>}
          {transfer.canCancel && <button className="secondary-button" onClick={() => onAction({ transfer, action: "cancel" })} type="button">Cancel request</button>}
        </div>
      )}
    </li>
  );
}

const confirmCopy = {
  accept: {
    title: "Accept this transfer?",
    label: "Accept transfer",
    body: (transfer: ClubTransferRecord) => `${transfer.memberName} moves to ${transfer.otherClubName}'s roster. Their details are erased from your roster, and their honor history goes with them. Past attendance, reports and finances stay with your club.`,
  },
  decline: {
    title: "Decline this transfer?",
    label: "Decline",
    body: (transfer: ClubTransferRecord) => `${transfer.memberName} stays on your roster for now. Conference staff will follow up with both clubs.`,
  },
  cancel: {
    title: "Cancel this request?",
    label: "Cancel request",
    body: (transfer: ClubTransferRecord) => transfer.direction === "INCOMING"
      ? `Your request for ${transfer.memberName} from ${transfer.otherClubName} is withdrawn.`
      : `The request from ${transfer.otherClubName} for ${transfer.memberName} is withdrawn. ${transfer.memberName} stays on your roster.`,
  },
} as const;

export function ClubTransfersPanel({ organizationId }: { organizationId: string }) {
  const [data, setData] = useState<{ incoming: ClubTransferRecord[]; outgoing: ClubTransferRecord[] } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(transfersEndpoint(organizationId));
      const result = await response.json().catch(() => ({})) as { incoming?: ClubTransferRecord[]; outgoing?: ClubTransferRecord[]; message?: string };
      if (!response.ok) throw new Error(result.message ?? "Transfers could not be loaded.");
      setData({ incoming: result.incoming ?? [], outgoing: result.outgoing ?? [] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Transfers could not be loaded.");
      setData({ incoming: [], outgoing: [] });
    }
  }, [organizationId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const reload = () => {
      setNotice("Request sent. It shows below as pending until it's answered.");
      void load();
    };
    window.addEventListener(TRANSFERS_CHANGED, reload);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(TRANSFERS_CHANGED, reload);
    };
  }, [load]);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setActionError("");
    try {
      const body = pending.action === "accept" ? { confirm: true } : { confirm: true, note };
      await postJson(transferActionEndpoint(organizationId, pending.transfer.id, pending.action), body);
      setNotice(pending.action === "accept"
        ? `Accepted. ${pending.transfer.memberName} is now on ${pending.transfer.otherClubName}'s roster.`
        : pending.action === "decline" ? "Declined. Conference staff will follow up." : "Cancelled.");
      setPending(null);
      setNote("");
      await load();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const all = data ? [...data.incoming, ...data.outgoing] : [];
  const open = all.filter((transfer) => transfer.status !== "COMPLETED" && transfer.status !== "CANCELLED");
  const history = all
    .filter((transfer) => transfer.status === "COMPLETED" || transfer.status === "CANCELLED")
    .sort((a, b) => (b.resolvedAt ?? b.initiatedAt).localeCompare(a.resolvedAt ?? a.initiatedAt));
  const waitingOnUs = open.filter((transfer) => transfer.direction === "OUTGOING");
  const ourRequests = open.filter((transfer) => transfer.direction === "INCOMING");

  return (
    <section aria-labelledby="club-transfers-heading" className="public-manage-card" id="club-transfers">
      <div className="public-manage-card-heading">
        <div>
          <p className="public-registration-eyebrow">Transfers</p>
          <h2 id="club-transfers-heading"><Send aria-hidden="true" size={17} /> Member transfers</h2>
        </div>
      </div>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      {data === null ? <p className="report-empty">Loading…</p> : (
        <>
          <div className="transfer-section">
            <h3>Open requests for your members</h3>
            {waitingOnUs.length === 0
              ? <p className="quiet-copy">No other club is asking for one of your members.</p>
              : <ul className="transfer-list">{waitingOnUs.map((transfer) => <ClubTransferCard key={transfer.id} onAction={setPending} transfer={transfer} />)}</ul>}
          </div>
          <div className="transfer-section">
            <h3>Your requests</h3>
            {ourRequests.length === 0
              ? <p className="quiet-copy">No open requests. Use &quot;Request a transfer&quot; above for someone on another club&apos;s roster.</p>
              : <ul className="transfer-list">{ourRequests.map((transfer) => <ClubTransferCard key={transfer.id} onAction={setPending} transfer={transfer} />)}</ul>}
          </div>
          <div className="transfer-section">
            <h3>Transfer history</h3>
            {history.length === 0
              ? <p className="quiet-copy">No completed or cancelled transfers yet.</p>
              : <ul className="transfer-list">{history.map((transfer) => <ClubTransferCard key={transfer.id} onAction={setPending} transfer={transfer} />)}</ul>}
          </div>
        </>
      )}
      <ConfirmDialog
        busy={busy}
        busyLabel="Working…"
        confirmLabel={pending ? confirmCopy[pending.action].label : "Confirm"}
        destructive={pending?.action !== "accept"}
        error={actionError}
        onCancel={() => { setPending(null); setNote(""); setActionError(""); }}
        onConfirm={confirm}
        open={pending !== null}
        title={pending ? confirmCopy[pending.action].title : ""}
      >
        {pending && (
          <div className="form-stack">
            <p translate="no">{confirmCopy[pending.action].body(pending.transfer)}</p>
            {pending.action !== "accept" && (
              <label>
                Note for conference staff (optional)
                <textarea maxLength={500} onChange={(event) => setNote(event.target.value)} rows={2} value={note} />
                <small className="field-help">Don&apos;t include personal details such as health or family circumstances.</small>
              </label>
            )}
          </div>
        )}
      </ConfirmDialog>
    </section>
  );
}
