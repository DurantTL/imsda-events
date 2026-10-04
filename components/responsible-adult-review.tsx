"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Download } from "lucide-react";
import { reviewKindLabels, type ReviewKind } from "@/modules/guardian-authority/domain";
import type { GuardianReview, GuardianReviewItem } from "@/modules/guardian-authority/repository";

/**
 * The responsible-adult review (#131). Lists the minors staff need to look at and every minor's current
 * responsible adult. Staff can set, change or revoke it with a reason and close a conflicting claim. Every action
 * posts to one endpoint that checks MANAGE_REGISTRATION for the event again; hiding a control is never the protection.
 */

async function postAction(eventId: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/guardian-authority`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.message === "string" ? result.message : "The change could not be saved.");
}

const kindOrder: ReviewKind[] = ["CONFLICT", "NO_ADULT_ON_REGISTRATION", "NONE_OF_US", "ADULT_LEFT_REGISTRATION", "UNKNOWN_AGE", "NOT_DECLARED"];

function ItemActions({ eventId, item, adults, canEdit }: { eventId: string; item: GuardianReviewItem; adults: GuardianReview["adults"]; canEdit: boolean }) {
  const router = useRouter();
  const [adultPersonId, setAdultPersonId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!canEdit) return null;

  async function run(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await postAction(eventId, body);
      setReason("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  // Adults on the minor's own registration first, then everyone else registered for the event.
  const sameRegistration = adults.filter((adult) => adult.confirmationCode === item.confirmationCode);
  const others = adults.filter((adult) => adult.confirmationCode !== item.confirmationCode);
  const idBase = `guardian_${item.attendeeId}`;
  return (
    <div className="guardian-review-actions">
      <label htmlFor={`${idBase}_adult`}>Responsible adult</label>
      <select id={`${idBase}_adult`} value={adultPersonId} onChange={(event) => setAdultPersonId(event.target.value)}>
        <option value="">Choose an adult…</option>
        {sameRegistration.length > 0 && (
          <optgroup label="On this registration">
            {sameRegistration.map((adult) => <option key={adult.personId} value={adult.personId}>{adult.name}</option>)}
          </optgroup>
        )}
        {others.length > 0 && (
          <optgroup label="Elsewhere on this event">
            {others.map((adult) => <option key={adult.personId} value={adult.personId}>{adult.name} ({adult.confirmationCode})</option>)}
          </optgroup>
        )}
      </select>
      <label htmlFor={`${idBase}_reason`}>Reason</label>
      <input id={`${idBase}_reason`} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
      <span className="billing-inline-action">
        <button className="primary-button" type="button" disabled={busy || !adultPersonId || !reason.trim()} onClick={() => void run({ action: "set", attendeeId: item.attendeeId, adultPersonId, reason })}>
          {item.responsibleAdult ? "Change adult" : "Set adult"}
        </button>
        {item.responsibleAdult && (
          <button className="secondary-button" type="button" disabled={busy || !reason.trim()} onClick={() => void run({ action: "revoke", attendeeId: item.attendeeId, reason })}>
            Revoke
          </button>
        )}
      </span>
      {item.conflicts.map((conflict) => (
        <button key={conflict.id} className="text-button" type="button" disabled={busy || !reason.trim()} onClick={() => void run({ action: "dismiss", conflictId: conflict.id, reason })}>
          Keep current adult and close the claim by {conflict.claimedAdultName}
        </button>
      ))}
      {error && <small className="form-error" role="alert">{error}</small>}
    </div>
  );
}

export function ResponsibleAdultReview({ eventId, review, canEdit, canExport }: { eventId: string; review: GuardianReview; canEdit: boolean; canExport: boolean }) {
  const needing = [...review.items].sort((left, right) => (
    Math.min(...left.kinds.map((kind) => kindOrder.indexOf(kind))) - Math.min(...right.kinds.map((kind) => kindOrder.indexOf(kind)))
  ));
  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Registration hub</p>
          <h2 className="duplicate-page-title">Responsible adults</h2>
          <p>
            A minor is a person under {review.event.ageOfMajority} on the event’s first day ({review.event.startDate}). The
            responsible adult is whoever the registrant chose on the form, or whoever staff set here. Nothing is guessed from
            a household, surname, email or the account holder, and this gives no access to health or other registration records.
          </p>
        </div>
        {canExport && (
          <div className="intro-actions">
            <a className="secondary-button" href={`/api/events/${encodeURIComponent(eventId)}/exports/responsible-adults`}><Download aria-hidden="true" size={16} /> Export CSV</a>
          </div>
        )}
      </div>

      <section className="panel" aria-labelledby="guardian_needs_review">
        <h3 id="guardian_needs_review">Needs review ({needing.length})</h3>
        <ul className="quiet-copy">
          {kindOrder.map((kind) => <li key={kind}>{reviewKindLabels[kind]}: {review.counts[kind]}</li>)}
        </ul>
        {needing.length === 0 ? <p>Every minor has a responsible adult on record.</p> : (
          <table className="guardian-review-table">
            <thead><tr><th>Minor</th><th>Registration</th><th>Why</th><th>Responsible adult</th>{canEdit && <th>Change</th>}</tr></thead>
            <tbody>
              {needing.map((item) => (
                <tr key={item.attendeeId}>
                  <td><span translate="no">{item.name}</span>{item.age !== null && <small> · age {item.age}</small>}</td>
                  <td><a href={`/people?event=${encodeURIComponent(eventId)}&registration=${encodeURIComponent(item.registrationId)}`}>{item.confirmationCode}</a></td>
                  <td>
                    <ul>
                      {item.kinds.map((kind) => <li key={kind}>{reviewKindLabels[kind]}</li>)}
                      {item.conflicts.map((conflict) => (
                        <li key={conflict.id}><span translate="no">{conflict.claimedAdultName}</span> ({conflict.claimingConfirmationCode}) also claims this minor</li>
                      ))}
                    </ul>
                  </td>
                  <td>{item.responsibleAdult ? <span translate="no">{item.responsibleAdult.name}</span> : item.noneOfUs ? "None of us" : "Not recorded"}</td>
                  {canEdit && <td><ItemActions eventId={eventId} item={item} adults={review.adults} canEdit={canEdit} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel" aria-labelledby="guardian_all_minors">
        <h3 id="guardian_all_minors">All minors ({review.minors.length})</h3>
        {review.minors.length === 0 ? <p>No minors are registered for this event.</p> : (
          <table className="guardian-review-table">
            <thead><tr><th>Minor</th><th>Registration</th><th>Responsible adult</th><th>Set by</th></tr></thead>
            <tbody>
              {review.minors.map((minor) => (
                <tr key={minor.attendeeId}>
                  <td><span translate="no">{minor.name}</span>{minor.age !== null && <small> · age {minor.age}</small>}</td>
                  <td>{minor.confirmationCode}</td>
                  <td>{minor.status === "UNKNOWN" ? "Age unknown" : minor.responsibleAdult ? <span translate="no">{minor.responsibleAdult.name}</span> : minor.noneOfUs ? "None of us" : "Not recorded"}</td>
                  <td>{minor.responsibleAdult ? (minor.responsibleAdult.source === "STAFF" ? "Staff" : "Registration form") : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}
