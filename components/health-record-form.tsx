"use client";

import { useState } from "react";
import { DateInput } from "@/components/club-form-date-input";

/**
 * The Pathfinder Health Record form (#611), used for a parent opening a
 * private link and for a director typing a paper form in. Values live only in
 * this component's state while it is open; nothing is written to storage, a
 * URL, or the console, and the server validates everything again.
 */

type Contact = { firstName: string; lastName: string; phone: string; relationship: string };
type Values = Record<string, unknown>;

type Props = {
  mode: { kind: "director"; organizationId: string; memberId: string } | { kind: "link"; token: string };
  initialValues: Values;
  consentText: { emergencyTreatment: string; activities: string; photocopy: string };
  clubName: string;
  sponsoringChurch?: string | null;
  memberName: string;
  doneHref?: string;
};

const emptyContact: Contact = { firstName: "", lastName: "", phone: "", relationship: "" };

function str(values: Values, key: string) {
  const value = values[key];
  return typeof value === "string" ? value : "";
}

function contactsFrom(values: Values): Contact[] {
  const raw = values.emergencyContacts;
  if (!Array.isArray(raw) || raw.length === 0) return [{ ...emptyContact }];
  return raw.map((item) => {
    const contact = (item ?? {}) as Record<string, unknown>;
    return {
      firstName: typeof contact.firstName === "string" ? contact.firstName : "",
      lastName: typeof contact.lastName === "string" ? contact.lastName : "",
      phone: typeof contact.phone === "string" ? contact.phone : "",
      relationship: typeof contact.relationship === "string" ? contact.relationship : "",
    };
  });
}

const textKeys = [
  "addressLine1", "addressLine2", "city", "state", "zip", "phone", "email", "lastTetanusBooster",
  "allergyDetails", "medications", "medicalRestrictions",
  "insuranceCompany", "insuranceGroupNumber", "insurancePolicyNumber", "insurancePhone",
  "guardianFirstName", "guardianLastName", "guardianAddress", "guardianPhone", "guardianEmail",
] as const;

export function HealthRecordForm({ mode, initialValues, consentText, clubName, sponsoringChurch, memberName, doneHref }: Props) {
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(textKeys.map((key) => [key, str(initialValues, key)])));
  const [hasAllergies, setHasAllergies] = useState(str(initialValues, "hasAllergies") || "NO");
  const [hasInsurance, setHasInsurance] = useState(str(initialValues, "hasInsurance") || "NO");
  const [contacts, setContacts] = useState<Contact[]>(() => contactsFrom(initialValues));
  const [consents, setConsents] = useState({ emergencyTreatment: false, activities: false, photocopy: false });
  const [signature, setSignature] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const set = (key: string, value: string) => setText((current) => ({ ...current, [key]: value }));
  const updateContact = (index: number, key: keyof Contact, value: string) =>
    setContacts((current) => current.map((contact, i) => (i === index ? { ...contact, [key]: value } : contact)));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body = {
        ...text,
        hasAllergies,
        hasInsurance,
        emergencyContacts: contacts,
        consentEmergencyTreatment: consents.emergencyTreatment,
        consentActivities: consents.activities,
        consentPhotocopy: consents.photocopy,
        signature,
      };
      const response = mode.kind === "link"
        ? await fetch(`/api/public/health-records/${encodeURIComponent(mode.token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        : await fetch(`/api/attendee/clubs/${encodeURIComponent(mode.organizationId)}/health/${encodeURIComponent(mode.memberId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) {
        setError(result.message ?? "The health record could not be saved.");
        return;
      }
      setDone(true);
      if (mode.kind === "director" && doneHref) window.location.assign(doneHref);
    } catch {
      setError("The health record could not be saved. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <div className="inline-notice success club-form-done" role="status">
        {mode.kind === "link" ? "Thank you. The health record has been received, and this link no longer works." : "Saved."}
      </div>
    );
  }

  const field = (key: string, label: string, options: { wide?: boolean; area?: boolean; date?: boolean; type?: string } = {}) => options.date ? (
    <DateInput className={options.wide ? "club-form-field-wide" : undefined} key={key} label={label} labelText={label} onChange={(value) => set(key, value)} value={text[key] ?? ""} />
  ) : (
    <label className={options.wide ? "club-form-field-wide" : undefined}>{label}
      {options.area
        ? <textarea maxLength={2000} onChange={(event) => set(key, event.target.value)} rows={3} value={text[key] ?? ""} />
        : <input autoComplete="off" onChange={(event) => set(key, event.target.value)} type={options.type ?? "text"} value={text[key] ?? ""} />}
    </label>
  );

  return (
    <form className="club-form-fill" onSubmit={(event) => void submit(event)}>
      <fieldset className="public-manage-card form-stack" disabled={saving}>
        <legend className="public-registration-eyebrow">Participant</legend>
        <p><strong translate="no">{memberName}</strong></p>
        <div className="form-grid two-column">
          {field("addressLine1", "Address line 1")}
          {field("addressLine2", "Address line 2")}
          {field("city", "City")}
          {field("state", "State")}
          {field("zip", "ZIP")}
          {field("phone", "Phone", { type: "tel" })}
          {field("email", "Email", { type: "email" })}
        </div>
      </fieldset>

      <fieldset className="public-manage-card form-stack" disabled={saving}>
        <legend className="public-registration-eyebrow">Health</legend>
        <div className="form-grid two-column">
          {field("lastTetanusBooster", "Date of last tetanus booster", { date: true })}
          <label>Does the participant have allergies?
            <select onChange={(event) => setHasAllergies(event.target.value)} value={hasAllergies}>
              <option value="NO">No</option>
              <option value="YES">Yes</option>
            </select>
          </label>
          {hasAllergies === "YES" && field("allergyDetails", "Allergies, reactions, severity and normal remedy", { wide: true, area: true })}
          {field("medications", "Medications or other relevant health information, including mental health", { wide: true, area: true })}
          {field("medicalRestrictions", "Medical restrictions", { wide: true, area: true })}
        </div>
      </fieldset>

      <fieldset className="public-manage-card form-stack" disabled={saving}>
        <legend className="public-registration-eyebrow">Insurance</legend>
        <div className="form-grid two-column">
          <label>Is the participant covered by medical insurance?
            <select onChange={(event) => setHasInsurance(event.target.value)} value={hasInsurance}>
              <option value="NO">No</option>
              <option value="YES">Yes</option>
            </select>
          </label>
          {hasInsurance === "YES" && (
            <>
              {field("insuranceCompany", "Insurance company")}
              {field("insuranceGroupNumber", "Group number")}
              {field("insurancePolicyNumber", "Policy number")}
              {field("insurancePhone", "Insurance phone", { type: "tel" })}
            </>
          )}
        </div>
      </fieldset>

      <fieldset className="public-manage-card form-stack" disabled={saving}>
        <legend className="public-registration-eyebrow">Parent or guardian</legend>
        <div className="form-grid two-column">
          {field("guardianFirstName", "First name")}
          {field("guardianLastName", "Last name")}
          {field("guardianAddress", "Address, if different", { wide: true })}
          {field("guardianPhone", "Phone", { type: "tel" })}
          {field("guardianEmail", "Email", { type: "email" })}
        </div>
      </fieldset>

      <fieldset className="public-manage-card form-stack" disabled={saving}>
        <legend className="public-registration-eyebrow">Emergency contacts and authorized persons</legend>
        {contacts.map((contact, index) => (
          <div className="form-grid two-column" key={index}>
            <label>First name<input onChange={(event) => updateContact(index, "firstName", event.target.value)} type="text" value={contact.firstName} /></label>
            <label>Last name<input onChange={(event) => updateContact(index, "lastName", event.target.value)} type="text" value={contact.lastName} /></label>
            <label>Phone<input onChange={(event) => updateContact(index, "phone", event.target.value)} type="tel" value={contact.phone} /></label>
            <label>Relationship to the minor<input onChange={(event) => updateContact(index, "relationship", event.target.value)} type="text" value={contact.relationship} /></label>
            {contacts.length > 1 && (
              <button className="secondary-button" onClick={() => setContacts((current) => current.filter((_, i) => i !== index))} type="button">Remove this contact</button>
            )}
          </div>
        ))}
        {contacts.length < 6 && (
          <button className="secondary-button" onClick={() => setContacts((current) => [...current, { ...emptyContact }])} type="button">Add another contact</button>
        )}
      </fieldset>

      <fieldset className="public-manage-card form-stack" disabled={saving}>
        <legend className="public-registration-eyebrow">Club</legend>
        <p translate="no">{clubName}{sponsoringChurch ? ` · ${sponsoringChurch}` : ""}</p>
      </fieldset>

      <fieldset className="public-manage-card form-stack" disabled={saving}>
        <legend className="public-registration-eyebrow">Consent and signature</legend>
        {([
          ["emergencyTreatment", consentText.emergencyTreatment],
          ["activities", consentText.activities],
          ["photocopy", consentText.photocopy],
        ] as const).map(([key, statement]) => (
          <label className="checkbox-label" key={key}>
            <input checked={consents[key]} onChange={(event) => setConsents((current) => ({ ...current, [key]: event.target.checked }))} type="checkbox" />
            {statement}
          </label>
        ))}
        <label>Signature (type the guardian&apos;s full name)
          <input autoComplete="off" onChange={(event) => setSignature(event.target.value)} type="text" value={signature} />
        </label>
      </fieldset>

      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <div className="intro-actions">
        <button className="primary-button" disabled={saving} type="submit">{mode.kind === "link" ? "Submit health record" : "Save health record"}</button>
      </div>
    </form>
  );
}
