import { DiscardControl, FinalizeControl, RegenerateControl, ReviseForm } from "@/components/invoice-controls";
import { StatusBadge, displayNumber, invoiceMoney, invoiceWhen } from "@/components/invoices";
import { basisLabel } from "@/modules/attendance-reconciliation/domain";
import type { InvoiceLine } from "@/modules/invoices/domain";
import type { InvoiceDetail, InvoiceVersionSummary } from "@/modules/invoices/repository";

/**
 * One invoice (#167): the shown version's snapshot (contact, lines, people, charges, credits, promo, total),
 * the version history, the receivable, and the actions that fit its state. Finalizing needs the Finalize
 * invoices permission unless the version only changes the contact; the server checks again. Nothing is sent.
 */
export function InvoiceDetailView({
  eventId,
  detail,
  canFinalize,
  viewerName,
}: {
  eventId: string;
  detail: InvoiceDetail;
  canFinalize: boolean;
  viewerName: string;
}) {
  const { shown, snapshot, versions, change } = detail;
  const isDraft = shown.status === "DRAFT";
  const contact = shown.contact;
  const finalizeAllowed = canFinalize || !detail.needsFinalizePermission;
  const stale = isDraft && detail.reconciliationFreshness !== "CURRENT" && detail.needsFinalizePermission;
  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Invoice</p>
          <h2>{shown.groupTitle}</h2>
          <p>
            <StatusBadge status={shown.status} /> {displayNumber({ number: shown.number, baseNumber: detail.invoice.baseNumber, revision: shown.revision })}
            {" "}· {invoiceMoney(shown.amountDueCents)}{shown.amountDueCents === 0 ? " (nothing owed)" : ""}
          </p>
        </div>
        <div className="page-intro-actions">
          <a className="secondary-button" href={`/finance/invoices?event=${eventId}`}>All invoices</a>
          <a className="secondary-button" href={`/finance/attendance-reconciliation?event=${eventId}&version=${shown.reconciliationVersionId}`}>Reconciliation version {shown.reconciliationVersionNumber}</a>
        </div>
      </div>

      {detail.contactChanged && (
        <section className="panel billing-settings" role="status" aria-label="Contact changed">
          <p>
            <strong>Contact changed since finalization.</strong> The finalized invoice keeps {detail.liveFinalized?.contact?.name ?? "the contact it was finalized with"}
            {detail.currentContact ? `; the billing contact is now ${detail.currentContact.name}.` : "; this group has no billing contact now."}
            {" "}Revise the contact to bring the invoice up to date; the finalized version stays readable.
          </p>
        </section>
      )}
      {detail.amountsOutOfDate && !isDraft && (
        <section className="panel billing-settings" role="status" aria-label="Amounts out of date">
          <p><strong>This invoice no longer matches the approved reconciliation.</strong> Revise it to rebuild the amounts; the finalized version stays readable.</p>
        </section>
      )}
      {stale && (
        <section className="panel billing-settings" role="status" aria-label="Reconciliation not current">
          <p><strong>This draft cannot be finalized yet.</strong> The approved reconciliation is not current (a newer one was approved, or the facts changed). Prepare and approve the reconciliation, then regenerate the draft.</p>
        </section>
      )}

      <section className="panel billing-settings" aria-label="Invoice summary">
        <div className="section-heading"><h3>Billed to</h3></div>
        <p>
          <strong>{shown.organizationName}</strong>
          <br />
          {contact ? <>{contact.name}{contact.roleLabel ? `, ${contact.roleLabel}` : ""} · {contact.email}{contact.verified ? "" : " · contact not verified"}</> : <>No billing contact on file. Add one under Billing responsibility, then regenerate the draft.</>}
          <br />
          <small>The contact as it was when this version was made{shown.status === "DRAFT" ? " (regenerate the draft to pick up changes)" : ""}.</small>
        </p>
        <p>
          <small>
            Event {snapshot.event.name} · built from reconciliation version {shown.reconciliationVersionNumber}
            {shown.createdByName ? ` · prepared by ${shown.createdByName}` : ""} {invoiceWhen(shown.createdAt)}
            {shown.regenerationCount > 0 ? ` · regenerated ${shown.regenerationCount} ${shown.regenerationCount === 1 ? "time" : "times"}` : ""}
          </small>
        </p>
        {shown.revisionReason && <p><small>Revision reason: {shown.revisionReason}</small></p>}
        {shown.finalizedAt && <p><small>Finalized {invoiceWhen(shown.finalizedAt)}{shown.finalizedByName ? ` by ${shown.finalizedByName}` : ""}.</small></p>}
        {shown.receivable && (
          <p><small>Receivable: {invoiceMoney(shown.receivable.amountCents)} · {shown.receivable.status === "OPEN" ? "open" : "superseded by a later version"}.</small></p>
        )}
        {change && (
          <p>
            <small>
              Compared with {change.previousNumber ?? "the version it revises"}: {change.amountsChanged ? `the amount changes from ${invoiceMoney(change.previousAmountCents)} to ${invoiceMoney(change.amountCents)}` : "no billable amount changes"}
              {change.contactChanged ? "; the billing contact changes" : ""}.
            </small>
          </p>
        )}
      </section>

      <section className="panel finance-list invoice-detail-lines" aria-label="Invoice lines">
        <div className="section-heading"><h3>Lines</h3></div>
        {snapshot.lines.length === 0 && <p style={{ padding: "0 17px" }}>No registrations are on this invoice.</p>}
        {snapshot.lines.map((line) => <LineBlock key={line.registrationId} line={line} />)}
        <div className="invoice-line">
          <span><strong>Total due</strong><small>{snapshot.totals.billable} billable of {snapshot.totals.registered} registered ({snapshot.totals.noShow} no-show)</small></span>
          <span />
          <span><strong>{invoiceMoney(snapshot.totals.amountDueCents)}</strong></span>
          <span />
        </div>
      </section>

      <section className="panel billing-settings invoice-actions" aria-label="Actions">
        <div className="section-heading"><h3>Actions</h3></div>
        {isDraft && (
          <>
            <RegenerateControl eventId={eventId} invoiceId={detail.invoice.id} />
            <DiscardControl eventId={eventId} invoiceId={detail.invoice.id} isRevision={shown.revision > 0} />
            {finalizeAllowed ? (
              !stale && (
                <FinalizeControl
                  amountLabel={invoiceMoney(shown.amountDueCents)}
                  eventId={eventId}
                  label={shown.groupTitle}
                  revision={shown.revision}
                  versionId={shown.id}
                  viewerName={viewerName}
                />
              )
            ) : (
              <p><small>Finalizing this version needs permission to finalize invoices, which a system administrator grants. You can regenerate the draft and review it.</small></p>
            )}
            {finalizeAllowed && shown.amountDueCents === 0 && <p><small>This invoice is for $0. It can be finalized so the group has a number and a record, but nothing is owed.</small></p>}
          </>
        )}
        {!isDraft && !detail.hasOpenDraft && detail.liveFinalized && shown.id === detail.liveFinalized.id && (
          <ReviseForm amountsOutOfDate={detail.amountsOutOfDate} contactChanged={detail.contactChanged} eventId={eventId} invoiceId={detail.invoice.id} />
        )}
        {!isDraft && detail.hasOpenDraft && <p><small>A newer version is open as a draft. <a href={`/finance/invoices/${detail.invoice.id}?event=${eventId}`}>Open it</a>.</small></p>}
      </section>

      <section className="panel finance-list" aria-label="Version history">
        <div className="section-heading"><h3>Version history</h3></div>
        {versions.map((version) => <VersionRow detailInvoiceId={detail.invoice.id} eventId={eventId} key={version.id} shownId={shown.id} version={version} baseNumber={detail.invoice.baseNumber} />)}
        {detail.discarded.map((entry) => (
          <div className="invoice-line invoice-discarded" key={entry.id}>
            <span>
              <strong>{entry.revision === 0 ? "Original draft" : `Revision ${entry.revision} draft`}</strong>
              <small>discarded{entry.discardedAt ? ` ${invoiceWhen(entry.discardedAt)}` : ""}{entry.discardedByName ? ` by ${entry.discardedByName}` : ""}</small>
            </span>
            <span><StatusBadge status="DISCARDED" /></span>
            <span>{invoiceMoney(entry.amountDueCents)}</span>
            <span />
          </div>
        ))}
      </section>
    </section>
  );
}

function VersionRow({ eventId, detailInvoiceId, version, shownId, baseNumber }: { eventId: string; detailInvoiceId: string; version: InvoiceVersionSummary; shownId: string; baseNumber: string | null }) {
  return (
    <div className="invoice-line">
      <span>
        <strong>{version.revision === 0 ? "Original" : `Revision ${version.revision}`}</strong>
        <small>
          {version.finalizedAt ? `finalized ${invoiceWhen(version.finalizedAt)}${version.finalizedByName ? ` by ${version.finalizedByName}` : ""}` : `prepared ${invoiceWhen(version.createdAt)}`}
          {version.supersededAt ? ` · replaced ${invoiceWhen(version.supersededAt)}` : ""}
        </small>
        {version.revisionReason && <small>{version.revisionReason}</small>}
      </span>
      <span><StatusBadge status={version.status} /><small>{displayNumber({ number: version.number, baseNumber, revision: version.revision })}</small></span>
      <span>{invoiceMoney(version.amountDueCents)}</span>
      <span>{shownId === version.id ? "Shown" : <a href={`/finance/invoices/${detailInvoiceId}?event=${eventId}&version=${version.id}`}>View</a>}</span>
    </div>
  );
}

function LineBlock({ line }: { line: InvoiceLine }) {
  return (
    <div className="invoice-line">
      <span>
        <strong>{line.label}</strong>
        <small>{line.confirmationCode} · {basisLabel(line.basis)} · {line.counts.billable} billable of {line.counts.registered} registered</small>
        <details>
          <summary>People ({line.people.length})</summary>
          <ul>
            {line.people.map((person) => (
              <li key={person.attendeeId}>
                {person.name} · {person.billable ? (person.amountCents === null ? "billed (prorated)" : invoiceMoney(person.amountCents)) : "not billed"}
              </li>
            ))}
          </ul>
          {line.chargesNotTiedToPerson.length > 0 && (
            <>
              <h4>Charges not tied to a person</h4>
              <ul>{line.chargesNotTiedToPerson.map((entry, index) => <li key={`${entry.label}-${index}`}>{entry.label}: {invoiceMoney(entry.amountCents)}{entry.kind === "CREDIT_AS_RECORDED" ? " (credit as recorded)" : ""}</li>)}</ul>
            </>
          )}
        </details>
      </span>
      <span>
        <small>
          {line.credits.map((credit) => `${credit.label}${credit.units !== null ? ` (${credit.units})` : ""} ${invoiceMoney(credit.amountCents)}`).join(" · ")}
          {line.promo ? `${line.credits.length > 0 ? " · " : ""}Promo ${line.promo.code} ${invoiceMoney(line.promo.amountCents)}` : ""}
          {line.adjustmentCents !== 0 ? `${line.credits.length > 0 || line.promo ? " · " : ""}Adjustments ${invoiceMoney(line.adjustmentCents)}` : ""}
        </small>
      </span>
      <span><strong>{invoiceMoney(line.amountCents)}</strong></span>
      <span />
    </div>
  );
}
