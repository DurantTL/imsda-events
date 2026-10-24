"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { parseAlertRecipients } from "@/modules/club-forms/alert-recipients";
import {
  CLUB_CONDITION_KEY,
  FORM_NOTIFICATIONS_MAX_PER_FORM,
  FORM_NOTIFICATION_MAX_RECIPIENTS,
  LOCATION_CONDITION_KEY,
} from "@/modules/registration-form-notifications/constants";

/**
 * The form's "Notifications" panel (#1081): a plain list in the form's settings, in the existing staff page style (the
 * builder redesign, #1062, can move it). Event administrators and system administrators only: the page does not render
 * it for anyone else and the route checks again. It is saved on its own and takes effect at once, with no new form version.
 */

type PanelData = {
  notifications: Array<{
    id: string;
    name: string;
    recipients: string[];
    condition: { fieldKey: string; operator: "EQUALS" | "NOT_EQUALS"; value: string } | null;
    sectionIds: string[];
    warnings: string[];
    clubRemoved: boolean;
  }>;
  fields: Array<{ key: string; label: string; options: string[] }>;
  sections: Array<{ id: string; title: string }>;
  locations: Array<{ id: string; name: string }>;
  clubs: Array<{ id: string; name: string }>;
};

type Draft = {
  localKey: string;
  id?: string;
  name: string;
  recipientsText: string;
  /** The addresses saved for this notification: an old one left alone is not held against a re-save (#1193). */
  savedRecipients: string[];
  /** "" means always send. */
  conditionFieldKey: string;
  conditionOperator: "EQUALS" | "NOT_EQUALS";
  conditionValue: string;
  onlyTheseSections: boolean;
  sectionIds: string[];
  warnings: string[];
  /** The stored club is gone from the directory: shown as "(club removed)". */
  clubRemoved: boolean;
  /** What the staff member typed to find a club. Never saved. */
  clubSearch: string;
};

let localCounter = 0;
function nextKey() {
  localCounter += 1;
  return `n${localCounter}`;
}

function toDraft(row: PanelData["notifications"][number]): Draft {
  return {
    localKey: row.id,
    id: row.id,
    name: row.name,
    recipientsText: row.recipients.join("\n"),
    savedRecipients: row.recipients,
    conditionFieldKey: row.condition?.fieldKey ?? "",
    conditionOperator: row.condition?.operator ?? "EQUALS",
    conditionValue: row.condition?.value ?? "",
    onlyTheseSections: row.sectionIds.length > 0,
    sectionIds: row.sectionIds,
    warnings: row.warnings,
    clubRemoved: row.clubRemoved,
    clubSearch: "",
  };
}

function blankDraft(): Draft {
  return { localKey: nextKey(), name: "", recipientsText: "", savedRecipients: [], conditionFieldKey: "", conditionOperator: "EQUALS", conditionValue: "", onlyTheseSections: false, sectionIds: [], warnings: [], clubRemoved: false, clubSearch: "" };
}

export function RegistrationFormNotificationsPanel({ eventId, formId }: { eventId: string; formId: string }) {
  const headingId = useId();
  const base = `/api/events/${encodeURIComponent(eventId)}/forms/${encodeURIComponent(formId)}/notifications`;
  const [data, setData] = useState<PanelData | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  const apply = useCallback((next: PanelData) => {
    setData(next);
    setDrafts(next.notifications.map(toDraft));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(base, { headers: { Accept: "application/json" } })
      .then(async (response) => {
        const result = await response.json().catch(() => null) as (PanelData & { message?: string }) | null;
        if (cancelled) return;
        if (!response.ok || !result) {
          setLoadError(result?.message ?? "The notifications could not be loaded.");
          return;
        }
        apply(result);
      })
      .catch(() => {
        if (!cancelled) setLoadError("The notifications could not be loaded. Check your connection and reload.");
      });
    return () => {
      cancelled = true;
    };
  }, [base, apply]);

  function update(localKey: string, patch: Partial<Draft>) {
    setNotice("");
    setDrafts((current) => current.map((draft) => (draft.localKey === localKey ? { ...draft, ...patch } : draft)));
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    const notifications = [];
    for (const [index, draft] of drafts.entries()) {
      const label = draft.name.trim() || `Notification ${index + 1}`;
      if (draft.name.trim().length < 2) return setError(`Notification ${index + 1}: give it a name.`);
      const checked = parseAlertRecipients(draft.recipientsText, draft.savedRecipients);
      if (!checked.ok) return setError(`${label}: ${checked.message}`);
      if (checked.emails.length === 0) return setError(`${label}: add at least one email address.`);
      if (draft.conditionFieldKey && !draft.conditionValue.trim()) return setError(`${label}: choose the value the condition looks for, or turn the condition off.`);
      if (draft.onlyTheseSections && draft.sectionIds.length === 0) return setError(`${label}: choose at least one section, or include every section.`);
      notifications.push({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(),
        recipients: checked.emails,
        condition: draft.conditionFieldKey ? { fieldKey: draft.conditionFieldKey, operator: draft.conditionOperator, value: draft.conditionValue.trim() } : null,
        sectionIds: draft.onlyTheseSections ? draft.sectionIds : [],
      });
    }
    setSaving(true);
    try {
      const response = await fetch(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notifications }) });
      const result = await response.json().catch(() => null) as (PanelData & { message?: string }) | null;
      if (!response.ok || !result) {
        setError(result?.message ?? "The notifications could not be saved. Try again.");
        return;
      }
      apply(result);
      setNotice(notifications.length === 0 ? "Saved. This form sends no notifications." : `Saved. ${notifications.length} notification${notifications.length === 1 ? "" : "s"} will be sent.`);
    } catch {
      setError("The notifications could not be saved. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="panel form-stack form-notifications-panel">
      <div>
        <p className="eyebrow">Who is told</p>
        <h2 id={headingId}>Notifications</h2>
      </div>
      <p className="field-help">
        Each notification emails the addresses you type when someone registers on this form, with the registration PDF attached.
        Limit one to a location, a club or another answer, and to only some sections. When a director or staff change the registration, a
        notification is sent again, marked Updated, only if something in its sections changed; a location or club change also sends the new
        location&apos;s or club&apos;s notifications. The event&apos;s staff list and the registrant&apos;s confirmation are not changed by this. Answers marked
        sensitive are never in the PDF. Saved on its own; it does not need a new form version.
      </p>
      {loadError && <div className="inline-notice error" role="alert">{loadError}</div>}
      {!data && !loadError && <p className="quiet-copy">Loading notifications…</p>}
      {data && (
        <form className="form-stack" noValidate onSubmit={save}>
          {drafts.length === 0 && <p className="quiet-copy">No notifications yet. This form sends none besides the event&apos;s staff list and the registrant&apos;s confirmation.</p>}
          {drafts.map((draft, index) => {
            const field = data.fields.find((candidate) => candidate.key === draft.conditionFieldKey);
            const prefix = `${headingId}-${draft.localKey}`;
            return (
              <fieldset className="panel form-stack form-notification-item" key={draft.localKey}>
                <legend>Notification {index + 1}</legend>
                {draft.warnings.map((warning) => <div className="inline-notice error" key={warning} role="alert">{warning}</div>)}
                <label>
                  <span>Name</span>
                  <input autoComplete="off" maxLength={80} onChange={(event) => update(draft.localKey, { name: event.target.value })} placeholder="Camping coordinator" value={draft.name} />
                </label>
                <label>
                  <span>Email these addresses</span>
                  <textarea
                    aria-describedby={`${prefix}-addresses`}
                    autoComplete="off"
                    maxLength={2000}
                    onChange={(event) => update(draft.localKey, { recipientsText: event.target.value })}
                    rows={3}
                    spellCheck={false}
                    value={draft.recipientsText}
                  />
                </label>
                <p className="field-help" id={`${prefix}-addresses`}>One address per line, up to {FORM_NOTIFICATION_MAX_RECIPIENTS}.</p>

                <label>
                  <span>Send</span>
                  <select
                    onChange={(event) => update(draft.localKey, { conditionFieldKey: event.target.value, conditionValue: "", conditionOperator: "EQUALS", clubRemoved: false, clubSearch: "" })}
                    value={draft.conditionFieldKey}
                  >
                    <option value="">Every time</option>
                    {data.locations.length > 0 && <option value={LOCATION_CONDITION_KEY}>Only when Location…</option>}
                    {(data.clubs.length > 0 || draft.conditionFieldKey === CLUB_CONDITION_KEY) && <option value={CLUB_CONDITION_KEY}>Only when Club…</option>}
                    {data.fields.map((candidate) => <option key={candidate.key} value={candidate.key}>Only when {candidate.label}…</option>)}
                  </select>
                </label>
                {draft.conditionFieldKey && (
                  <div className="form-grid two-column">
                    <label>
                      <span>Is or is not</span>
                      <select onChange={(event) => update(draft.localKey, { conditionOperator: event.target.value === "NOT_EQUALS" ? "NOT_EQUALS" : "EQUALS" })} value={draft.conditionOperator}>
                        <option value="EQUALS">is</option>
                        <option value="NOT_EQUALS">is not</option>
                      </select>
                    </label>
                    <label>
                      <span>Value</span>
                      {draft.conditionFieldKey === LOCATION_CONDITION_KEY ? (
                        <select onChange={(event) => update(draft.localKey, { conditionValue: event.target.value })} value={draft.conditionValue}>
                          <option value="">Choose a location</option>
                          {data.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                        </select>
                      ) : draft.conditionFieldKey === CLUB_CONDITION_KEY ? (
                        <>
                          <input
                            aria-label={`Search clubs for notification ${index + 1}`}
                            autoComplete="off"
                            onChange={(event) => update(draft.localKey, { clubSearch: event.target.value })}
                            placeholder="Search clubs by name"
                            type="search"
                            value={draft.clubSearch}
                          />
                          <select onChange={(event) => update(draft.localKey, { conditionValue: event.target.value, clubRemoved: false })} value={draft.conditionValue}>
                            <option value="">Choose a club</option>
                            {draft.clubRemoved && draft.conditionValue && <option value={draft.conditionValue}>(club removed)</option>}
                            {data.clubs
                              .filter((club) => club.id === draft.conditionValue || club.name.toLowerCase().includes(draft.clubSearch.trim().toLowerCase()))
                              .map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}
                          </select>
                        </>
                      ) : field && field.options.length > 0 ? (
                        <select onChange={(event) => update(draft.localKey, { conditionValue: event.target.value })} value={draft.conditionValue}>
                          <option value="">Choose an answer</option>
                          {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                      ) : (
                        <input autoComplete="off" maxLength={120} onChange={(event) => update(draft.localKey, { conditionValue: event.target.value })} value={draft.conditionValue} />
                      )}
                    </label>
                  </div>
                )}

                <label>
                  <span>Sections in the PDF</span>
                  <select
                    onChange={(event) => update(draft.localKey, { onlyTheseSections: event.target.value === "some", sectionIds: event.target.value === "some" ? draft.sectionIds : [] })}
                    value={draft.onlyTheseSections ? "some" : "all"}
                  >
                    <option value="all">Every section, with the fees</option>
                    <option value="some">Only the sections I choose</option>
                  </select>
                </label>
                {draft.onlyTheseSections && (
                  <div role="group" aria-label={`Sections included in notification ${index + 1}`}>
                    {data.sections.map((section) => (
                      <label className="checkbox-label" key={section.id} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44 }}>
                        <input
                          checked={draft.sectionIds.includes(section.id)}
                          onChange={(event) => update(draft.localKey, {
                            sectionIds: event.target.checked ? [...draft.sectionIds, section.id] : draft.sectionIds.filter((id) => id !== section.id),
                          })}
                          style={{ width: "auto" }}
                          type="checkbox"
                        />
                        <span>{section.title}</span>
                      </label>
                    ))}
                    <p className="field-help">A copy with only some sections leaves out the fees.</p>
                  </div>
                )}
                <div>
                  <button className="secondary-button" onClick={() => { setNotice(""); setDrafts((current) => current.filter((candidate) => candidate.localKey !== draft.localKey)); }} type="button">
                    <Trash2 aria-hidden="true" size={14} /> Remove notification {index + 1}
                  </button>
                </div>
              </fieldset>
            );
          })}
          <div aria-live="polite" role="status">{notice && <p className="quiet-copy">{notice}</p>}</div>
          {error && <div className="inline-notice error" role="alert">{error}</div>}
          <div className="form-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
            <button className="secondary-button" disabled={drafts.length >= FORM_NOTIFICATIONS_MAX_PER_FORM} onClick={() => { setNotice(""); setDrafts((current) => [...current, blankDraft()]); }} type="button">
              <Plus aria-hidden="true" size={14} /> Add a notification
            </button>
            <button className="primary-button" disabled={saving} type="submit">
              <Save aria-hidden="true" size={14} /> {saving ? "Saving…" : "Save notifications"}
            </button>
          </div>
          <p className="field-help">Up to {FORM_NOTIFICATIONS_MAX_PER_FORM} notifications per form. Event administrators and system administrators can change them.</p>
        </form>
      )}
    </section>
  );
}
