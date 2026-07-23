"use client";

import { useMemo, useState } from "react";
import {
  ArrowRightLeft,
  Ban,
  Download,
  ExternalLink,
  Filter,
  ListPlus,
  Plus,
  RotateCcw,
  Search,
  UserCheck,
  UserRoundPen,
  UsersRound,
  X,
} from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import type { RegistrationRecord } from "@/modules/registrations/repository";

type LifecycleAction = "cancel" | "reactivate" | "waitlist" | "promote";
type RegistrationOperationDraft = {
  kind: "transfer" | "substitution";
  step: "details" | "review";
  attendeeId: string | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  reason: string;
  clientRequestId: string;
};

const lifecycleCopy: Record<LifecycleAction, { eyebrow: string; title: string; detail: string; submit: string }> = {
  cancel: {
    eyebrow: "Release this registration",
    title: "Cancel registration?",
    detail: "The registration remains in your records, but its attendee and room choices stop using available capacity. Payment history and balances are preserved.",
    submit: "Cancel registration",
  },
  reactivate: {
    eyebrow: "Return to the active roster",
    title: "Reactivate registration?",
    detail: "Capacity and limited choices are checked again before this registration is restored.",
    submit: "Reactivate registration",
  },
  waitlist: {
    eyebrow: "Release reserved space",
    title: "Move to the waitlist?",
    detail: "The registration keeps its submitted information and balance, but stops reserving event and choice capacity.",
    submit: "Move to waitlist",
  },
  promote: {
    eyebrow: "Reserve available space",
    title: "Promote from the waitlist?",
    detail: "Event and choice capacity are checked before the registration joins the active roster.",
    submit: "Promote registration",
  },
};

function initials(record: RegistrationRecord) {
  return `${record.accountHolder.firstName[0] ?? ""}${record.accountHolder.lastName[0] ?? ""}`.toUpperCase();
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function answerLabel(key: string) {
  return key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function answerValue(value: unknown) {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined || value === "") return "Not provided";
  return String(value);
}

function fieldLabelsFromDefinition(definition: Record<string, unknown>) {
  const labels = new Map<string, string>();
  if (!Array.isArray(definition.sections)) return labels;
  for (const section of definition.sections) {
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    const fields = (section as Record<string, unknown>).fields;
    if (!Array.isArray(fields)) continue;
    for (const field of fields) {
      if (!field || typeof field !== "object" || Array.isArray(field)) continue;
      const record = field as Record<string, unknown>;
      if (typeof record.key === "string" && typeof record.label === "string") labels.set(record.key, record.label);
    }
  }
  return labels;
}

function pricingSnapshotSummary(snapshot: Record<string, unknown>) {
  const amount = (key: string) => (
    typeof snapshot[key] === "number"
      ? Math.max(0, Math.round(snapshot[key]))
      : 0
  );
  const discountAmountCents = amount("discountAmountCents");
  if (discountAmountCents <= 0) return null;
  const subtotalCents = amount("subtotalCents");
  return {
    promoCode: typeof snapshot.promoCode === "string"
      ? snapshot.promoCode
      : "Saved code",
    preDiscountSubtotalCents:
      typeof snapshot.preDiscountSubtotalCents === "number"
        ? amount("preDiscountSubtotalCents")
        : subtotalCents + discountAmountCents,
    discountAmountCents,
    subtotalCents,
    processingFeeCents: amount("processingFeeCents"),
    totalCents: amount("totalCents"),
  };
}

function statusTone(record: RegistrationRecord) {
  if (record.status === "CANCELLED" || record.status === "WAITLISTED") return "purple";
  if (record.balanceCents > 0) return "gold";
  return "green";
}

function statusLabel(record: RegistrationRecord) {
  if (record.status === "CANCELLED") return "Cancelled";
  if (record.status === "WAITLISTED") return "Waitlisted";
  if (record.status === "DRAFT") return "Draft";
  if (record.totalAmountCents === 0) return "No charge";
  if (record.balanceCents > 0) return "Balance due";
  return "Paid";
}

export function PeopleWorkspace({
  eventId,
  eventSlug,
  waitlistEnabled,
  initialRegistrations,
  canEdit,
  initialFilter = "ALL",
  initialRegistrationId,
}: {
  eventId: string;
  eventSlug: string;
  waitlistEnabled: boolean;
  initialRegistrations: RegistrationRecord[];
  canEdit: boolean;
  initialFilter?: string;
  initialRegistrationId?: string;
}) {
  const initialSelected = initialRegistrations.find((registration) => registration.id === initialRegistrationId) ?? null;
  const [registrations, setRegistrations] = useState(initialRegistrations);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(initialFilter);
  const [modal, setModal] = useState<"detail" | "edit" | null>(initialSelected ? "detail" : null);
  const [selected, setSelected] = useState<RegistrationRecord | null>(initialSelected);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [addingAttendee, setAddingAttendee] = useState(false);
  const [lifecycleAction, setLifecycleAction] = useState<LifecycleAction | null>(null);
  const [operationDraft, setOperationDraft] = useState<RegistrationOperationDraft | null>(null);
  const dialogRef = useAccessibleDialog<HTMLElement>(Boolean(modal), closeModal);

  const visible = useMemo(() => registrations.filter((registration) => {
    const attendeeSearch = registration.attendees.map((attendee) => `${attendee.firstName} ${attendee.lastName} ${attendee.email}`).join(" ");
    const haystack = `${registration.accountHolder.firstName} ${registration.accountHolder.lastName} ${registration.accountHolder.email} ${registration.confirmationCode} ${attendeeSearch}`.toLowerCase();
    const matchesQuery = haystack.includes(query.toLowerCase());
    const isActive = registration.status === "SUBMITTED" || registration.status === "CONFIRMED";
    const matchesFilter = filter === "ALL"
      || (filter === "BALANCE" && isActive && registration.balanceCents > 0)
      || (filter === "PAID" && isActive && registration.balanceCents === 0 && registration.totalAmountCents > 0)
      || registration.status === filter;
    return matchesQuery && matchesFilter;
  }), [registrations, query, filter]);
  const expectedPeople = registrations
    .filter((registration) => registration.status === "SUBMITTED" || registration.status === "CONFIRMED")
    .reduce((total, registration) => total + registration.attendeeCount, 0);
  const selectedFieldLabels = useMemo(
    () => fieldLabelsFromDefinition(selected?.publicSubmission?.definition ?? {}),
    [selected],
  );
  const selectedPricing = useMemo(
    () => pricingSnapshotSummary(
      selected?.publicSubmission?.pricingSnapshot ?? {},
    ),
    [selected],
  );

  function openDetail(record: RegistrationRecord) {
    setSelected(record);
    setAddingAttendee(false);
    setLifecycleAction(null);
    setOperationDraft(null);
    setError("");
    setNotice("");
    setModal("detail");
  }
  function closeModal() {
    if (!saving) {
      setModal(null);
      setAddingAttendee(false);
      setLifecycleAction(null);
      setOperationDraft(null);
      setError("");
      setNotice("");
    }
  }

  async function saveRegistration(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const payload = {
      firstName: String(form.get("firstName") ?? ""),
      lastName: String(form.get("lastName") ?? ""),
      email: String(form.get("email") ?? ""),
      phone: String(form.get("phone") ?? ""),
      attendeeType: form.has("attendeeType") ? String(form.get("attendeeType") ?? "ATTENDEE") : undefined,
    };
    if (!selected) return;

    try {
      const response = await fetch(`/api/events/${eventId}/registrations/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? result.issues?.[0]?.message ?? "Unable to save the registration.");
      const saved = result.registration as RegistrationRecord;
      setRegistrations((current) => current.map((item) => item.id === saved.id ? saved : item));
      setSelected(saved);
      setNotice("Contact details saved.");
      setModal("detail");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save the registration.");
    } finally {
      setSaving(false);
    }
  }

  async function updateLifecycle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !lifecycleAction) return;
    setSaving(true);
    setError("");
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(
        `/api/events/${eventId}/registrations/${selected.id}/lifecycle/${lifecycleAction}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: String(form.get("reason") ?? "") }),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.message ?? "Unable to update this registration.");
      }
      const updated = result.registration as RegistrationRecord;
      const promoted = (result.autoPromotedRegistration ?? null) as RegistrationRecord | null;
      setRegistrations((current) => current.map((record) => {
        if (record.id === updated.id) return updated;
        if (promoted && record.id === promoted.id) return promoted;
        return record;
      }));
      setSelected(updated);
      setLifecycleAction(null);
      const actionNotice = {
        cancel: "Registration cancelled and its reserved capacity was released.",
        reactivate: "Registration reactivated after a fresh capacity check.",
        waitlist: "Registration moved to the waitlist and its reserved capacity was released.",
        promote: "Registration promoted and its capacity is now reserved.",
      }[lifecycleAction];
      setNotice(promoted
        ? `${actionNotice} ${promoted.accountHolder.firstName} ${promoted.accountHolder.lastName} was automatically promoted from the waitlist.`
        : actionNotice);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update this registration.");
    } finally {
      setSaving(false);
    }
  }

  async function addAttendee(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/events/${eventId}/registrations/${selected.id}/attendees`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: form.get("firstName"),
          lastName: form.get("lastName"),
          email: form.get("email"),
          phone: form.get("phone"),
          attendeeType: form.get("attendeeType"),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? result.issues?.[0]?.message ?? "Unable to add the attendee.");
      const updated = result.registration as RegistrationRecord;
      setRegistrations((current) => current.map((item) => item.id === updated.id ? updated : item));
      setSelected(updated);
      setAddingAttendee(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to add the attendee.");
    } finally {
      setSaving(false);
    }
  }

  function beginTransfer() {
    setError("");
    setNotice("");
    setAddingAttendee(false);
    setLifecycleAction(null);
    setOperationDraft({
      kind: "transfer",
      step: "details",
      attendeeId: null,
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      reason: "",
      clientRequestId: "",
    });
  }

  function beginSubstitution(attendeeId: string) {
    setError("");
    setNotice("");
    setAddingAttendee(false);
    setLifecycleAction(null);
    setOperationDraft({
      kind: "substitution",
      step: "details",
      attendeeId,
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      reason: "",
      clientRequestId: "",
    });
  }

  function reviewRegistrationOperation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!operationDraft) return;
    const form = new FormData(event.currentTarget);
    setError("");
    setOperationDraft({
      ...operationDraft,
      step: "review",
      firstName: String(form.get("firstName") ?? "").trim(),
      lastName: String(form.get("lastName") ?? "").trim(),
      email: String(form.get("email") ?? "").trim().toLowerCase(),
      phone: String(form.get("phone") ?? "").trim(),
      reason: String(form.get("reason") ?? "").trim(),
    });
  }

  async function confirmRegistrationOperation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !operationDraft) return;
    const requestId = operationDraft.clientRequestId || crypto.randomUUID();
    setOperationDraft((current) => current ? {
      ...current,
      clientRequestId: requestId,
    } : current);
    setSaving(true);
    setError("");
    setNotice("");

    const endpoint = operationDraft.kind === "transfer"
      ? `/api/events/${eventId}/registrations/${selected.id}/transfer`
      : `/api/events/${eventId}/registrations/${selected.id}/attendees/${operationDraft.attendeeId}/substitution`;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId: requestId,
          firstName: operationDraft.firstName,
          lastName: operationDraft.lastName,
          email: operationDraft.email,
          phone: operationDraft.phone,
          reason: operationDraft.reason,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(
          result.message
          ?? result.issues?.[0]?.message
          ?? "Unable to complete this registration operation.",
        );
      }
      const updated = result.registration as RegistrationRecord;
      setRegistrations((current) => current.map((record) => (
        record.id === updated.id ? updated : record
      )));
      setSelected(updated);
      const operationLabel = operationDraft.kind === "transfer"
        ? "Registration transfer"
        : "Attendee substitution";
      const deliveryMode = result.operation?.deliveryMode;
      const noticeDetail = deliveryMode === "EXTERNAL_EMAIL"
        ? " Notices were handed to the configured email delivery path."
        : deliveryMode === "DISABLED"
          ? " Notices were recorded as suppressed because delivery is disabled."
          : " Notices were captured locally without contacting an email provider.";
      setNotice(`${operationLabel} completed.${noticeDetail}`);
      setOperationDraft(null);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to complete this registration operation.",
      );
    } finally {
      setSaving(false);
    }
  }

  const formRecord = modal === "edit" ? selected : null;
  const operationAttendee = operationDraft?.attendeeId
    ? selected?.attendees.find((attendee) => attendee.id === operationDraft.attendeeId) ?? null
    : null;
  const canAddAttendee = Boolean(
    canEdit
    && selected
    && !selected.publicSubmission
    && (selected.status === "SUBMITTED" || selected.status === "CONFIRMED"),
  );

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div><p className="eyebrow">Registration operations</p><h2>People & registrations</h2><p>Search account holders, review balances, and maintain registration details for this event.</p></div>
        <div className="intro-actions">
          <span className="count-badge"><UsersRound aria-hidden="true" size={17} /> {expectedPeople} expected</span>
          <a className="secondary-button" href={`/api/events/${eventId}/exports/registrations`}><Download aria-hidden="true" size={17} /> Export CSV</a>
          {canEdit && <a className="primary-button" href={`/events/${eventSlug}`} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" size={17} /> Start registration</a>}
        </div>
      </div>
      <div className="toolbar panel">
        <label className="search-field"><Search aria-hidden="true" size={18} /><span className="sr-only">Search people</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, email, or confirmation code" /></label>
        <label className="filter-field"><Filter aria-hidden="true" size={17} /><span className="sr-only">Filter registrations</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="ALL">All records</option><option value="BALANCE">Balance due</option><option value="PAID">Paid</option><option value="DRAFT">Draft</option><option value="WAITLISTED">Waitlisted</option><option value="CANCELLED">Cancelled</option></select></label>
      </div>
      <p className="result-summary">Showing {visible.length} of {registrations.length} registrations</p>
      <div className="record-grid">
        {visible.map((registration) => (
          <button className="record-card interactive-record" type="button" key={registration.id} onClick={() => openDetail(registration)}>
            <span className={`person-avatar large ${statusTone(registration)}`}>{initials(registration)}</span>
            <span className="record-copy"><strong>{registration.accountHolder.firstName} {registration.accountHolder.lastName}</strong><small>{registration.confirmationCode} · {registration.attendeeCount} {registration.attendeeCount === 1 ? "person" : "people"}</small><small>{registration.attendeeCount > 1 ? registration.attendees.slice(0, 2).map((attendee) => `${attendee.firstName} ${attendee.lastName}`).join(", ") + (registration.attendeeCount > 2 ? ` +${registration.attendeeCount - 2} more` : "") : registration.accountHolder.email || "No email on file"}</small></span>
            <span className={`status-chip ${statusTone(registration)}`}>{statusLabel(registration)}</span>
          </button>
        ))}
      </div>
      {visible.length === 0 && <div className="empty-state panel"><Search aria-hidden="true" size={24} /><h3>No matching registrations</h3><p>Try a different search or filter.</p></div>}

      {modal && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
          <section className="modal-card" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="registration-modal-title" tabIndex={-1}>
            <div className="modal-head">
              <div><p className="eyebrow">Registration</p><h2 id="registration-modal-title">{modal === "edit" ? "Edit contact details" : `${selected?.accountHolder.firstName} ${selected?.accountHolder.lastName}`}</h2></div>
              <button className="icon-button" type="button" onClick={closeModal} aria-label="Close dialog"><X aria-hidden="true" size={18} /></button>
            </div>

            {modal === "detail" && selected ? (
              <div className="detail-stack">
                {notice && <div className="inline-notice success" role="status">{notice}</div>}
                {error && <p className="form-error" role="alert">{error}</p>}
                {operationDraft ? (
                  operationDraft.step === "details" ? (
                    <form className="form-stack registration-operation" onSubmit={reviewRegistrationOperation}>
                      <div className="operation-step-heading">
                        <p className="eyebrow">Step 1 of 2 · Enter details</p>
                        <h3>{operationDraft.kind === "transfer" ? "Who should manage this registration now?" : `Who is replacing ${operationAttendee?.firstName ?? "this attendee"}?`}</h3>
                        <p>{operationDraft.kind === "transfer"
                          ? "A transfer changes the account holder and future contact destination for this same registration. It does not create a new registration."
                          : "A substitution replaces only this attendee’s identity on the existing attendee record. You will review every preserved item before confirming."}</p>
                      </div>
                      <div className="form-grid two-column">
                        <label>New first name<input name="firstName" required maxLength={80} defaultValue={operationDraft.firstName} /></label>
                        <label>New last name<input name="lastName" required maxLength={80} defaultValue={operationDraft.lastName} /></label>
                      </div>
                      <div className="form-grid two-column">
                        <label>{operationDraft.kind === "transfer" ? "New contact email" : "Replacement email (optional)"}<input name="email" type="email" required={operationDraft.kind === "transfer"} maxLength={160} defaultValue={operationDraft.email} /></label>
                        <label>New phone (optional)<input name="phone" type="tel" maxLength={40} defaultValue={operationDraft.phone} /></label>
                      </div>
                      <label>Reason or staff note<textarea name="reason" rows={3} maxLength={500} defaultValue={operationDraft.reason} placeholder="Optional — saved with the immutable operation history" /></label>
                      <div className="inline-notice">
                        {operationDraft.kind === "transfer"
                          ? "The old contact’s active private links will be revoked. A replacement private link is issued only after the transfer commits."
                          : "Checked-in attendees cannot be substituted. This attendee is currently eligible because no active check-in is recorded."}
                      </div>
                      <div className="form-actions">
                        <button className="secondary-button" type="button" onClick={() => { setOperationDraft(null); setError(""); }}>Keep as is</button>
                        <button className="primary-button" type="submit">Review changes</button>
                      </div>
                    </form>
                  ) : (
                    <form className="form-stack registration-operation" onSubmit={confirmRegistrationOperation}>
                      <div className="operation-step-heading">
                        <p className="eyebrow">Step 2 of 2 · Review and confirm</p>
                        <h3>{operationDraft.kind === "transfer" ? "Confirm registration transfer" : "Confirm attendee substitution"}</h3>
                        <p>Read both columns and the “stays the same” list. Nothing changes until you choose the final confirm button.</p>
                      </div>
                      <div className="operation-review-grid">
                        <section className="operation-review-card">
                          <small>{operationDraft.kind === "transfer" ? "Current account holder" : "Current attendee"}</small>
                          <strong>{operationDraft.kind === "transfer" ? `${selected.accountHolder.firstName} ${selected.accountHolder.lastName}` : `${operationAttendee?.firstName ?? ""} ${operationAttendee?.lastName ?? ""}`}</strong>
                          <span>{operationDraft.kind === "transfer" ? selected.accountHolder.email || "No email" : operationAttendee?.email || "No email"}</span>
                          <span>{operationDraft.kind === "transfer" ? selected.accountHolder.phone || "No phone" : operationAttendee?.phone || "No phone"}</span>
                        </section>
                        <span className="operation-review-arrow" aria-hidden="true"><ArrowRightLeft size={22} /></span>
                        <section className="operation-review-card next">
                          <small>{operationDraft.kind === "transfer" ? "New account holder" : "Replacement attendee"}</small>
                          <strong>{operationDraft.firstName} {operationDraft.lastName}</strong>
                          <span>{operationDraft.email || "No email"}</span>
                          <span>{operationDraft.phone || "No phone"}</span>
                        </section>
                      </div>
                      <section className="preservation-panel">
                        <p className="eyebrow">What changes</p>
                        <ul>
                          {operationDraft.kind === "transfer" ? (
                            <>
                              <li>The registration’s account holder and future contact destination.</li>
                              <li>Old active private management links are revoked; new access is created only after commit.</li>
                            </>
                          ) : (
                            <>
                              <li>The person and current profile identity attached to attendee {operationAttendee?.position !== undefined ? `position ${operationAttendee.position + 1}` : ""}.</li>
                              <li>Notices go to the registration contact, prior attendee, and replacement when each has a distinct valid email.</li>
                            </>
                          )}
                        </ul>
                      </section>
                      <section className="preservation-panel unchanged">
                        <p className="eyebrow">What stays exactly the same</p>
                        {operationDraft.kind === "transfer" ? (
                          <ul>
                            <li>Registration ID, confirmation code {selected.confirmationCode}, and {selected.status.toLowerCase()} status.</li>
                            <li>All {selected.attendeeCount} attendees, their positions, types, and form choices.</li>
                            <li>The immutable submitted form and order snapshot, {money(selected.totalAmountCents)} total, payments, refunds, and {money(selected.balanceCents)} balance.</li>
                            <li>Promo redemption, capacity reservations, and waitlist position.</li>
                          </ul>
                        ) : (
                          <ul>
                            <li>Attendee ID, position, {operationAttendee?.attendeeType.toLowerCase()} type, submitted answers, and capacity reservations.</li>
                            <li>Pricing and the immutable original form/order snapshot.</li>
                            <li>Registration contact, confirmation code {selected.confirmationCode}, status, total, payments, refunds, promo redemption, and waitlist position.</li>
                            <li>Every other attendee in the party.</li>
                          </ul>
                        )}
                      </section>
                      {operationDraft.reason && <p className="quiet-copy"><strong>Staff note:</strong> {operationDraft.reason}</p>}
                      <div className="form-actions">
                        <button className="secondary-button" type="button" disabled={saving} onClick={() => { setOperationDraft((current) => current ? { ...current, step: "details" } : current); setError(""); }}>Back to edit</button>
                        <button className="primary-button" type="submit" disabled={saving}>{saving ? "Committing…" : operationDraft.kind === "transfer" ? "Confirm transfer" : "Confirm substitution"}</button>
                      </div>
                    </form>
                  )
                ) : (
                  <>
                <div className="detail-grid"><span><small>Confirmation</small><strong>{selected.confirmationCode}</strong></span><span><small>Status</small><strong>{selected.status.toLowerCase()}</strong></span><span><small>Total</small><strong>{money(selected.totalAmountCents)}</strong></span><span><small>Balance</small><strong>{money(selected.balanceCents)}</strong></span></div>
                <div className="contact-card"><strong>Contact</strong><p>{selected.accountHolder.email || "No email"}</p><p>{selected.accountHolder.phone || "No phone"}</p></div>
                {selected.publicSubmission && <div className="public-submission-detail">
                  <div><span className="status-chip green">Public form</span><strong>{selected.publicSubmission.formName}</strong><small>Version {selected.publicSubmission.versionNumber} · immutable submitted snapshot</small></div>
                  {selectedPricing && <details open>
                    <summary>Saved promo discount</summary>
                    <dl>
                      <div><dt>Subtotal before discount</dt><dd>{money(selectedPricing.preDiscountSubtotalCents)}</dd></div>
                      <div><dt>Promo code</dt><dd>{selectedPricing.promoCode} · −{money(selectedPricing.discountAmountCents)}</dd></div>
                      <div><dt>Discounted subtotal</dt><dd>{money(selectedPricing.subtotalCents)}</dd></div>
                      {selectedPricing.processingFeeCents > 0 && <div><dt>Card processing</dt><dd>{money(selectedPricing.processingFeeCents)}</dd></div>}
                      <div><dt>Recorded total</dt><dd>{money(selectedPricing.totalCents)}</dd></div>
                    </dl>
                  </details>}
                  <details open={selected.publicSubmission.attendeeResponses.length > 0}>
                    <summary>Registration answers</summary>
                    <dl>{Object.entries(selected.publicSubmission.responses).map(([key, value]) => <div key={key}><dt>{selectedFieldLabels.get(key) ?? answerLabel(key)}</dt><dd>{answerValue(value)}</dd></div>)}</dl>
                  </details>
                </div>}
                <div className="registration-attendee-list">
                  <div className="inline-heading"><p className="eyebrow">Attendees</p>{canAddAttendee && !addingAttendee && <button className="text-button" type="button" onClick={() => { setError(""); setAddingAttendee(true); }}><Plus aria-hidden="true" size={14} /> Add attendee</button>}</div>
                  {selected.attendees.map((attendee, attendeeIndex) => <article className="attendee-detail-card" key={attendee.id}>
                    <div className="attendee-summary">
                      <span>{attendee.firstName} {attendee.lastName}<small>{attendee.attendeeType.toLowerCase()} · {attendee.source === "PUBLIC_REGISTRATION" ? "Submitted on public form" : "Added by staff"}</small></span>
                      <span className="attendee-operation-actions">
                        <span className={`status-chip ${attendee.checkedIn ? "green" : "purple"}`}>{attendee.checkedIn ? "Checked in" : "Expected"}</span>
                        {canEdit && !attendee.checkedIn && <button className="text-button" type="button" onClick={() => beginSubstitution(attendee.id)}><ArrowRightLeft aria-hidden="true" size={14} /> Substitute</button>}
                      </span>
                    </div>
                    {canEdit && attendee.checkedIn && <p className="quiet-copy">Undo this attendee’s active check-in before a substitution can be reviewed.</p>}
                    {(attendee.email || attendee.phone || Object.keys(attendee.responses).length > 0) && <details>
                      <summary>View {attendee.source === "PUBLIC_REGISTRATION" ? "submitted" : "attendee"} details</summary>
                      <dl>
                        {attendee.email && <div><dt>Email</dt><dd>{attendee.email}</dd></div>}
                        {attendee.phone && <div><dt>Phone</dt><dd>{attendee.phone}</dd></div>}
                        {Object.entries(attendee.responses).map(([key, value]) => <div key={`${attendeeIndex}_${key}`}><dt>{selectedFieldLabels.get(key) ?? answerLabel(key)}</dt><dd>{answerValue(value)}</dd></div>)}
                      </dl>
                    </details>}
                  </article>)}
                </div>
                {selected.publicSubmission && <p className="quiet-copy">This registration came through a published form. Submitted attendees, choices, and pricing stay together as one auditable snapshot.</p>}
                {addingAttendee && <form className="form-stack inset-form" onSubmit={addAttendee}><div className="form-grid two-column"><label>First name<input name="firstName" required /></label><label>Last name<input name="lastName" required /></label></div><div className="form-grid two-column"><label>Email<input name="email" type="email" /></label><label>Phone<input name="phone" type="tel" /></label></div><label>Attendee type<select name="attendeeType" defaultValue="ATTENDEE"><option value="ATTENDEE">Attendee</option><option value="WORKER">Event worker</option><option value="CHILD">Child</option></select></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions"><button className="secondary-button" type="button" onClick={() => { setAddingAttendee(false); setError(""); }}>Cancel</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Adding…" : "Add attendee"}</button></div></form>}
                {canEdit && !addingAttendee && !lifecycleAction && (
                  <>
                    <div className="registration-management-actions">
                      <button className="secondary-button" type="button" onClick={() => { setError(""); setNotice(""); setModal("edit"); }}><UserRoundPen aria-hidden="true" size={17} /> Edit contact</button>
                      <button className="secondary-button" type="button" onClick={beginTransfer}><ArrowRightLeft aria-hidden="true" size={17} /> Transfer registration</button>
                      {(selected.status === "SUBMITTED" || selected.status === "CONFIRMED") && waitlistEnabled && <button className="secondary-button" type="button" onClick={() => { setError(""); setNotice(""); setLifecycleAction("waitlist"); }}><ListPlus aria-hidden="true" size={17} /> Move to waitlist</button>}
                      {selected.status === "WAITLISTED" && <button className="primary-button" type="button" onClick={() => { setError(""); setNotice(""); setLifecycleAction("promote"); }}><UserCheck aria-hidden="true" size={17} /> Promote</button>}
                      {selected.status === "CANCELLED" && <button className="primary-button" type="button" onClick={() => { setError(""); setNotice(""); setLifecycleAction("reactivate"); }}><RotateCcw aria-hidden="true" size={17} /> Reactivate</button>}
                      {selected.status !== "CANCELLED" && <button className="secondary-button lifecycle-danger" type="button" onClick={() => { setError(""); setNotice(""); setLifecycleAction("cancel"); }}><Ban aria-hidden="true" size={17} /> Cancel registration</button>}
                    </div>
                    <p className="quiet-copy">Status changes use the actions above so capacity, room limits, waitlist position, payments, and the audit history stay correct.</p>
                  </>
                )}
                {lifecycleAction && (
                  <form className="form-stack lifecycle-confirmation" onSubmit={updateLifecycle}>
                    <div><p className="eyebrow">{lifecycleCopy[lifecycleAction].eyebrow}</p><h3>{lifecycleCopy[lifecycleAction].title}</h3><p>{lifecycleCopy[lifecycleAction].detail}</p></div>
                    <label>Reason or staff note <textarea name="reason" rows={3} maxLength={500} placeholder="Optional — saved in the event audit history" /></label>
                    {error && <p className="form-error" role="alert">{error}</p>}
                    <div className="form-actions">
                      <button className="secondary-button" type="button" disabled={saving} onClick={() => { setLifecycleAction(null); setError(""); }}>Keep as is</button>
                      <button className={lifecycleAction === "cancel" ? "primary-button lifecycle-danger-button" : "primary-button"} type="submit" disabled={saving}>{saving ? "Updating…" : lifecycleCopy[lifecycleAction].submit}</button>
                    </div>
                  </form>
                )}
                  </>
                )}
              </div>
            ) : (
              <form className="form-stack" onSubmit={saveRegistration}>
                <div className="form-grid two-column"><label>First name<input name="firstName" required defaultValue={formRecord?.accountHolder.firstName} /></label><label>Last name<input name="lastName" required defaultValue={formRecord?.accountHolder.lastName} /></label></div>
                <div className="form-grid two-column"><label>Email<input name="email" type="email" defaultValue={formRecord?.accountHolder.email} /></label><label>Phone<input name="phone" type="tel" defaultValue={formRecord?.accountHolder.phone} /></label></div>
                {formRecord && !formRecord.publicSubmission && formRecord.attendeeCount === 1 && <label>Attendee type<select name="attendeeType" defaultValue={formRecord.attendeeType}><option value="ATTENDEE">Attendee</option><option value="WORKER">Event worker</option><option value="CHILD">Child</option></select></label>}
                <p className="quiet-copy">This screen updates contact details only. Use the clearly named registration actions to change status, and Finance to record payments or refunds.</p>
                {error && <p className="form-error" role="alert">{error}</p>}
                <div className="form-actions"><button className="secondary-button" type="button" onClick={() => { setError(""); setModal("detail"); }}>Back</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save contact"}</button></div>
              </form>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
