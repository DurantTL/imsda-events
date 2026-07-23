"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Code2,
  Copy,
  ExternalLink,
  Globe2,
  MapPin,
  Save,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import type { EventSettingsRecord } from "@/modules/events/repository";
import { getEventPublishReadiness } from "@/modules/events/readiness";
import {
  eventTimeZones,
  type EventSettingsInput,
} from "@/modules/events/schemas";
import { useUnsavedChangesGuard } from "@/components/use-unsaved-changes-guard";

type EventSettingsWorkspaceProps = {
  mode: "create" | "edit";
  initialEvent: EventSettingsRecord | null;
};

type EventApiResult = {
  event?: EventSettingsRecord;
  message?: string;
  issues?: Array<{ message?: string }>;
};

const timeZoneLabels: Record<(typeof eventTimeZones)[number], string> = {
  "America/New_York": "Eastern Time",
  "America/Chicago": "Central Time",
  "America/Denver": "Mountain Time",
  "America/Phoenix": "Arizona Time",
  "America/Los_Angeles": "Pacific Time",
  "America/Anchorage": "Alaska Time",
  "Pacific/Honolulu": "Hawaii Time",
};

function slugFromName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function draftFromEvent(event: EventSettingsRecord | null): EventSettingsInput {
  return {
    name: event?.name ?? "",
    slug: event?.slug ?? "",
    startsOn: event?.startsOn ?? "",
    endsOn: event?.endsOn ?? "",
    timezone: (event?.timezone as EventSettingsInput["timezone"] | undefined)
      ?? "America/Chicago",
    location: event?.location ?? null,
    capacity: event?.capacity ?? null,
    publicInfoUrl: event?.publicInfoUrl ?? null,
    supportContact: event?.supportContact ?? null,
    isPublished: event?.isPublished ?? false,
    registrationOpensOn: event?.registrationOpensOn ?? null,
    registrationClosesOn: event?.registrationClosesOn ?? null,
    waitlistEnabled: event?.waitlistEnabled ?? false,
    autoPromoteWaitlist: event?.waitlistEnabled
      ? (event.autoPromoteWaitlist ?? false)
      : false,
  };
}

export function EventSettingsWorkspace({
  mode,
  initialEvent,
}: EventSettingsWorkspaceProps) {
  const [draft, setDraft] = useState<EventSettingsInput>(() => draftFromEvent(initialEvent));
  const [savedDraft, setSavedDraft] = useState<EventSettingsInput>(() => draftFromEvent(initialEvent));
  const [publishedFormCount, setPublishedFormCount] = useState(initialEvent?.publishedFormCount ?? 0);
  const [slugWasEdited, setSlugWasEdited] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copiedFormSlug, setCopiedFormSlug] = useState("");
  const readiness = useMemo(
    () => getEventPublishReadiness(draft, publishedFormCount),
    [draft, publishedFormCount],
  );
  const publishingForFirstTime = draft.isPublished && !initialEvent?.isPublished;
  const saveBlocked = publishingForFirstTime && !readiness.ready;
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(savedDraft),
    [draft, savedDraft],
  );
  const allowNextNavigation = useUnsavedChangesGuard(
    dirty,
    "These event settings have not been saved. Leave and discard the changes?",
  );

  function update<K extends keyof EventSettingsInput>(key: K, value: EventSettingsInput[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError("");
    setNotice("");
  }

  function updateName(name: string) {
    setDraft((current) => ({
      ...current,
      name,
      slug: slugWasEdited ? current.slug : slugFromName(name),
    }));
    setError("");
    setNotice("");
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saveBlocked) {
      setError("Finish every item in the publish checklist before turning on public registration.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        mode === "create" ? "/api/events" : `/api/events/${initialEvent!.id}`,
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...draft,
            location: draft.location || null,
            publicInfoUrl: draft.publicInfoUrl || null,
            supportContact: draft.supportContact || null,
            registrationOpensOn: draft.registrationOpensOn || null,
            registrationClosesOn: draft.registrationClosesOn || null,
            capacity: draft.capacity || null,
            isPublished: mode === "create" ? false : draft.isPublished,
          }),
        },
      );
      const result = await response.json().catch(() => ({})) as EventApiResult;
      if (!response.ok || !result.event) {
        throw new Error(
          result.message
          ?? result.issues?.[0]?.message
          ?? "The event could not be saved.",
        );
      }
      if (mode === "create") {
        allowNextNavigation();
        window.location.assign(`/more/event-settings?event=${encodeURIComponent(result.event.id)}&created=1`);
        return;
      }
      const nextDraft = draftFromEvent(result.event);
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setPublishedFormCount(result.event.publishedFormCount);
      setNotice(result.event.isPublished
        ? "Event settings saved. Public registration is available during the registration window."
        : "Event settings saved as a draft.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The event could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function copyEmbedCode(formSlug: string) {
    const source = new URL(
      `/embed/${encodeURIComponent(draft.slug)}/${encodeURIComponent(formSlug)}`,
      window.location.origin,
    ).toString();
    const code = `<iframe src="${source}" title="${draft.name} registration" width="100%" height="900" style="border:0" loading="lazy"></iframe>`;
    try {
      await navigator.clipboard.writeText(code);
      setCopiedFormSlug(formSlug);
      setNotice("Embed code copied. Paste it into an IMSDA.org Custom HTML block.");
      setError("");
    } catch {
      setError("The embed code could not be copied. Open the embedded form and copy its address instead.");
    }
  }

  return (
    <section className="page-stack event-settings-workspace">
      <div className="page-intro">
        <div>
          <p className="eyebrow">{mode === "create" ? "New event setup" : "Event setup"}</p>
          <h2>{mode === "create" ? "Create an event draft" : "Event settings"}</h2>
          <p>
            {mode === "create"
              ? "Start with the information attendees and staff need. The event stays private until its registration form and publish checklist are ready."
              : `Update the public details, registration dates, capacity, and publishing status for ${initialEvent?.name}.`}
          </p>
        </div>
        <span className={`count-badge ${draft.isPublished ? "green" : ""}`}>
          <ShieldCheck size={16} aria-hidden="true" />
          {draft.isPublished ? "Published" : "Private draft"}
        </span>
      </div>

      {error && <div className="inline-notice error" role="alert"><AlertTriangle size={17} aria-hidden="true" /> {error}</div>}
      {notice && <div className="inline-notice success" role="status"><CheckCircle2 size={17} aria-hidden="true" /> {notice}</div>}

      <form className="event-settings-layout" onSubmit={save}>
        <div className="event-settings-main">
          <section className="panel form-stack event-settings-panel">
            <div className="section-heading">
              <div><p className="eyebrow">Step 1</p><h2>Event basics</h2><p>Use the public event name and the dates attendees will recognize.</p></div>
              <CalendarDays size={21} aria-hidden="true" />
            </div>
            <label>
              Event name
              <input
                value={draft.name}
                minLength={3}
                maxLength={120}
                required
                autoComplete="off"
                placeholder="Women’s Retreat 2027"
                onChange={(event) => updateName(event.target.value)}
              />
            </label>
            <label>
              Short web address
              <span className="event-slug-input"><b>/register/</b><input
                value={draft.slug}
                minLength={3}
                maxLength={80}
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                placeholder="womens-retreat-2027"
                onChange={(event) => {
                  setSlugWasEdited(true);
                  update("slug", event.target.value.toLowerCase());
                }}
              /></span>
              <small>Lowercase letters, numbers, and hyphens. Changing this later changes registration links.</small>
            </label>
            <div className="form-grid two-column">
              <label>Starts on<input type="date" required value={draft.startsOn} onChange={(event) => update("startsOn", event.target.value)} /></label>
              <label>Ends on<input type="date" required min={draft.startsOn || undefined} value={draft.endsOn} onChange={(event) => update("endsOn", event.target.value)} /></label>
            </div>
            <label>
              Event timezone
              <select value={draft.timezone} onChange={(event) => update("timezone", event.target.value as EventSettingsInput["timezone"])}>
                {eventTimeZones.map((zone) => <option value={zone} key={zone}>{timeZoneLabels[zone]} ({zone})</option>)}
              </select>
              <small>Registration opening, closing, and late-price dates use this timezone.</small>
            </label>
            <div className="form-grid two-column">
              <label>
                Location
                <span className="input-with-icon"><MapPin size={16} aria-hidden="true" /><input value={draft.location ?? ""} maxLength={200} placeholder="Camp Heritage, Clarksburg, MO" onChange={(event) => update("location", event.target.value || null)} /></span>
              </label>
              <label>
                Overall attendee limit
                <span className="input-with-icon"><UsersRound size={16} aria-hidden="true" /><input type="number" min={1} max={100000} value={draft.capacity ?? ""} placeholder="No overall limit" onChange={(event) => update("capacity", event.target.value ? Number(event.target.value) : null)} /></span>
              </label>
            </div>
          </section>

          <section className="panel form-stack event-settings-panel">
            <div className="section-heading">
              <div><p className="eyebrow">Step 2</p><h2>Registration timing &amp; waitlist</h2><p>Leave either date blank when registration should remain open-ended.</p></div>
            </div>
            <div className="form-grid two-column">
              <label>Registration opens<input type="date" value={draft.registrationOpensOn ?? ""} onChange={(event) => update("registrationOpensOn", event.target.value || null)} /></label>
              <label>Registration closes<input type="date" min={draft.registrationOpensOn || undefined} value={draft.registrationClosesOn ?? ""} onChange={(event) => update("registrationClosesOn", event.target.value || null)} /></label>
            </div>
            <label className="event-setting-toggle">
              <input
                type="checkbox"
                checked={draft.waitlistEnabled}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setDraft((current) => ({
                    ...current,
                    waitlistEnabled: enabled,
                    autoPromoteWaitlist: enabled ? current.autoPromoteWaitlist : false,
                  }));
                }}
              />
              <span><strong>Offer a waitlist when the event is full</strong><small>People can submit without taking a confirmed event spot.</small></span>
            </label>
            <label className="event-setting-toggle nested">
              <input
                type="checkbox"
                disabled={!draft.waitlistEnabled}
                checked={draft.autoPromoteWaitlist}
                onChange={(event) => update("autoPromoteWaitlist", event.target.checked)}
              />
              <span><strong>Automatically promote the next eligible registration</strong><small>Use the saved queue order when capacity becomes available.</small></span>
            </label>
          </section>

          <section className="panel form-stack event-settings-panel">
            <div className="section-heading">
              <div><p className="eyebrow">Step 3</p><h2>Public information &amp; help</h2><p>Connect registration to the full event information already maintained on IMSDA.org.</p></div>
              <Globe2 size={21} aria-hidden="true" />
            </div>
            <label>
              IMSDA.org event page
              <input type="url" value={draft.publicInfoUrl ?? ""} maxLength={500} placeholder="https://imsda.org/event/your-event/" onChange={(event) => update("publicInfoUrl", event.target.value || null)} />
              <small>This WordPress page remains the public source for schedules, speakers, packing lists, and event details.</small>
            </label>
            <label>
              Registration support contact
              <input value={draft.supportContact ?? ""} maxLength={200} placeholder="registration@imsda.org or conference office phone" onChange={(event) => update("supportContact", event.target.value || null)} />
              <small>Enter the email, phone number, or office name attendees should use for help.</small>
            </label>
            {draft.publicInfoUrl && (
              <a className="secondary-button event-info-preview" href={draft.publicInfoUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={15} aria-hidden="true" /> Open IMSDA.org page
              </a>
            )}
          </section>
        </div>

        <aside className="event-settings-side">
          <section className="panel event-readiness-panel">
            <p className="eyebrow">Publish readiness</p>
            <h2>{readiness.ready ? "Ready to publish" : `${readiness.completedCount} of ${readiness.items.length} ready`}</h2>
            <p>Publishing turns on the event’s public registration links. Form versions and registration dates still control what attendees can submit.</p>
            <ul className="event-readiness-list">
              {readiness.items.map((item) => (
                <li className={item.complete ? "complete" : ""} key={item.id}>
                  {item.complete ? <CheckCircle2 size={18} aria-hidden="true" /> : <span aria-hidden="true" />}
                  <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                </li>
              ))}
            </ul>
            {!readiness.items.find((item) => item.id === "registration-form")?.complete && (
              mode === "edit"
                ? <a className="secondary-button full-button" href={`/registration-builder?event=${initialEvent?.id}`}>Open registration builder</a>
                : <div className="inline-notice">Create this draft first. Then build, test, and publish its registration form.</div>
            )}
            {mode === "edit" && (
              <label className={`event-publish-toggle ${readiness.ready ? "ready" : ""}`}>
                <input
                  type="checkbox"
                  checked={draft.isPublished}
                  disabled={!draft.isPublished && !readiness.ready}
                  onChange={(event) => update("isPublished", event.target.checked)}
                />
                <span>
                  <strong>{draft.isPublished ? "Public registration is on" : "Publish this event"}</strong>
                  <small>{draft.isPublished ? "Turn this off to close every public form immediately." : "Available after every checklist item is complete."}</small>
                </span>
              </label>
            )}
          </section>

          {mode === "edit" && (
            <section className="panel event-sharing-panel">
              <p className="eyebrow">Website sharing</p>
              <h2>Public registration</h2>
              {draft.isPublished && initialEvent?.publishedForms.length ? (
                <>
                  <p>Link to the event page from IMSDA.org, or embed a specific form in a Custom HTML block.</p>
                  <a
                    className="secondary-button full-button"
                    href={`/events/${encodeURIComponent(draft.slug)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink size={15} aria-hidden="true" /> Open public event page
                  </a>
                  <div className="event-share-form-list">
                    {initialEvent.publishedForms.map((form) => (
                      <article key={form.id}>
                        <span><strong>{form.name}</strong><small>/embed/{draft.slug}/{form.slug}</small></span>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => copyEmbedCode(form.slug)}
                        >
                          {copiedFormSlug === form.slug
                            ? <CheckCircle2 size={15} aria-hidden="true" />
                            : <Copy size={15} aria-hidden="true" />}
                          {copiedFormSlug === form.slug ? "Copied" : "Copy embed code"}
                        </button>
                      </article>
                    ))}
                  </div>
                  <small className="event-embed-note"><Code2 size={14} aria-hidden="true" /> Embeds are accepted only when displayed on IMSDA.org.</small>
                </>
              ) : (
                <p>Publish the event and at least one registration form to unlock its public link and website embed code.</p>
              )}
            </section>
          )}

          <section className="panel event-save-panel">
            <p>{mode === "create" ? "Nothing is public when this draft is created." : draft.isPublished ? "Saving keeps the event public unless you turn publishing off." : "Saving does not publish the event."}</p>
            {dirty && <span className="unsaved-dot" role="status">Unsaved changes</span>}
            <button className="primary-button full-button" type="submit" disabled={saving || saveBlocked || !dirty}>
              <Save size={16} aria-hidden="true" />
              {saving ? "Saving…" : mode === "create" ? "Create event draft" : "Save event settings"}
            </button>
          </section>
        </aside>
      </form>
    </section>
  );
}
