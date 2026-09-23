"use client";

import { useMemo, useState } from "react";
import { BadgePercent, Banknote, CircleDollarSign, CreditCard, ReceiptText, RotateCcw, Search, WalletCards, X } from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import type { RegistrationRecord } from "@/modules/registrations/repository";
import {
  attendeeSummaryLabel,
  registrationMatchesSearch,
} from "@/modules/registrations/search";

type PaymentRecord = RegistrationRecord["payments"][number];
type AdjustmentRecord = RegistrationRecord["adjustments"][number];
type AdjustmentKind = "SCHOLARSHIP" | "DISCOUNT" | "PROMO_CODE" | "CORRECTION";

const adjustmentKindLabels: Record<AdjustmentKind, string> = {
  SCHOLARSHIP: "Scholarship",
  DISCOUNT: "Discount",
  PROMO_CODE: "Promo code",
  CORRECTION: "Correction",
};
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
  const [modal, setModal] = useState<"detail" | "payment" | "refund" | "adjust" | "reverse" | null>(initialSelected ? "detail" : null);
  const [adjustKind, setAdjustKind] = useState<AdjustmentKind>("SCHOLARSHIP");
  const [selectedAdjustment, setSelectedAdjustment] = useState<AdjustmentRecord | null>(null);
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
    const matchesSearch = registrationMatchesSearch(registration, query);
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

  /** Scholarship, discount, late promo code, or correction (#396). */
  async function saveAdjustment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    const amountCents = Math.round(Number(form.get("amount") ?? 0) * 100);
    const reason = String(form.get("reason") ?? "");
    const attendeeId = String(form.get("attendeeId") ?? "") || undefined;
    const body = adjustKind === "PROMO_CODE"
      ? { kind: adjustKind, code: String(form.get("code") ?? ""), reason, attendeeId }
      : adjustKind === "CORRECTION"
        ? { kind: adjustKind, amountCents: form.get("direction") === "RAISE" ? amountCents : -amountCents, reason, attendeeId }
        : { kind: adjustKind, amountCents, reason, attendeeId };
    try {
      const response = await fetch(`/api/events/${eventId}/registrations/${selected.id}/adjustments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to adjust the amount owed.");
      applyRegistration(result.registration);
      setModal("detail");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to adjust the amount owed."); }
    finally { setSaving(false); }
  }

  async function reverseAdjustment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !selectedAdjustment) return;
    setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/events/${eventId}/registrations/${selected.id}/adjustments/${selectedAdjustment.id}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: String(form.get("reason") ?? "") }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to reverse the adjustment.");
      applyRegistration(result.registration);
      setSelectedAdjustment(null);
      setModal("detail");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to reverse the adjustment."); }
    finally { setSaving(false); }
  }

  return (
    <section className="page-stack">
      <div className="page-intro"><div><p className="eyebrow">Financial operations</p><h2>Payments & balances</h2><p>Search by attendee or payer, record offline payments, review Square card payments, and track confirmed refunds.</p></div><div className="page-intro-actions"><a className="secondary-button" href={`/finance/square-payments?event=${eventId}`}><CreditCard aria-hidden="true" size={17} /> Unmatched Square payments</a><span className="count-badge"><WalletCards aria-hidden="true" size={17} /> {registrations.length} registrations</span></div></div>
      <section className="finance-summary" aria-label="Financial summary">
        <article className="finance-stat"><span><ReceiptText aria-hidden="true" size={18} /></span><small>Active billed</small><strong>{money(totals.billed)}</strong></article>
        <article className="finance-stat"><span><Banknote aria-hidden="true" size={18} /></span><small>Net received</small><strong>{money(totals.received)}</strong></article>
        <article className="finance-stat warning"><span><CircleDollarSign aria-hidden="true" size={18} /></span><small>Outstanding</small><strong>{money(totals.outstanding)}</strong></article>
        <article className="finance-stat muted"><span><RotateCcw aria-hidden="true" size={18} /></span><small>Refunded</small><strong>{money(totals.refunded)}</strong></article>
      </section>
      <div className="toolbar panel">
        <label className="search-field"><Search aria-hidden="true" size={18} /><span className="sr-only">Search financial records</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search attendee or payer name, email, or confirmation code" /></label>
        <label className="filter-field"><span className="sr-only">Filter financial records</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="ALL">All financial records</option><option value="ACTIVE">Active registrations</option><option value="BALANCE">Balance due</option><option value="PAID">Paid in full</option><option value="REFUNDED">Has refunds</option><option value="WAITLISTED">Waitlisted</option><option value="CANCELLED">Cancelled</option></select></label>
      </div>
      <section className="panel finance-list">
        <div className="finance-row finance-head"><span>Registration</span><span>Total</span><span>Received</span><span>Balance</span><span /></div>
        {visible.map((registration) => (
          <button className="finance-row finance-record" type="button" key={registration.id} onClick={() => openDetail(registration)}>
            <span><strong>{registration.accountHolder.firstName} {registration.accountHolder.lastName}</strong><small>{registration.confirmationCode} · {registration.status.toLowerCase()} · {registration.attendeeCount} {registration.attendeeCount === 1 ? "person" : "people"}</small>{attendeeSummaryLabel(registration) && <small className="finance-attendee-names">{attendeeSummaryLabel(registration)}</small>}</span>
            <span>{money(registration.totalAmountCents)}</span><span>{money(registration.paidCents)}</span><span className={registration.balanceCents > 0 ? "balance-due" : "paid-balance"}>{money(registration.balanceCents)}</span><span>View</span>
          </button>
        ))}
        {visible.length === 0 && <div className="empty-state"><Search aria-hidden="true" size={24} /><h3>No financial records found</h3><p>Search covers the payer, every attendee on the registration, and the confirmation code. Try another term or balance filter.</p></div>}
      </section>

      {modal && selected && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
          <section className="modal-card" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="finance-modal-title" tabIndex={-1}>
            <div className="modal-head"><div><p className="eyebrow">{selected.confirmationCode}</p><h2 id="finance-modal-title">{modal === "payment" ? "Record a payment" : modal === "refund" ? "Record a refund" : modal === "adjust" ? "Adjust amount owed" : modal === "reverse" ? "Reverse adjustment" : `${selected.accountHolder.firstName} ${selected.accountHolder.lastName}`}</h2></div><button className="icon-button" type="button" onClick={closeModal} aria-label="Close dialog"><X aria-hidden="true" size={18} /></button></div>
            {modal === "detail" ? (
              <div className="detail-stack">
                <div className="detail-grid"><span><small>Total</small><strong>{money(selected.totalAmountCents)}</strong></span><span><small>Net received</small><strong>{money(selected.paidCents)}</strong></span><span><small>Balance</small><strong>{money(selected.balanceCents)}</strong></span><span><small>Payments</small><strong>{selected.payments.length}</strong></span></div>
                <div><p className="eyebrow">Attendees on this registration</p><ul className="finance-attendee-list">{selected.attendees.map((attendee) => <li key={attendee.id}><span><strong>{attendee.firstName} {attendee.lastName}</strong><small>{attendee.attendeeType.toLowerCase()}{attendee.email ? ` · ${attendee.email}` : ""}</small></span></li>)}</ul>{selected.attendees.length === 0 && <p className="quiet-copy">No attendees are recorded on this registration.</p>}</div>
                <div><p className="eyebrow">Payment history</p>{selected.payments.map((payment) => { const available = payment.amountCents - payment.refundedCents; const squareManaged = payment.method === "CARD_REFERENCE"; return <div className="payment-history" key={payment.id}><span className="payment-icon"><Banknote aria-hidden="true" size={17} /></span><span><strong>{money(payment.amountCents)} · {squareManaged ? "Square card" : payment.method.toLowerCase()}</strong><small>{payment.receivedAt ? new Date(payment.receivedAt).toLocaleString() : "Recorded manually"}{payment.refundedCents ? ` · ${money(payment.refundedCents)} refunded` : ""}{squareManaged && available > 0 ? " · refund through Square Dashboard" : ""}</small></span>{canManage && available > 0 && !squareManaged && <button className="text-button" type="button" onClick={() => { setSelectedPayment(payment); setError(""); setModal("refund"); }}>Refund</button>}</div>; })}{selected.payments.length === 0 && <p className="quiet-copy">No payments have been recorded.</p>}</div>
                {(selected.adjustments.length > 0 || (canManage && activeFinancialStatuses.has(selected.status))) && (
                  <div>
                    <p className="eyebrow">Adjustments</p>
                    {selected.adjustments.map((adjustment) => (
                      <div className="payment-history" key={adjustment.id}>
                        <span className="payment-icon"><BadgePercent aria-hidden="true" size={17} /></span>
                        <span>
                          <strong>
                            {adjustment.amountCents < 0 ? "−" : "+"}{money(Math.abs(adjustment.amountCents))} · {adjustmentKindLabels[adjustment.kind]}
                            {adjustment.promoCode ? ` ${adjustment.promoCode}` : ""}
                            {adjustment.attendeeName ? ` · ${adjustment.attendeeName}` : ""}
                            {adjustment.reversesAdjustmentId ? " (reversal)" : adjustment.reversed ? " (reversed)" : ""}
                          </strong>
                          <small>{adjustment.reason} · {adjustment.createdBy} · {new Date(adjustment.createdAt).toLocaleDateString()}</small>
                        </span>
                        {canManage && !adjustment.reversesAdjustmentId && !adjustment.reversed && activeFinancialStatuses.has(selected.status) && (
                          <button className="text-button" type="button" onClick={() => { setSelectedAdjustment(adjustment); setError(""); setModal("reverse"); }}>Reverse</button>
                        )}
                      </div>
                    ))}
                    {selected.adjustments.length === 0 && <p className="quiet-copy">No scholarships, discounts, or corrections.</p>}
                    {canManage && activeFinancialStatuses.has(selected.status) && (
                      <button className="secondary-button full-button" type="button" onClick={() => { setError(""); setAdjustKind("SCHOLARSHIP"); setModal("adjust"); }}>
                        <BadgePercent aria-hidden="true" size={17} /> Adjust amount owed
                      </button>
                    )}
                  </div>
                )}
                {canManage && selected.balanceCents > 0 && activeFinancialStatuses.has(selected.status) && <button className="primary-button full-button" type="button" onClick={() => { setError(""); setModal("payment"); }}><Banknote aria-hidden="true" size={17} /> Record payment</button>}
                {!activeFinancialStatuses.has(selected.status) && <div className="inline-notice">This registration is {selected.status.toLowerCase()}. New payments are disabled, but existing payment and refund history remains available.</div>}
              </div>
            ) : modal === "adjust" ? (
              <form className="form-stack" onSubmit={saveAdjustment}>
                <div className="inline-notice">Current total {money(selected.totalAmountCents)} · paid {money(selected.paidCents)} · balance {money(selected.balanceCents)}</div>
                <label>Type
                  <select value={adjustKind} onChange={(event) => { setAdjustKind(event.target.value as AdjustmentKind); setError(""); }}>
                    <option value="SCHOLARSHIP">Scholarship — lowers the amount owed</option>
                    <option value="DISCOUNT">Discount — lowers the amount owed</option>
                    <option value="PROMO_CODE">Promo code — apply an event code now</option>
                    <option value="CORRECTION">Correction — fix a wrong amount either way</option>
                  </select>
                </label>
                {selected.attendees.length > 1 && (
                  <label>For
                    <select name="attendeeId" defaultValue="">
                      <option value="">{adjustKind === "PROMO_CODE" ? "Whole registration" : "Whole registration (not one person)"}</option>
                      {selected.attendees.map((attendee) => <option key={attendee.id} value={attendee.id}>{attendee.firstName} {attendee.lastName}</option>)}
                    </select>
                    {adjustKind === "PROMO_CODE" && <small className="quiet-copy">Codes are per person: pick someone to price the code on their share only. Each person can have one code.</small>}
                  </label>
                )}
                {adjustKind === "PROMO_CODE" ? (
                  <label>Promo code<input name="code" maxLength={40} required autoComplete="off" placeholder="EARLYBIRD" />
                    <small className="quiet-copy">Checked against the price and the date they registered, and counts as one use of the code.</small>
                  </label>
                ) : (
                  <>
                    {adjustKind === "CORRECTION" && (
                      <label>Direction<select name="direction" defaultValue="LOWER"><option value="LOWER">Lower the amount owed</option><option value="RAISE">Raise the amount owed</option></select></label>
                    )}
                    <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
                  </>
                )}
                <label>Reason<textarea name="reason" minLength={3} maxLength={500} rows={3} required placeholder="For example: WR26 scholarship approved by the committee" /></label>
                {error && <p className="form-error" role="alert">{error}</p>}
                <div className="form-actions"><button className="secondary-button" type="button" onClick={() => setModal("detail")}>Back</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save adjustment"}</button></div>
              </form>
            ) : modal === "reverse" ? (
              <form className="form-stack" onSubmit={reverseAdjustment}>
                <div className="inline-notice">
                  This adds an opposite line of {money(Math.abs(selectedAdjustment?.amountCents ?? 0))}. The original stays on record.
                </div>
                <label>Reason<textarea name="reason" minLength={3} maxLength={500} rows={3} required placeholder="Why is this being reversed?" /></label>
                {error && <p className="form-error" role="alert">{error}</p>}
                <div className="form-actions"><button className="secondary-button" type="button" onClick={() => setModal("detail")}>Back</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Reverse adjustment"}</button></div>
              </form>
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
