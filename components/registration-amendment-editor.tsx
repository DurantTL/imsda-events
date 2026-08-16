"use client";

import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Plus,
  Trash2,
} from "lucide-react";
import {
  isFieldVisible,
  registrationFormDefinitionSchema,
  type RegistrationFormField,
} from "@/modules/forms/definition";
import { withAttendeeTypeOptionsForAttendee } from "@/modules/attendee-types/form-options";
import type { AttendeeTypeOption } from "@/modules/attendee-types/domain";
import type { RegistrationRecord } from "@/modules/registrations/repository";

type Responses = Record<string, unknown>;
type DraftAttendee = {
  attendeeId: string | null;
  clientId: string;
  responses: Responses;
};
type AmendmentPreview = {
  quoteFingerprint: string;
  previousTotalCents: number;
  totalCents: number;
  deltaCents: number;
  paidCents: number;
  balanceCents: number;
  previousAttendeeCount: number;
  attendeeCount: number;
  addedAttendeeCount: number;
  removedAttendeeCount: number;
  lineItems: Array<{
    key: string;
    label: string;
    amountCents: number;
    pricingLabel?: string;
    attendeeIndex?: number;
    attendeeLabel?: string;
  }>;
  pricingDate: string;
};

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function valueString(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function selectedValues(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

const attendeeIdentityKeys = new Set([
  "first_name",
  "last_name",
  "full_name",
  "name",
  "attendee_name",
  "guest_name",
]);

function protectedRegistrationKeys(
  fields: RegistrationFormField[],
  paymentMethodFieldKey?: string,
) {
  const keys = new Set(["first_name", "last_name", "email", "phone", "promo_code"]);
  if (paymentMethodFieldKey) keys.add(paymentMethodFieldKey);
  fields.forEach((field) => {
    if (
      field.key.startsWith("primary_contact_")
      || field.key.startsWith("contact_first_name")
      || field.key.startsWith("contact_last_name")
      || field.key === "contact_email"
    ) {
      keys.add(field.key);
    }
  });
  return keys;
}

function labelWithRequired(field: RegistrationFormField) {
  return <>{field.label}{field.required && <span aria-hidden="true"> *</span>}</>;
}

function AmendmentField({
  field,
  values,
  locked,
  onChange,
}: {
  field: RegistrationFormField;
  values: Responses;
  locked: boolean;
  onChange: (value: unknown) => void;
}) {
  const value = values[field.key];
  const id = `amendment_${field.id}_${locked ? "locked" : "editable"}`;

  if (locked) {
    return (
      <div className="amendment-locked-field">
        <small>{field.label}</small>
        <strong>
          {Array.isArray(value)
            ? value.join(", ") || "Not provided"
            : typeof value === "boolean"
              ? value ? "Yes" : "No"
              : valueString(value) || "Not provided"}
        </strong>
      </div>
    );
  }

  if (field.type === "CHECKBOX") {
    return (
      <label className="amendment-check-field" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{labelWithRequired(field)}<small>{field.placeholder || field.helpText}</small></span>
      </label>
    );
  }

  if (field.type === "SELECT" || field.type === "RADIO") {
    return (
      <label className="amendment-field" htmlFor={id}>
        <span>{labelWithRequired(field)}</span>
        <select
          id={id}
          value={valueString(value)}
          required={field.required}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose one</option>
          {field.options.map((option) => <option value={option} key={option}>{field.optionLabels?.[option] ?? option}</option>)}
        </select>
        {field.helpText && <small>{field.helpText}</small>}
      </label>
    );
  }

  if (field.type === "MULTISELECT" || field.type === "RANKED_CHOICE") {
    const selected = selectedValues(value);
    const maximum = field.maxSelections ?? (
      field.type === "RANKED_CHOICE" ? 2 : field.options.length
    );
    return (
      <fieldset className="amendment-choice-field">
        <legend>{labelWithRequired(field)}</legend>
        <small>
          {field.type === "RANKED_CHOICE"
            ? `Choose in preference order, up to ${maximum}.`
            : `Choose up to ${maximum}.`}
        </small>
        <div>
          {field.options.map((option) => {
            const rank = selected.indexOf(option);
            return (
              <button
                className={rank >= 0 ? "is-selected" : ""}
                type="button"
                aria-pressed={rank >= 0}
                disabled={rank < 0 && selected.length >= maximum}
                key={option}
                onClick={() => onChange(
                  rank >= 0
                    ? selected.filter((choice) => choice !== option)
                    : [...selected, option],
                )}
              >
                <span>{option}</span>
                {rank >= 0 && <strong>{field.type === "RANKED_CHOICE" ? `#${rank + 1}` : "Selected"}</strong>}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  }

  if (field.type === "LONG_TEXT") {
    return (
      <label className="amendment-field" htmlFor={id}>
        <span>{labelWithRequired(field)}</span>
        <textarea
          id={id}
          rows={3}
          required={field.required}
          value={valueString(value)}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        {field.helpText && <small>{field.helpText}</small>}
      </label>
    );
  }

  return (
    <label className="amendment-field" htmlFor={id}>
      <span>{labelWithRequired(field)}</span>
      <input
        id={id}
        type={
          field.type === "EMAIL"
            ? "email"
            : field.type === "PHONE"
              ? "tel"
              : field.type === "DATE"
                ? "date"
                : field.type === "NUMBER"
                  ? "number"
                  : "text"
        }
        required={field.required}
        value={valueString(value)}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {field.helpText && <small>{field.helpText}</small>}
    </label>
  );
}

export function RegistrationAmendmentEditor({
  eventId,
  registration,
  onCancel,
  onSaved,
}: {
  eventId: string;
  registration: RegistrationRecord;
  onCancel: () => void;
  onSaved: (registration: RegistrationRecord, message: string) => void;
}) {
  const parsedDefinition = useMemo(
    () => registrationFormDefinitionSchema.safeParse(
      registration.publicSubmission?.definition,
    ),
    [registration.publicSubmission?.definition],
  );
  const definition = parsedDefinition.success ? parsedDefinition.data : null;
  const allFields = useMemo(
    () => definition?.sections.flatMap((section) => section.fields) ?? [],
    [definition],
  );
  const lockedRegistrationKeys = useMemo(
    () => protectedRegistrationKeys(
      allFields,
      definition?.payment?.paymentMethodFieldKey,
    ),
    [allFields, definition?.payment?.paymentMethodFieldKey],
  );
  const [responses, setResponses] = useState<Responses>(
    registration.publicSubmission?.responses ?? {},
  );
  const [attendees, setAttendees] = useState<DraftAttendee[]>(
    registration.attendees.map((attendee) => ({
      attendeeId: attendee.id,
      clientId: attendee.id,
      responses: { ...attendee.responses },
    })),
  );
  const [reason, setReason] = useState("");
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<AmendmentPreview | null>(null);
  const [issues, setIssues] = useState<Array<{ path?: string; message?: string }>>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  if (!definition || !registration.publicSubmission) {
    return (
      <div className="inline-notice error">
        The saved form definition cannot be opened safely for an amendment.
      </div>
    );
  }

  const registrationFields = allFields.filter((field) => (
    field.scope === "REGISTRATION"
    && field.type !== "CALCULATED"
    && isFieldVisible(field, responses)
  ));

  function invalidatePreview() {
    setPreview(null);
    setError("");
    setIssues([]);
  }

  function setRegistrationValue(key: string, value: unknown) {
    setResponses((current) => ({ ...current, [key]: value }));
    invalidatePreview();
  }

  function setAttendeeValue(index: number, key: string, value: unknown) {
    setAttendees((current) => current.map((attendee, attendeeIndex) => (
      attendeeIndex === index
        ? { ...attendee, responses: { ...attendee.responses, [key]: value } }
        : attendee
    )));
    invalidatePreview();
  }

  function addAttendee() {
    setAttendees((current) => [...current, {
      attendeeId: null,
      clientId: crypto.randomUUID(),
      responses: {},
    }]);
    invalidatePreview();
  }

  function removeAttendee(index: number) {
    if (attendees.length <= 1) return;
    const attendee = attendees[index];
    const firstName = valueString(attendee.responses.first_name);
    const lastName = valueString(attendee.responses.last_name);
    const name = `${firstName} ${lastName}`.trim() || `attendee ${index + 1}`;
    if (!window.confirm(`Remove ${name} from this registration amendment?`)) return;
    setAttendees((current) => current.filter((_, attendeeIndex) => attendeeIndex !== index));
    invalidatePreview();
  }

  function moveAttendee(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= attendees.length) return;
    setAttendees((current) => {
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
    invalidatePreview();
  }

  function payload(previewOnly: boolean, quoteFingerprint?: string) {
    return {
      clientRequestId,
      expectedUpdatedAt: registration.updatedAt,
      reason,
      responses,
      attendees,
      previewOnly,
      ...(quoteFingerprint ? { quoteFingerprint } : {}),
    };
  }

  async function reviewAmendment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setIssues([]);
    try {
      const response = await fetch(
        `/api/events/${eventId}/registrations/${registration.id}/amendment`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload(true)),
        },
      );
      const result = await response.json();
      if (!response.ok || !result.preview) {
        setIssues(Array.isArray(result.issues) ? result.issues : []);
        throw new Error(result.message ?? "Unable to review this amendment.");
      }
      setPreview(result.preview as AmendmentPreview);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to review this amendment.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmAmendment() {
    if (!preview) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(
        `/api/events/${eventId}/registrations/${registration.id}/amendment`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload(false, preview.quoteFingerprint)),
        },
      );
      const result = await response.json();
      if (!response.ok || !result.registration) {
        setPreview(null);
        setIssues(Array.isArray(result.issues) ? result.issues : []);
        throw new Error(result.message ?? "Unable to save this amendment.");
      }
      const saved = result.registration as RegistrationRecord;
      onSaved(
        saved,
        `Registration amended. ${saved.attendeeCount} attendee${saved.attendeeCount === 1 ? "" : "s"} · ${money(saved.balanceCents)} balance.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save this amendment.");
    } finally {
      setSaving(false);
    }
  }

  if (preview) {
    return (
      <div className="registration-amendment">
        <div className="operation-step-heading">
          <p className="eyebrow">Step 2 of 2 · Review and confirm</p>
          <h3>Confirm registration amendment</h3>
          <p>The original submitted form remains unchanged. This creates a new staff operation containing the before-and-after record.</p>
        </div>
        <div className="amendment-quote-grid">
          <span><small>Attendees</small><strong>{preview.previousAttendeeCount} → {preview.attendeeCount}</strong></span>
          <span><small>Previous total</small><strong>{money(preview.previousTotalCents)}</strong></span>
          <span><small>New total</small><strong>{money(preview.totalCents)}</strong></span>
          <span><small>New balance</small><strong>{money(preview.balanceCents)}</strong></span>
        </div>
        {(preview.addedAttendeeCount > 0 || preview.removedAttendeeCount > 0) && (
          <div className="inline-notice">
            {preview.addedAttendeeCount} added · {preview.removedAttendeeCount} removed
          </div>
        )}
        <section className="amendment-line-items">
          <p className="eyebrow">Resulting price</p>
          {preview.lineItems.map((item) => (
            <div key={item.key}>
              <span>{item.label}{item.attendeeLabel ? ` · ${item.attendeeLabel}` : ""}</span>
              <strong>{money(item.amountCents)}</strong>
            </div>
          ))}
          <div className="total"><span>Total</span><strong>{money(preview.totalCents)}</strong></div>
        </section>
        {reason && <p className="quiet-copy"><strong>Staff note:</strong> {reason}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button className="secondary-button" type="button" disabled={saving} onClick={() => setPreview(null)}>Back to edit</button>
          <button className="primary-button" type="button" disabled={saving} onClick={confirmAmendment}>
            <CheckCircle2 aria-hidden="true" size={17} />
            {saving ? "Committing…" : "Confirm amendment"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="registration-amendment" onSubmit={reviewAmendment}>
      <div className="operation-step-heading">
        <p className="eyebrow">Step 1 of 2 · Edit registration</p>
        <h3>Choices, details, and attendees</h3>
        <p>Contact ownership, attendee substitutions, payment method, and promo code remain in their dedicated audited workflows.</p>
      </div>
      <section className="amendment-section">
        <header><div><p className="eyebrow">Party-wide answers</p><h4>Registration details</h4></div></header>
        <div className="amendment-fields">
          {registrationFields.map((field) => (
            <AmendmentField
              field={field}
              values={responses}
              locked={lockedRegistrationKeys.has(field.key)}
              key={field.id}
              onChange={(value) => setRegistrationValue(field.key, value)}
            />
          ))}
        </div>
      </section>
      <section className="amendment-attendees">
        <div className="inline-heading">
          <div><p className="eyebrow">Attendee roster</p><h4>{attendees.length} attendee{attendees.length === 1 ? "" : "s"}</h4></div>
          <button className="text-button" type="button" disabled={attendees.length >= 50} onClick={addAttendee}>
            <Plus aria-hidden="true" size={15} /> Add person
          </button>
        </div>
        {attendees.map((attendee, attendeeIndex) => {
          const merged = { ...responses, ...attendee.responses };
          const attendeeDefinition = withAttendeeTypeOptionsForAttendee(
            definition,
            (registration.publicSubmission?.attendeeTypeOptions ?? []) as AttendeeTypeOption[],
            registration.attendees.find((candidate) => candidate.id === attendee.attendeeId)?.attendeeTypeDefinitionCode,
          );
          const visibleFields = attendeeDefinition.sections.flatMap((section) => section.fields)
            .filter((field) => field.scope === "ATTENDEE" && field.type !== "CALCULATED" && isFieldVisible(field, merged));
          const firstName = valueString(attendee.responses.first_name);
          const lastName = valueString(attendee.responses.last_name);
          return (
            <article className="amendment-attendee-card" key={attendee.clientId}>
              <header>
                <div><small>Attendee {attendeeIndex + 1}</small><h4>{`${firstName} ${lastName}`.trim() || "New attendee"}</h4></div>
                <div>
                  <button type="button" disabled={attendeeIndex === 0} aria-label="Move attendee up" onClick={() => moveAttendee(attendeeIndex, -1)}><ArrowUp aria-hidden="true" size={15} /></button>
                  <button type="button" disabled={attendeeIndex === attendees.length - 1} aria-label="Move attendee down" onClick={() => moveAttendee(attendeeIndex, 1)}><ArrowDown aria-hidden="true" size={15} /></button>
                  <button className="danger" type="button" disabled={attendees.length <= 1} aria-label="Remove attendee" onClick={() => removeAttendee(attendeeIndex)}><Trash2 aria-hidden="true" size={15} /></button>
                </div>
              </header>
              <div className="amendment-fields">
                {visibleFields.map((field) => (
                  <AmendmentField
                    field={field}
                    values={attendee.responses}
                    locked={Boolean(attendee.attendeeId && attendeeIdentityKeys.has(field.key))}
                    key={field.id}
                    onChange={(value) => setAttendeeValue(attendeeIndex, field.key, value)}
                  />
                ))}
              </div>
            </article>
          );
        })}
      </section>
      <label className="amendment-field">
        <span>Reason or staff note</span>
        <textarea rows={3} maxLength={500} value={reason} placeholder="Optional — saved with the amendment audit record" onChange={(event) => { setReason(event.target.value); invalidatePreview(); }} />
      </label>
      {issues.length > 0 && (
        <div className="form-error" role="alert">
          <strong>Review these fields:</strong>
          <ul>{issues.map((issue, index) => <li key={`${issue.path ?? "issue"}_${index}`}>{issue.message ?? "Invalid value"}</li>)}</ul>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button className="secondary-button" type="button" disabled={saving} onClick={onCancel}>Cancel</button>
        <button className="primary-button" type="submit" disabled={saving}>{saving ? "Calculating…" : "Review price and changes"}</button>
      </div>
    </form>
  );
}
