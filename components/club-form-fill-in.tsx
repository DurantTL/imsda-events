"use client";

import { useMemo, useState } from "react";
import { clubFormIsDirty, clubFormUnsavedMessage, rankLabel, rankedMaximum, toggleRankedChoice } from "@/components/club-form-state";
import { useUnsavedChangesGuard } from "@/components/use-unsaved-changes-guard";
import { LockKeyhole } from "lucide-react";
import { addressComponentKeys, addressComponentLabels } from "@/modules/forms/address";
import {
  dateFieldBounds,
  isFieldRequired,
  isFieldVisible,
  type RegistrationFormDefinition,
  type RegistrationFormField,
} from "@/modules/forms/definition";

type Answers = Record<string, unknown>;

type Props = {
  definition: RegistrationFormDefinition;
  sectionNotes: Record<string, string[]>;
  sensitiveFieldKeys: string[];
  initialAnswers?: Answers;
} & (
  | {
    mode: "club";
    organizationId: string;
    templateKey: string;
    submissionId?: string;
    rosterMembers: Array<{ id: string; name: string }>;
    /** Whether this form is filled in for a roster member (a picker) or for no one (a typed label). */
    initialRosterMemberId?: string | null;
    initialSubjectName?: string;
    doneHref: string;
  }
  | { mode: "link"; token: string }
);

type Issue = { key?: string; message: string };

function textOf(value: unknown) {
  return typeof value === "string" ? value : "";
}

/**
 * Fills in one club form from its definition (#610), for a director filling
 * it in for a member or for the person who opened a private link. The
 * definition's own rules decide what shows and what is required; the server
 * checks everything again.
 */
export function ClubFormFillIn(props: Props) {
  const { definition, sectionNotes, sensitiveFieldKeys } = props;
  const [answers, setAnswers] = useState<Answers>(props.initialAnswers ?? {});
  const [rosterMemberId, setRosterMemberId] = useState(props.mode === "club" ? props.initialRosterMemberId ?? "" : "");
  const [subjectName, setSubjectName] = useState(props.mode === "club" ? props.initialSubjectName ?? "" : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [notice, setNotice] = useState("");
  const [doneMessage, setDoneMessage] = useState("");
  const [savedId, setSavedId] = useState(props.mode === "club" ? props.submissionId : undefined);
  const sensitive = useMemo(() => new Set(sensitiveFieldKeys), [sensitiveFieldKeys]);
  // Last saved state (#703): the guard is on only while the form differs from it.
  const [saved, setSaved] = useState({
    answers: props.initialAnswers ?? {},
    rosterMemberId: props.mode === "club" ? props.initialRosterMemberId ?? "" : "",
    subjectName: props.mode === "club" ? props.initialSubjectName ?? "" : "",
  });
  const current = { answers, rosterMemberId, subjectName };
  const dirty = !doneMessage && clubFormIsDirty(current, saved);
  const allowNavigation = useUnsavedChangesGuard(dirty, clubFormUnsavedMessage);

  function set(key: string, value: unknown) {
    setAnswers((current) => ({ ...current, [key]: value }));
  }

  async function send(submit: boolean) {
    setSaving(true);
    setError("");
    setIssues([]);
    setNotice("");
    try {
      const response = props.mode === "club"
        ? await fetch(`/api/attendee/clubs/${encodeURIComponent(props.organizationId)}/forms/submissions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            templateKey: props.templateKey,
            submissionId: savedId,
            rosterMemberId: rosterMemberId || null,
            subjectName: rosterMemberId ? undefined : subjectName || undefined,
            answers,
            submit,
          }),
        })
        : await fetch(`/api/public/club-forms/${encodeURIComponent(props.token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers }),
        });
      const result = await response.json().catch(() => ({})) as {
        message?: string;
        issues?: Issue[];
        submission?: { id: string; status: string };
        confirmationMessage?: string;
      };
      if (!response.ok) {
        setError(result.message ?? "The form could not be saved.");
        setIssues(result.issues ?? []);
        return;
      }
      setSaved(current);
      if (props.mode === "link") {
        setDoneMessage(result.confirmationMessage ?? "Thank you. Your form has been received.");
        return;
      }
      if (submit) {
        allowNavigation();
        window.location.assign(props.doneHref);
        return;
      }
      setSavedId(result.submission?.id);
      setNotice("Draft saved.");
    } catch {
      setError("The form could not be saved. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  if (doneMessage) {
    return (
      <div className="inline-notice success club-form-done" role="status">
        <strong>{doneMessage}</strong>
        <span> This link has now been used and cannot be opened again.</span>
      </div>
    );
  }

  return (
    <form
      className="club-form-fill"
      onSubmit={(event) => {
        event.preventDefault();
        void send(true);
      }}
    >
      {props.mode === "club" && (
        <fieldset className="public-manage-card form-stack" disabled={saving || Boolean(savedId)}>
          <legend className="public-registration-eyebrow">Who is this form for?</legend>
          {props.rosterMembers.length > 0 && (
            <label>
              Roster member
              <select value={rosterMemberId} onChange={(event) => setRosterMemberId(event.target.value)}>
                <option value="">Not a roster member (for example a staff applicant)</option>
                {props.rosterMembers.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
              </select>
            </label>
          )}
          {!rosterMemberId && (
            <label>
              Label for your list (optional)
              <input maxLength={120} value={subjectName} onChange={(event) => setSubjectName(event.target.value)} />
            </label>
          )}
          {savedId && <small className="field-help">This draft is already tied to a person. Start a new form to change who it is for.</small>}
        </fieldset>
      )}

      {definition.sections.map((section) => {
        const fields = section.fields.filter((field) => isFieldVisible(field, answers));
        if (fields.length === 0) return null;
        return (
          <fieldset className="public-manage-card form-stack" disabled={saving} key={section.id}>
            <legend className="public-registration-eyebrow">{section.title}</legend>
            {section.description && <p className="field-help">{section.description}</p>}
            {(sectionNotes[section.id] ?? []).map((note, index) => <p className="club-form-note" key={index}>{note}</p>)}
            <div className="form-grid two-column">
              {fields.map((field) => (
                <FieldInput
                  answers={answers}
                  field={field}
                  isSensitive={sensitive.has(field.key)}
                  key={field.id}
                  onChange={(value) => set(field.key, value)}
                  value={answers[field.key]}
                />
              ))}
            </div>
          </fieldset>
        );
      })}

      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && (
        <div className="inline-notice error" role="alert">
          {error}
          {issues.length > 1 && <ul>{issues.slice(0, 8).map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>}
        </div>
      )}
      <div className="intro-actions">
        {props.mode === "club" && (
          <button className="secondary-button" disabled={saving} onClick={() => void send(false)} type="button">Save draft</button>
        )}
        <button className="primary-button" disabled={saving} type="submit">Submit form</button>
      </div>
    </form>
  );
}

function FieldInput({
  field,
  value,
  answers,
  isSensitive,
  onChange,
}: {
  field: RegistrationFormField;
  value: unknown;
  answers: Answers;
  isSensitive: boolean;
  onChange: (value: unknown) => void;
}) {
  const required = isFieldRequired(field, answers);
  const label = (
    <span>
      {field.label}
      {required ? <span aria-hidden="true"> *</span> : null}
      {isSensitive && <small className="club-form-private"><LockKeyhole aria-hidden="true" size={11} /> Private</small>}
    </span>
  );
  const help = field.helpText ? <small className="field-help">{field.helpText}</small> : null;
  const wide = field.type === "LONG_TEXT" || field.type === "ADDRESS" || field.type === "RADIO" || field.type === "MULTISELECT" || field.type === "RANKED_CHOICE" || field.label.length > 60;
  const className = wide ? "club-form-field-wide" : undefined;

  switch (field.type) {
    case "LONG_TEXT":
      return (
        <label className={className}>{label}
          <textarea maxLength={5000} required={required} rows={4} value={textOf(value)} onChange={(event) => onChange(event.target.value)} />
          {help}
        </label>
      );
    case "SELECT":
      return (
        <label className={className}>{label}
          <select required={required} value={textOf(value)} onChange={(event) => onChange(event.target.value)}>
            <option value="">Choose…</option>
            {field.options.map((option) => <option key={option} value={option}>{field.optionLabels?.[option] ?? option}</option>)}
          </select>
          {help}
        </label>
      );
    case "RADIO":
      return (
        <fieldset className={`club-form-choice ${className ?? ""}`}>
          <legend>{label}</legend>
          <div className="club-form-choice-row">
            {field.options.map((option) => (
              <label className="checkbox-label" key={option}>
                <input checked={value === option} name={field.key} onChange={() => onChange(option)} type="radio" />
                {field.optionLabels?.[option] ?? option}
              </label>
            ))}
          </div>
          {help}
        </fieldset>
      );
    case "RANKED_CHOICE": {
      const selected = Array.isArray(value) ? value.map(String).filter((item) => field.options.includes(item)) : [];
      const maximum = rankedMaximum(field);
      return (
        <fieldset className={`club-form-choice ${className ?? ""}`}>
          <legend>{label}</legend>
          <small className="field-help">
            Tap choices in preference order, up to {maximum}. Tap a ranked choice again to remove it and re-rank.
          </small>
          <div className="club-form-ranking-list">
            {field.options.map((option) => {
              const rank = selected.indexOf(option);
              return (
                <button
                  aria-pressed={rank >= 0}
                  className={rank >= 0 ? "is-selected" : undefined}
                  disabled={rank < 0 && selected.length >= maximum}
                  key={option}
                  onClick={() => onChange(toggleRankedChoice(selected, option, maximum))}
                  type="button"
                >
                  <span>{field.optionLabels?.[option] ?? option}</span>
                  <b>{rankLabel(rank)}</b>
                </button>
              );
            })}
          </div>
          {help}
        </fieldset>
      );
    }
    case "MULTISELECT": {
      const selected = Array.isArray(value) ? value.map(String) : [];
      return (
        <fieldset className={`club-form-choice ${className ?? ""}`}>
          <legend>{label}</legend>
          <div className="club-form-choice-row">
            {field.options.map((option) => (
              <label className="checkbox-label" key={option}>
                <input
                  checked={selected.includes(option)}
                  onChange={(event) => onChange(event.target.checked ? [...selected, option] : selected.filter((item) => item !== option))}
                  type="checkbox"
                />
                {field.optionLabels?.[option] ?? option}
              </label>
            ))}
          </div>
          {help}
        </fieldset>
      );
    }
    case "CHECKBOX":
      return (
        <label className={`checkbox-label ${className ?? "club-form-field-wide"}`}>
          <input checked={value === true} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
          {label}
          {help}
        </label>
      );
    case "ADDRESS": {
      const address = (value && typeof value === "object" ? value : {}) as Record<string, string>;
      return (
        <fieldset className="club-form-choice club-form-field-wide">
          <legend>{label}</legend>
          <div className="form-grid two-column">
            {addressComponentKeys.map((key) => (
              <label key={key}>{addressComponentLabels[key]}
                <input maxLength={200} value={address[key] ?? ""} onChange={(event) => onChange({ ...address, [key]: event.target.value })} />
              </label>
            ))}
          </div>
          {help}
        </fieldset>
      );
    }
    case "DATE": {
      const bounds = dateFieldBounds(field);
      return (
        <label className={className}>{label}
          <input max={bounds.max} min={bounds.min} required={required} type="date" value={textOf(value)} onChange={(event) => onChange(event.target.value)} />
          {help}
        </label>
      );
    }
    case "NUMBER":
      return (
        <label className={className}>{label}
          <input inputMode="decimal" required={required} step="any" type="number" value={typeof value === "number" || typeof value === "string" ? String(value) : ""} onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))} />
          {help}
        </label>
      );
    default: {
      const inputType = field.type === "EMAIL" ? "email" : field.type === "PHONE" ? "tel" : "text";
      return (
        <label className={className}>{label}
          <input maxLength={field.type === "EMAIL" ? 160 : 500} required={required} type={inputType} value={textOf(value)} onChange={(event) => onChange(event.target.value)} />
          {help}
        </label>
      );
    }
  }
}
