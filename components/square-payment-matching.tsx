"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CreditCard, Link2, Search, X } from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import type { RegistrationRecord } from "@/modules/registrations/repository";
import type { SquareReconciliationFinding } from "@/modules/payments/square-reconciliation";
import { registrationMatchesSearch } from "@/modules/registrations/search";

const activeStatuses = new Set(["SUBMITTED", "CONFIRMED"]);

/**
 * What each classification means to the person working the list. The wording
 * is deliberately about evidence rather than blame: most of these payments are
 * real money that simply never carried anything this system could match on.
 */
const findingCopy: Record<string, { label: string; guidance: string }> = {
  APPLICABLE: {
    label: "Ready to attach",
    guidance: "The reference names one registration and the amount settles its balance exactly.",
  },
  AMOUNT_MISMATCH: {
    label: "Amount differs",
    guidance: "The reference names one registration, but the amount is not its outstanding balance — often the card fee charged on top.",
  },
  ALREADY_SETTLED: {
    label: "Already settled",
    guidance: "The registration it names shows no balance. Check for a duplicate charge before attaching.",
  },
  NO_REGISTRATION: {
    label: "No registration named",
    guidance: "The reference is not a confirmation code in this system. Use the note to find the right registration.",
  },
  AMBIGUOUS_REGISTRATION: {
    label: "Matches more than one",
    guidance: "The code it names belongs to more than one registration. Pick the right one.",
  },
  NO_CONFIRMATION_CODE: {
    label: "Nothing to match on",
    guidance: "Neither the note nor the reference names anything. Identify it from the Square receipt.",
  },
};

function trailingName(note: string | null) {
  if (!note) return "";
  const segments = note.split(/[\u2013\u2014|]/);
  const tail = segments[segments.length - 1]?.trim() ?? "";
  return segments.length > 1 && tail.length >= 3 && tail.length <= 60 ? tail : "";
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function when(value: string | null) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Date unknown";
}

export function SquarePaymentMatching({
  eventId,
  registrations,
  findings,
  examined,
  windowDays,
  squareUnreachable,
  unavailable,
}: {
  eventId: string;
  registrations: RegistrationRecord[];
  findings: SquareReconciliationFinding[];
  examined: number;
  windowDays: number;
  squareUnreachable: boolean;
  unavailable: string | null;
}) {
  const [outstanding, setOutstanding] = useState(findings);
  const [attached, setAttached] = useState<string[]>([]);
  const [active, setActive] = useState<SquareReconciliationFinding | null>(null);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useAccessibleDialog<HTMLElement>(Boolean(active), close);

  const payable = useMemo(
    () => registrations.filter((row) => activeStatuses.has(row.status)),
    [registrations],
  );
  const candidates = useMemo(() => {
    const matching = payable.filter((row) => registrationMatchesSearch(row, query));
    return query.trim() ? matching.slice(0, 25) : matching.slice(0, 8);
  }, [payable, query]);
  const selected = payable.find((row) => row.id === chosen) ?? null;

  function open(finding: SquareReconciliationFinding) {
    setActive(finding);
    setError("");
    setChosen(finding.registrationId);
    // With no registration resolved, the note is the only evidence there is,
    // and these notes read "<item> \u2013 <attendee name>". Seeding the search
    // with the trailing segment puts the likely person on screen immediately.
    // It is only a prefilled search box, so a wrong guess costs a keystroke.
    setQuery(finding.registrationId ? "" : trailingName(finding.note));
  }

  function close() {
    if (saving) return;
    setActive(null);
    setError("");
    setChosen(null);
    setQuery("");
  }

  async function attach() {
    if (!active || !chosen) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(
        `/api/events/${eventId}/payments/square-unmatched`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerPaymentId: active.providerPaymentId,
            registrationId: chosen,
          }),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.message ?? "Unable to attach this payment.");
      }
      setOutstanding((current) => current.filter(
        (row) => row.providerPaymentId !== active.providerPaymentId,
      ));
      setAttached((current) => [
        ...current,
        `${money(result.amountCents)} attached to ${result.confirmationCode}${
          result.overpaidCents > 0
            ? ` · ${money(result.overpaidCents)} more than the balance`
            : ""
        }`,
      ]);
      setActive(null);
      setChosen(null);
      setQuery("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to attach this payment.");
    } finally {
      setSaving(false);
    }
  }

  const copy = active ? findingCopy[active.code] : null;
  const gap = active && active.balanceCents !== null
    ? active.amountCents - active.balanceCents
    : null;

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Financial operations</p>
          <h2>Unmatched Square payments</h2>
          <p>
            Completed Square payments this system never recorded. Money taken
            through an invoice, a payment link, or another registration site
            carries nothing IMSDA Events can match on, so it is attached here by
            hand. Nothing is recorded until you choose the registration.
          </p>
        </div>
        <span className="count-badge">
          <CreditCard aria-hidden="true" size={17} /> {outstanding.length} unmatched
        </span>
      </div>

      {unavailable && (
        <div className="inline-notice" role="alert">
          <strong>Square could not be reached.</strong> {unavailable}
        </div>
      )}
      {squareUnreachable && !unavailable && (
        <div className="inline-notice" role="alert">
          Square stopped responding partway through, so this list may be
          incomplete.
        </div>
      )}
      {attached.length > 0 && (
        <div className="inline-notice" role="status">
          <strong>Attached in this session</strong>
          <ul>
            {attached.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}

      <section className="panel finance-list">
        <div className="finance-row finance-head">
          <span>Square payment</span>
          <span>Amount</span>
          <span>Balance</span>
          <span>Status</span>
          <span />
        </div>
        {outstanding.map((finding) => (
          <button
            className="finance-row finance-record"
            type="button"
            key={finding.providerPaymentId}
            onClick={() => open(finding)}
          >
            <span>
              <strong>{finding.note?.trim() || "No description"}</strong>
              <small>
                {when(finding.createdAt)}
                {finding.referenceId ? ` · ref ${finding.referenceId}` : ""}
              </small>
              {finding.confirmationCode && (
                <small className="finance-attendee-names">
                  Names registration {finding.confirmationCode}
                </small>
              )}
            </span>
            <span>{money(finding.amountCents)}</span>
            <span>
              {finding.balanceCents === null ? "—" : money(finding.balanceCents)}
            </span>
            <span>{findingCopy[finding.code]?.label ?? finding.code}</span>
            <span>Match</span>
          </button>
        ))}
        {outstanding.length === 0 && (
          <div className="empty-state">
            <CreditCard aria-hidden="true" size={24} />
            <h3>Nothing is waiting to be matched</h3>
            <p>
              {examined > 0
                ? `All ${examined} completed Square payments in the last ${windowDays} days are recorded.`
                : "No completed Square payments were found in this window."}
            </p>
          </div>
        )}
      </section>

      {active && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            className="modal-card"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="square-match-title"
            tabIndex={-1}
          >
            <div className="modal-head">
              <div>
                <p className="eyebrow">{money(active.amountCents)} · {when(active.createdAt)}</p>
                <h2 id="square-match-title">Attach this Square payment</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={close}
                aria-label="Close dialog"
              >
                <X aria-hidden="true" size={18} />
              </button>
            </div>

            <div className="detail-stack">
              <div className="inline-notice">
                <strong>{copy?.label}</strong>
                <p>{copy?.guidance}</p>
              </div>
              <div className="detail-grid">
                <span><small>Square note</small><strong>{active.note?.trim() || "—"}</strong></span>
                <span><small>Reference</small><strong>{active.referenceId ?? "—"}</strong></span>
              </div>

              {selected && gap !== null && gap > 0 && (
                <div className="inline-notice" role="status">
                  <AlertTriangle aria-hidden="true" size={16} /> Square took{" "}
                  {money(gap)} more than this registration&rsquo;s balance. The
                  full {money(active.amountCents)} is recorded as received, so
                  the registration will show an overpayment until someone
                  adjusts its total.
                </div>
              )}

              <div>
                <p className="eyebrow">Attach to registration</p>
                <label className="search-field">
                  <Search aria-hidden="true" size={18} />
                  <span className="sr-only">Search registrations</span>
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search attendee or payer name, email, or confirmation code"
                  />
                </label>
                <ul className="finance-attendee-list">
                  {candidates.map((registration) => (
                    <li key={registration.id}>
                      <label>
                        <input
                          type="radio"
                          name="registration"
                          value={registration.id}
                          checked={chosen === registration.id}
                          onChange={() => setChosen(registration.id)}
                        />
                        <span>
                          <strong>
                            {registration.accountHolder.firstName}{" "}
                            {registration.accountHolder.lastName}
                          </strong>
                          <small>
                            {registration.confirmationCode} · balance{" "}
                            {money(registration.balanceCents)} of{" "}
                            {money(registration.totalAmountCents)}
                          </small>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                {candidates.length === 0 && (
                  <p className="quiet-copy">
                    No submitted or confirmed registration matches that search.
                  </p>
                )}
              </div>

              {error && <p className="form-error" role="alert">{error}</p>}
              <div className="form-actions">
                <button className="secondary-button" type="button" onClick={close}>
                  Cancel
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={attach}
                  disabled={saving || !chosen}
                >
                  <Link2 aria-hidden="true" size={17} />{" "}
                  {saving ? "Attaching…" : "Attach payment"}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      <p className="quiet-copy">
        Reviewing the last {windowDays} days · {examined} completed Square
        payments examined ·{" "}
        <Link href={`/finance?event=${eventId}`}>Back to finance</Link>
      </p>
    </section>
  );
}
