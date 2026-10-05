"use client";

import { useState } from "react";
import { BirthDateField } from "@/components/birth-date-field";
import { RosterTypeDefinitions } from "@/components/roster-type-definitions";
import type { RosterAddReview } from "@/modules/club-forms/roster-add";
import { calendarDateInEventTimeZone } from "@/modules/events/lifecycle";
import { rosterFormFieldOrder, validateRosterForm, type RosterFormErrors } from "@/modules/club-rosters/form-validation";
import {
  attendeeTypeAgeHint,
  clubClassLevelLabels,
  clubRosterAttendeeTypeLabels,
  clubRosterGenderLabels,
  defaultRosterRole,
} from "@/modules/club-rosters/domain";
import {
  GUARDIAN_SLOTS,
  guardianFieldLabels,
  validateGuardianForm,
  type GuardianFormErrors,
} from "@/modules/club-rosters/guardians-domain";

/**
 * The "Add to roster" review screen (#721). Everything is pre-filled from the
 * form's mapped answers and editable; nothing is saved until "Add to roster"
 * (or "Link to existing member") is pressed. The birth date goes to the server
 * to be sealed, exactly as on the roster screen.
 */

type Duplicate = RosterAddReview["duplicates"][number];

export function ClubFormRosterAdd({ review, formHref }: { review: RosterAddReview; formHref: string }) {
  const { prefill } = review;
  const [fieldErrors, setFieldErrors] = useState<RosterFormErrors>({});
  const [guardianErrors, setGuardianErrors] = useState<GuardianFormErrors>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [formType, setFormType] = useState<string>(prefill.attendeeType);
  const [formBirthDate, setFormBirthDate] = useState(prefill.birthDate);
  const [duplicates, setDuplicates] = useState<Duplicate[]>(review.duplicates);
  const base = `/api/attendee/clubs/${encodeURIComponent(review.organizationId)}/forms/submissions/${encodeURIComponent(review.submissionId)}/roster`;
  const typeHint = formBirthDate
    ? attendeeTypeAgeHint(formType as keyof typeof clubRosterAttendeeTypeLabels, formBirthDate, calendarDateInEventTimeZone(new Date(), "America/Chicago"))
    : null;

  async function send(body: unknown) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({})) as { message?: string; error?: string; issues?: Array<{ key: string; message: string }> };
      if (!response.ok) {
        if (result.error === "DUPLICATE_ON_ROSTER") {
          const found = (result.issues ?? [])
            .filter((issue) => issue.key.startsWith("duplicate:"))
            .map((issue) => ({ id: issue.key.slice("duplicate:".length), firstName: issue.message, lastName: "", attendeeType: "", status: "" }));
          if (found.length > 0) setDuplicates(found);
        }
        setError(result.message ?? result.issues?.[0]?.message ?? "This could not be added to the roster.");
        return;
      }
      // Back to the form, which now reads "Added to roster".
      window.location.assign(formHref);
    } catch {
      setError("This could not be added to the roster. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const errors = validateRosterForm({
      firstName: String(form.get("firstName") ?? ""),
      lastName: String(form.get("lastName") ?? ""),
      birthDate: String(form.get("birthDate") ?? ""),
      birthDateText: String(form.get("birthDateText") ?? ""),
      gender: String(form.get("gender") ?? ""),
      editing: false,
    });
    setFieldErrors(errors);
    const guardians = Array.from({ length: GUARDIAN_SLOTS }, (_, index) => ({
      name: String(form.get(`g${index + 1}Name`) ?? "").trim(),
      relationship: String(form.get(`g${index + 1}Relationship`) ?? "").trim(),
      email: String(form.get(`g${index + 1}Email`) ?? "").trim(),
      phone: String(form.get(`g${index + 1}Phone`) ?? "").trim(),
    }));
    const guardianProblems = validateGuardianForm(guardians);
    setGuardianErrors(guardianProblems);
    const firstInvalid = rosterFormFieldOrder.find((field) => errors[field]);
    if (firstInvalid) {
      (formElement.elements.namedItem(firstInvalid === "birthDate" ? "birthDateText" : firstInvalid) as HTMLElement | null)?.focus();
      return;
    }
    const firstGuardianProblem = Object.keys(guardianProblems)[0];
    if (firstGuardianProblem) {
      (formElement.elements.namedItem(firstGuardianProblem) as HTMLElement | null)?.focus();
      return;
    }
    void send({
      action: "ADD",
      member: {
        firstName: String(form.get("firstName") ?? ""),
        lastName: String(form.get("lastName") ?? ""),
        birthDate: String(form.get("birthDate") ?? ""),
        attendeeType: String(form.get("attendeeType") ?? "YOUTH"),
        role: String(form.get("role") ?? ""),
        classLevel: String(form.get("classLevel") ?? "") || null,
        gender: String(form.get("gender") ?? "") || null,
        guardians,
      },
    });
  }

  return (
    <div className="form-stack">
      <header>
        <p className="public-registration-eyebrow">Add to roster</p>
        <h2>Review before adding</h2>
        <p className="field-help">
          Pre-filled from <span translate="no">{review.formName}</span>. Check and change anything, then confirm. Nothing is added to the roster until you do.
          Health information on the form is never copied to the roster.
        </p>
      </header>

      {duplicates.length > 0 && (
        <div className="inline-notice" role="status">
          <p>
            <strong>{review.canAdd ? "Possible duplicate." : "Already filed."}</strong> {review.canAdd ? `Someone with this name and birth date is already on the ${review.clubYear} roster. Link this form to them
            instead of adding a duplicate.` : "This form belongs to this roster member."} Nothing is merged: linking only records which member this form belongs to.
          </p>
          <ul>
            {duplicates.map((member) => (
              <li key={member.id}>
                <span translate="no">{`${member.firstName} ${member.lastName}`.trim()}</span>{" "}
                <button className="secondary-button" disabled={saving} onClick={() => void send({ action: "LINK", memberId: member.id })} type="button">
                  Link to existing member
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <div className="inline-notice error" role="alert">{error}</div>}

      {review.canAdd ? (
      <form
        className="form-stack"
        noValidate
        onInput={(event) => {
          const name = (event.target as HTMLInputElement).name;
          const field = name === "birthDateText" ? "birthDate" : name;
          setFieldErrors((current) => (field in current ? { ...current, [field]: undefined } : current));
        }}
        onSubmit={confirm}
      >
        <div className="form-grid two-column">
          <label>
            First name
            <input aria-invalid={fieldErrors.firstName ? true : undefined} autoComplete="off" defaultValue={prefill.firstName} maxLength={80} name="firstName" required />
            {fieldErrors.firstName && <span className="roster-field-error" role="alert">{fieldErrors.firstName}</span>}
          </label>
          <label>
            Last name
            <input aria-invalid={fieldErrors.lastName ? true : undefined} autoComplete="off" defaultValue={prefill.lastName} maxLength={80} name="lastName" required />
            {fieldErrors.lastName && <span className="roster-field-error" role="alert">{fieldErrors.lastName}</span>}
          </label>
          <BirthDateField defaultValue={prefill.birthDate} error={fieldErrors.birthDate} label="Birth date" name="birthDate" onParsedChange={setFormBirthDate} required />
          <label>
            Type
            <select aria-describedby="roster-add-type-hint" defaultValue={prefill.attendeeType} name="attendeeType" onChange={(event) => setFormType(event.target.value)}>
              {Object.entries(clubRosterAttendeeTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <div className="roster-type-help">
            <RosterTypeDefinitions className="field-help" />
            <p className="field-help roster-type-hint" id="roster-add-type-hint" role="status">{typeHint ?? ""}</p>
          </div>
          <label>
            Current class
            <select defaultValue={prefill.classLevel ?? ""} name="classLevel">
              <option value="">None</option>
              {Object.entries(clubClassLevelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            Role (optional)
            <input defaultValue={prefill.role} maxLength={60} name="role" placeholder={defaultRosterRole(formType)} />
          </label>
          <label>
            Gender
            <select aria-invalid={fieldErrors.gender ? true : undefined} defaultValue={prefill.gender ?? ""} name="gender" required>
              <option disabled value="">Choose one</option>
              {Object.entries(clubRosterGenderLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            {fieldErrors.gender && <span className="roster-field-error" role="alert">{fieldErrors.gender}</span>}
          </label>
        </div>

        <fieldset className="roster-guardians">
            <legend>Guardian contacts (optional)</legend>
            <p className="field-help">Up to two guardians, from the parent or guardian details on the form. Only your club&apos;s director and deputy, Area Coordinators and conference staff with sensitive-data access can see them.</p>
            {Array.from({ length: GUARDIAN_SLOTS }, (_, index) => {
              const slot = (index + 1) as 1 | 2;
              const value = prefill.guardians[index];
              return (
                <div className="roster-guardian-slot" key={slot} role="group" aria-label={`Guardian ${slot}`}>
                  <div className="form-grid two-column">
                    <label>{guardianFieldLabels.name}
                      <input autoComplete="off" defaultValue={value.name} maxLength={120} name={`g${slot}Name`} />
                    </label>
                    <label>{guardianFieldLabels.relationship}
                      <input autoComplete="off" defaultValue={value.relationship} maxLength={60} name={`g${slot}Relationship`} placeholder="e.g. Mother" />
                    </label>
                    <label>{guardianFieldLabels.email}
                      <input aria-invalid={guardianErrors[`g${slot}Email`] ? true : undefined} autoComplete="off" defaultValue={value.email} inputMode="email" maxLength={254} name={`g${slot}Email`} type="text" />
                      {guardianErrors[`g${slot}Email`] && <span className="roster-field-error" role="alert">{guardianErrors[`g${slot}Email`]}</span>}
                    </label>
                    <label>{guardianFieldLabels.phone}
                      <input aria-invalid={guardianErrors[`g${slot}Phone`] ? true : undefined} autoComplete="off" defaultValue={value.phone} inputMode="tel" maxLength={40} name={`g${slot}Phone`} type="text" />
                      {guardianErrors[`g${slot}Phone`] && <span className="roster-field-error" role="alert">{guardianErrors[`g${slot}Phone`]}</span>}
                    </label>
                  </div>
                </div>
              );
            })}
        </fieldset>

        <div className="intro-actions">
          <button className="primary-button" disabled={saving} type="submit">Add to roster</button>
          <a className="text-button" href={formHref}>Cancel</a>
        </div>
      </form>
      ) : (
        <p className="field-help">This form is already filed against a roster member, so it can only be linked to them. No new person is added.</p>
      )}
    </div>
  );
}
