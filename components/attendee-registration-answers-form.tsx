"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, ListChecks, Save } from "lucide-react";
import type { EditableAttendeeField } from "@/modules/attendee-accounts/registration-answer-policy";

type EditableAttendee = {
  attendeeId: string;
  name: string;
  responses: Record<string, unknown>;
};

function fieldIsVisible(
  field: EditableAttendeeField,
  responses: Record<string, unknown>,
) {
  const condition = field.conditional;
  if (!condition) return true;
  const actual = responses[condition.fieldKey];
  if (condition.operator === "NOT_EMPTY") {
    return Array.isArray(actual)
      ? actual.length > 0
      : actual !== null && actual !== undefined && String(actual).trim() !== "";
  }
  if (condition.operator === "INCLUDES") {
    return Array.isArray(actual)
      ? actual.map(String).includes(condition.value)
      : String(actual ?? "").includes(condition.value);
  }
  if (condition.operator === "NOT_EQUALS") {
    return String(actual ?? "") !== condition.value;
  }
  return String(actual ?? "") === condition.value;
}

function valuesEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function AttendeeRegistrationAnswersForm({
  registrationId,
  initialExpectedUpdatedAt,
  fields,
  initialAttendees,
}: {
  registrationId: string;
  initialExpectedUpdatedAt: string;
  fields: EditableAttendeeField[];
  initialAttendees: EditableAttendee[];
}) {
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(initialExpectedUpdatedAt);
  const [saved, setSaved] = useState(initialAttendees);
  const [attendees, setAttendees] = useState(initialAttendees);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty = useMemo(() => !valuesEqual(saved, attendees), [attendees, saved]);

  function updateAnswer(attendeeId: string, key: string, value: unknown) {
    setAttendees((current) => current.map((attendee) => (
      attendee.attendeeId === attendeeId
        ? {
            ...attendee,
            responses: { ...attendee.responses, [key]: value },
          }
        : attendee
    )));
    setError("");
    setNotice("");
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/attendee/registrations/${encodeURIComponent(registrationId)}/answers`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedUpdatedAt,
            attendees: attendees.map((attendee) => ({
              attendeeId: attendee.attendeeId,
              responses: attendee.responses,
            })),
          }),
        },
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(result.attendees)) {
        throw new Error(result.message ?? "The attendee choices could not be saved.");
      }
      const next = result.attendees as EditableAttendee[];
      setAttendees(next);
      setSaved(next);
      setExpectedUpdatedAt(result.expectedUpdatedAt);
      setNotice("Attendee choices saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The attendee choices could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="attendee-answer-editor" onSubmit={save}>
      <div className="public-manage-card-heading">
        <span className="attendee-answer-icon"><ListChecks size={20} aria-hidden="true" /></span>
        <div>
          <p className="public-registration-eyebrow">Self-service choices</p>
          <h3>Meals, sessions and retreat details</h3>
          <p>These low-risk choices can be updated from your verified account.</p>
        </div>
      </div>

      {attendees.map((attendee) => (
        <fieldset className="attendee-answer-person" key={attendee.attendeeId}>
          <legend>{attendee.name}</legend>
          <div className="attendee-answer-grid">
            {fields.filter((field) => fieldIsVisible(field, attendee.responses)).map((field) => {
              const value = attendee.responses[field.key];
              if (field.type === "CHECKBOX") {
                return (
                  <label className="attendee-answer-check" key={field.id}>
                    <input
                      type="checkbox"
                      checked={value === true}
                      onChange={(event) => updateAnswer(
                        attendee.attendeeId,
                        field.key,
                        event.target.checked,
                      )}
                    />
                    <span><strong>{field.label}</strong>{field.helpText && <small>{field.helpText}</small>}</span>
                  </label>
                );
              }
              if (field.type === "MULTISELECT") {
                const selected = Array.isArray(value) ? value.map(String) : [];
                return (
                  <fieldset className="attendee-answer-options" key={field.id}>
                    <legend>{field.label}{field.required ? " *" : ""}</legend>
                    {field.options.map((option) => (
                      <label key={option}>
                        <input
                          type="checkbox"
                          checked={selected.includes(option)}
                          onChange={(event) => updateAnswer(
                            attendee.attendeeId,
                            field.key,
                            event.target.checked
                              ? [...selected, option]
                              : selected.filter((entry) => entry !== option),
                          )}
                        />
                        {option}
                      </label>
                    ))}
                    {field.helpText && <small>{field.helpText}</small>}
                  </fieldset>
                );
              }
              if (field.type === "RANKED_CHOICE") {
                const selected = Array.isArray(value) ? value.map(String) : [];
                const slots = field.maxSelections ?? 2;
                return (
                  <fieldset className="attendee-answer-ranking" key={field.id}>
                    <legend>{field.label}{field.required ? " *" : ""}</legend>
                    {Array.from({ length: slots }, (_, rank) => (
                      <label key={rank}>
                        <span>{rank === 0 ? "First choice" : rank === 1 ? "Second choice" : `Choice ${rank + 1}`}</span>
                        <select
                          value={selected[rank] ?? ""}
                          required={field.required || rank < (field.minSelections ?? 0)}
                          onChange={(event) => {
                            const next = [...selected];
                            if (event.target.value) next[rank] = event.target.value;
                            else next.splice(rank, 1);
                            updateAnswer(attendee.attendeeId, field.key, next.filter(Boolean));
                          }}
                        >
                          <option value="">Choose…</option>
                          {field.options.map((option) => (
                            <option
                              value={option}
                              key={option}
                              disabled={selected.some((entry, index) => index !== rank && entry === option)}
                            >
                              {option}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                    {field.helpText && <small>{field.helpText}</small>}
                  </fieldset>
                );
              }
              if (field.type === "NUMBER") {
                return (
                  <label key={field.id}>
                    {field.label}
                    <input
                      type="number"
                      min="0"
                      max="100000"
                      required={field.required}
                      value={typeof value === "number" || typeof value === "string" ? value : ""}
                      onChange={(event) => updateAnswer(attendee.attendeeId, field.key, event.target.value)}
                    />
                    {field.helpText && <small>{field.helpText}</small>}
                  </label>
                );
              }
              return (
                <label key={field.id}>
                  {field.label}
                  <select
                    required={field.required}
                    value={typeof value === "string" ? value : ""}
                    onChange={(event) => updateAnswer(attendee.attendeeId, field.key, event.target.value)}
                  >
                    <option value="">Choose…</option>
                    {field.options.map((option) => (
                      <option value={option} key={option}>{option}</option>
                    ))}
                  </select>
                  {field.helpText && <small>{field.helpText}</small>}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}

      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="inline-notice" role="status"><CheckCircle2 size={16} aria-hidden="true" /> {notice}</p>}
      <div className="form-actions">
        {dirty && <span className="unsaved-dot" role="status">Unsaved choices</span>}
        <button className="primary-button" type="submit" disabled={!dirty || saving}>
          <Save size={16} aria-hidden="true" /> {saving ? "Saving…" : "Save attendee choices"}
        </button>
      </div>
    </form>
  );
}
