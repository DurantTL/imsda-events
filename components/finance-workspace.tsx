"use client";

import { useMemo, useState } from "react";
import { Banknote, CircleDollarSign, ReceiptText, RotateCcw, Search, WalletCards, X } from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import type { RegistrationRecord } from "@/modules/registrations/repository";

type PaymentRecord = RegistrationRecord["payments"][number];
const activeFinancialStatuses = new Set(["SUBMITTED", "CONFIRMED"]);

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function FinanceWorkspace({
  eventId,
  initialRegistrations,
  canManage,
  initialFilter = "ALL",
  initialRegistrationId,
}: {
  eventId: string;
  initialRegistrations: RegistrationRecord[];
  canManage: boolean;
  initialFilter?: string;
  initialRegistrationId?: string;
}) {
  const initialSelected = initialRegistrations.find((row) => row.id === initialRegistrationId) ?? null;
  const [registrations, setRegistrations] = useState(initialRegistrations);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(initialFilter);
  const [selected, setSelected] = useState<RegistrationRecord | null>(initialSelected);
  const [selectedPayment, setSelectedPayment] = useState<PaymentRecord | null>(null);
  const [modal, setModal] = useState<"detail" | "payment" | "refund" | null>(initialSelected ? "detail" : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useAccessibleDialog<HTMLElement>(Boolean(modal), closeModal);

  const totals = useMemo(() => registrations.reduce((summary, registration) => ({
    billed: summary.billed + (activeFinancialStatuses.has(registration.status) ? registration.totalAmountCents : 0),
    received: summary.received + registration.paidCents,
    outstanding: summary.outstanding + (activeFinancialStatuses.has(registration.status) ? registration.balanceCents : 0),
    refunded: summary.refunded + registration.payments.reduce((total, payment) => total + payment.refundedCents, 0),
  }), { billed: 0, received: 0, outstanding: 0, refunded: 0 }), [registrations]);

  const visible = useMemo(() => registrations.filter((registration) => {
    const matchesSearch = `${registration.accountHolder.firstName} ${registration.accountHolder.lastName} ${registration.confirmationCode}`.toLowerCase().includes(query.toLowerCase());
    const matchesFilter = filter === "ALL"
      || (filter === "ACTIVE" && activeFinancialStatuses.has(registration.status))
      || (filter === "BALANCE" && registration.balanceCents > 0)
      || (filter === "PAID" && registration.balanceCents === 0 && registration.totalAmountCents > 0)
      || (filter === "REFUNDED" && registration.payments.some((payment) => payment.refundedCents > 0))
      || (filter === "WAITLISTED" && registration.status === "WAITLISTED")
      || (filter === "CANCELLED" && registration.status === "CANCELLED");
    return matchesSearch && matchesFilter;
  }), [filter, query, registrations]);

  function openDetail(registration: RegistrationRecord) { setSelected(registration); setSelectedPayment(null); setError(""); setModal("detail"); }
  function closeModal() { if (!saving) { setModal(null); setError(""); } }
  function applyRegistration(registration: RegistrationRecord) {
    setRegistrations((current) => current.map((row) => row.id === registration.id ? registration : row));
    setSelected(registration);
  }

  async function recordPayment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/events/${eventId}/registrations/${selected.id}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountCents: Math.round(Number(form.get("amount") ?? 0) * 100),
          method: form.get("method"),
          reference: form.get("reference"),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? result.issues?.[0]?.message ?? "Unable to record payment.");
      applyRegistration(result.registration);
      setModal("detail");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to record payment."); }
    finally { setSaving(false); }
  }

  async function recordRefund(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedPayment) return;
    setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/events/${eventId}/payments/${selectedPayment.id}/refunds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountCents: Math.round(Number(form.get("amount") ?? 0) * 100), reason: form.get("reason") }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? result.issues?.[0]?.message ?? "Unable to record refund.");
      applyRegistration(result.registration);
      setSelectedPayment(null);
      setModal("detail");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to record refund."); }
    finally { setSaving(false); }
  }

  return (
    <section className="page-stack">
      <div className="page-intro"><div><p className="eyebrow">Financial operations</p><h2>Payments & balances</h2><p>Record offline payments, review Square card payments, and track confirmed refunds.</p></div><span className="count-badge"><WalletCards aria-hidden="true" size={17} /> {registrations.length} registrations</span></div>
      <section className="finance-summary" aria-label="Financial summary">
        <article className="finance-stat"><span><ReceiptText aria-hidden="true" size={18} /></span><small>Active billed</small><strong>{money(totals.billed)}</strong></article>
        <article className="finance-stat"><span><Banknote aria-hidden="true" size={18} /></span><small>Net received</small><strong>{money(totals.received)}</strong></article>
        <article className="finance-stat warning"><span><CircleDollarSign aria-hidden="true" size={18} /></span><small>Outstanding</small><strong>{money(totals.outstanding)}</strong></article>
        <article className="finance-stat muted"><span><RotateCcw aria-hidden="true" size={18} /></span><small>Refunded</small><strong>{money(totals.refunded)}</strong></article>
      </section>
      <div className="toolbar panel">
        <label className="search-field"><Search aria-hidden="true" size={18} /><span className="sr-only">Search financial records</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or confirmation code" /></label>
        <label className="filter-field"><span className="sr-only">Filter financial records</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="ALL">All financial records</option><option value="ACTIVE">Active registrations</option><option value="BALANCE">Balance due</option><option value="PAID">Paid in full</option><option value="REFUNDED">Has refunds</option><option value="WAITLISTED">Waitlisted</option><option value="CANCELLED">Cancelled</option></select></label>
      </div>
      <section className="panel finance-list">
        <div className="finance-row finance-head"><span>Registration</span><span>Total</span><span>Received</span><span>Balance</span><span /></div>
        {visible.map((registration) => (
          <button className="finance-row finance-record" type="button" key={registration.id} onClick={() => openDetail(registration)}>
            <span><strong>{registration.accountHolder.firstName} {registration.accountHolder.lastName}</strong><small>{registration.confirmationCode} · {registration.status.toLowerCase()} · {registration.attendeeCount} {registration.attendeeCount === 1 ? "person" : "people"}</small></span>
            <span>{money(registration.totalAmountCents)}</span><span>{money(registration.paidCents)}</span><span className={registration.balanceCents > 0 ? "balance-due" : "paid-balance"}>{money(registration.balanceCents)}</span><span>View</span>
          </button>
        ))}
        {visible.length === 0 && <div className="empty-state"><Search aria-hidden="true" size={24} /><h3>No financial records found</h3><p>Try another search or balance filter.</p></div>}
      </section>

      {modal && selected && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
          <section className="modal-card" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="finance-modal-title" tabIndex={-1}>
            <div className="modal-head"><div><p className="eyebrow">{selected.confirmationCode}</p><h2 id="finance-modal-title">{modal === "payment" ? "Record a payment" : modal === "refund" ? "Record a refund" : `${selected.accountHolder.firstName} ${selected.accountHolder.lastName}`}</h2></div><button className="icon-button" type="button" onClick={closeModal} aria-label="Close dialog"><X aria-hidden="true" size={18} /></button></div>
            {modal === "detail" ? (
              <div className="detail-stack">
                <div className="detail-grid"><span><small>Total</small><strong>{money(selected.totalAmountCents)}</strong></span><span><small>Net received</small><strong>{money(selected.paidCents)}</strong></span><span><small>Balance</small><strong>{money(selected.balanceCents)}</strong></span><span><small>Payments</small><strong>{selected.payments.length}</strong></span></div>
                <div><p className="eyebrow">Payment history</p>{selected.payments.map((payment) => { const available = payment.amountCents - payment.refundedCents; const squareManaged = payment.method === "CARD_REFERENCE"; return <div className="payment-history" key={payment.id}><span className="payment-icon"><Banknote aria-hidden="true" size={17} /></span><span><strong>{money(payment.amountCents)} · {squareManaged ? "Square card" : payment.method.toLowerCase()}</strong><small>{payment.receivedAt ? new Date(payment.receivedAt).toLocaleString() : "Recorded manually"}{payment.refundedCents ? ` · ${money(payment.refundedCents)} refunded` : ""}{squareManaged && available > 0 ? " · refund through Square Dashboard" : ""}</small></span>{canManage && available > 0 && !squareManaged && <button className="text-button" type="button" onClick={() => { setSelectedPayment(payment); setError(""); setModal("refund"); }}>Refund</button>}</div>; })}{selected.payments.length === 0 && <p className="quiet-copy">No payments have been recorded.</p>}</div>
                {canManage && selected.balanceCents > 0 && activeFinancialStatuses.has(selected.status) && <button className="primary-button full-button" type="button" onClick={() => { setError(""); setModal("payment"); }}><Banknote aria-hidden="true" size={17} /> Record payment</button>}
                {!activeFinancialStatuses.has(selected.status) && <div className="inline-notice">This registration is {selected.status.toLowerCase()}. New payments are disabled, but existing payment and refund history remains available.</div>}
              </div>
            ) : modal === "payment" ? (
              <form className="form-stack" onSubmit={recordPayment}><label>Amount<input name="amount" type="number" min="0.01" step="0.01" required defaultValue={Math.max(selected.balanceCents, 0) / 100} /></label><label>Method<select name="method" defaultValue="CHECK"><option value="CHECK">Check</option><option value="CASH">Cash</option><option value="MANUAL">Other manual payment</option></select></label><label>Reference or note<input name="reference" maxLength={120} placeholder="Check number or staff note" /></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions"><button className="secondary-button" type="button" onClick={() => setModal("detail")}>Back</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Record payment"}</button></div></form>
            ) : (
              <form className="form-stack" onSubmit={recordRefund}><div className="inline-notice">Refundable on this payment: {money((selectedPayment?.amountCents ?? 0) - (selectedPayment?.refundedCents ?? 0))}</div><label>Refund amount<input name="amount" type="number" min="0.01" max={((selectedPayment?.amountCents ?? 0) - (selectedPayment?.refundedCents ?? 0)) / 100} step="0.01" required /></label><label>Reason<textarea name="reason" minLength={3} maxLength={300} rows={4} required placeholder="Why is this refund being recorded?" /></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions"><button className="secondary-button" type="button" onClick={() => setModal("detail")}>Back</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Record refund"}</button></div></form>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
