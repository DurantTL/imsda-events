"use client";

import Link from "next/link";
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
import { EventLocationsPanel } from "@/components/event-locations-panel";
import type { ActiveAreaCoordinator, EventLocationRecord } from "@/modules/event-locations/repository";
import type { EventSettingsRecord } from "@/modules/events/repository";
import {
  eventKindFromAudience,
  resolveSectionPlacement,
  sectionsWithNonDefaultValues,
  type EventSettingsSectionId,
} from "@/modules/events/settings-sections";
import { getEventPublishReadiness, getEventPublishWarnings } from "@/modules/events/readiness";
import {
  eventTimeZones,
  type EventSettingsInput,
} from "@/modules/events/schemas";
import { buildRegistrationEmbedCode } from "@/modules/forms/embed";
import { useUnsavedChangesGuard } from "@/components/use-unsaved-changes-guard";
import { PublishEventDialog } from "@/components/publish-event-dialog";
import { DeleteEventDialog } from "@/components/delete-event-dialog";
import { UnpublishEventDialog } from "@/components/unpublish-event-dialog";
import { DraftCreatedGuideBanner } from "@/components/draft-created-guide-banner";

type EventSettingsWorkspaceProps = {
  mode: "create" | "edit";
  initialEvent: EventSettingsRecord | null;
  /** The event's locations (#413), edited in their own panel below the form. */
  initialLocations?: EventLocationRecord[];
  areaCoordinators?: ActiveAreaCoordinator[];
};

type EventApiResult = {
  event?: EventSettingsRecord;
  message?: string;
  issues?: Array<{ message?: string }>;
  warnings?: string[];
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
    hotelName: event?.hotelName ?? null,
    hotelBookingUrl: event?.hotelBookingUrl ?? null,
    hotelPhone: event?.hotelPhone ?? null,
    hotelGroupName: event?.hotelGroupName ?? null,
    hotelRate: event?.hotelRate ?? null,
    hotelInstructions: event?.hotelInstructions ?? null,
    registrationOpensOn: event?.registrationOpensOn ?? null,
    registrationClosesOn: event?.registrationClosesOn ?? null,
    collectsShirtSizes: event?.collectsShirtSizes ?? false,
    checksAdultBackgrounds: event?.checksAdultBackgrounds ?? false,
    attendeeEditPolicy: event?.attendeeEditPolicy ?? "VERIFY_EVERY_EDIT",
    billingMode: event?.billingMode ?? "ATTENDEE_PAY",
    audience: event?.audience ?? "GENERAL",
    approvedPaymentInstructions: event?.approvedPaymentInstructions ?? null,
    seminarPreferenceClosesOn: event?.seminarPreferenceClosesOn ?? null,
    seminarPreferenceSelfServiceLocked:
      event?.seminarPreferenceSelfServiceLocked ?? false,
    waitlistEnabled: event?.waitlistEnabled ?? false,
    autoPromoteWaitlist: event?.waitlistEnabled
      ? (event.autoPromoteWaitlist ?? false)
      : false,
  };
}

export function EventSettingsWorkspace({
  mode,
  initialEvent,
  initialLocations,
  areaCoordinators,
}: EventSettingsWorkspaceProps) {
  const [draft, setDraft] = useState<EventSettingsInput>(() => draftFromEvent(initialEvent));
  const [savedDraft, setSavedDraft] = useState<EventSettingsInput>(() => draftFromEvent(initialEvent));
  const [setupWarnings, setSetupWarnings] = useState(initialEvent?.warnings ?? []);
  const [publishedFormCount, setPublishedFormCount] = useState(initialEvent?.publishedFormCount ?? 0);
  // Publishing and unpublishing are their own actions (#471), never a side
  // effect of saving this form: tracked separately from `draft` so nothing
  // in the settings save can change it, and updated only by `publish()` and
  // `unpublish()` below.
  const [published, setPublished] = useState(initialEvent?.isPublished ?? false);
  const [publishing, setPublishing] = useState(false);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [publishError, setPublishError] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [unpublishDialogOpen, setUnpublishDialogOpen] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const [unpublishError, setUnpublishError] = useState("");
  const [slugWasEdited, setSlugWasEdited] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copiedFormSlug, setCopiedFormSlug] = useState("");
  // Readiness reflects the saved event (#471), not unsaved edits: that is
  // what the server checks when Publish is clicked, so the checklist and the
  // button never promise something a save hasn't made true yet.
  const readiness = useMemo(
    () => getEventPublishReadiness(savedDraft, publishedFormCount),
    [savedDraft, publishedFormCount],
  );
  const publishWarnings = useMemo(
    () => getEventPublishWarnings(savedDraft),
    [savedDraft],
  );
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(savedDraft),
    [draft, savedDraft],
  );
  const publishBlockedBySave = dirty || saving;
  const canPublish = readiness.ready && !publishBlockedBySave && !publishing;
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
        // A full load on purpose: the staff header's event switcher is rendered
        // on the server and has to pick up the event that was just created.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign(`/more/event-settings?event=${encodeURIComponent(result.event.id)}&created=1`);
        return;
      }
      const nextDraft = draftFromEvent(result.event);
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setPublishedFormCount(result.event.publishedFormCount);
      setPublished(result.event.isPublished);
      setSetupWarnings(result.event.warnings ?? []);
      setNotice("Event settings saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The event could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  function openPublishDialog() {
    if (!canPublish) return;
    setPublishError("");
    setPublishDialogOpen(true);
  }

  function cancelPublish() {
    if (publishing) return;
    setPublishDialogOpen(false);
    setPublishError("");
  }

  async function publish() {
    if (!canPublish) return;
    setPublishing(true);
    setPublishError("");
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/events/${initialEvent!.id}/publish`, { method: "POST" });
      const result = await response.json().catch(() => ({})) as EventApiResult;
      if (!response.ok || !result.event) {
        throw new Error(result.message ?? "The event could not be published.");
      }
      setPublished(result.event.isPublished);
      setSetupWarnings(result.event.warnings ?? []);
      setPublishDialogOpen(false);
      const warnings = result.warnings ?? [];
      setNotice(
        warnings.length > 0
          ? `Event published. ${warnings.join(" ")}`
          : "Event published. Public registration is available during the registration window.",
      );
    } catch (caught) {
      setPublishError(caught instanceof Error ? caught.message : "The event could not be published.");
    } finally {
      setPublishing(false);
    }
  }

  function openUnpublishDialog() {
    setUnpublishError("");
    setUnpublishDialogOpen(true);
  }

  function cancelUnpublish() {
    setUnpublishDialogOpen(false);
    setUnpublishError("");
  }

  async function unpublish() {
    if (unpublishing) return;
    setUnpublishing(true);
    setUnpublishError("");
    try {
      const response = await fetch(`/api/events/${initialEvent!.id}/unpublish`, { method: "POST" });
      const result = await response.json().catch(() => ({})) as EventApiResult;
      if (!response.ok || !result.event) {
        throw new Error(result.message ?? "The event could not be unpublished.");
      }
      setPublished(result.event.isPublished);
      setSetupWarnings(result.event.warnings ?? []);
      setUnpublishDialogOpen(false);
      setNotice("Event unpublished. Every public registration form is now closed.");
    } catch (caught) {
      setUnpublishError(caught instanceof Error ? caught.message : "The event could not be unpublished.");
    } finally {
      setUnpublishing(false);
    }
  }

  async function copyEmbedCode(formSlug: string) {
    const code = buildRegistrationEmbedCode({
      origin: window.location.origin,
      eventSlug: draft.slug,
      formSlug,
      eventName: draft.name,
    });
    try {
      await navigator.clipboard.writeText(code);
      setCopiedFormSlug(formSlug);
      setNotice("Auto-sizing embed code copied. Paste the full block into the website’s Custom HTML area.");
      setError("");
    } catch {
      setError("The embed code could not be copied. Open the embedded form and copy its address instead.");
    }
  }

  const attendeeEditField = (
    <label>
      Attendee edit verification
      <select
        value={draft.attendeeEditPolicy}
        onChange={(event) => update(
          "attendeeEditPolicy",
          event.target.value as EventSettingsInput["attendeeEditPolicy"],
        )}
      >
        <option value="VERIFY_EVERY_EDIT">Email a code for every edit</option>
        <option value="TIERED">Allow low-risk answers without a code</option>
      </select>
      <small>
        Contact changes, cancellations, and transfers always require a fresh emailed
        code. Medical and club data always require an authenticator.
      </small>
    </label>
  );
  const paymentInstructionsField = (
    <label>
      Approved payment instructions
      <textarea
        value={draft.approvedPaymentInstructions ?? ""}
        maxLength={2_000}
        rows={5}
        placeholder="Tell registrants how to pay this event's approved balance."
        onChange={(event) => update("approvedPaymentInstructions", event.target.value || null)}
      />
      <small>
        Versioned event guidance appears only on applicable unpaid messages. Amounts, payment
        state, waitlist, complimentary, and organization-billed wording remain server-derived.
      </small>
    </label>
  );
  const seminarField = (
    <div className="form-grid two-column">
      <label>
        Seminar preference deadline
        <input
          type="date"
          value={draft.seminarPreferenceClosesOn ?? ""}
          onChange={(event) => update(
            "seminarPreferenceClosesOn",
            event.target.value || null,
          )}
        />
        <small>Holders can update ranked seminar preferences through this date in the event timezone.</small>
      </label>
      <label className="event-setting-toggle">
        <input
          type="checkbox"
          checked={draft.seminarPreferenceSelfServiceLocked}
          onChange={(event) => update(
            "seminarPreferenceSelfServiceLocked",
            event.target.checked,
          )}
        />
        <span><strong>Lock seminar preference self-service</strong><small>Current preferences remain visible; staff can still make a documented override.</small></span>
      </label>
    </div>
  );
  const shirtField = (
    <label className="event-setting-toggle">
      <input
        type="checkbox"
        checked={draft.collectsShirtSizes}
        onChange={(event) => update("collectsShirtSizes", event.target.checked)}
      />
      <span>
        <strong>Collect a shirt size for each attendee</strong>
        <small>
          Registrants choose a size on their private page, and staff can send a reviewed
          request to everyone still missing one. Turning this off hides the question and
          stops the request being sent.
        </small>
      </span>
    </label>
  );
  const backgroundField = (
    <label className="event-setting-toggle">
      <input
        type="checkbox"
        checked={draft.checksAdultBackgrounds}
        onChange={(event) => update("checksAdultBackgrounds", event.target.checked)}
      />
      <span>
        <strong>Youth or children&apos;s event: check adults&apos; background checks</strong>
        <small>
          For events where parents aren&apos;t normally there. Every adult registered, club
          staff or not, is flagged until a current Sterling Volunteers check is on file.
          Registration and check-in are never blocked.
        </small>
      </span>
    </label>
  );
  const lodgingPanel = (
    <section className="panel form-stack event-settings-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Optional</p>
          <h2>Lodging</h2>
          <p>
            Rooms held for this event. Registration messages that use the hotel token show
            these details, and leave the section out entirely when the hotel name is blank —
            so an event with no room block never carries another event&rsquo;s hotel.
          </p>
        </div>
        <Globe2 size={21} aria-hidden="true" />
      </div>
      <label>
        Hotel name
        <input value={draft.hotelName ?? ""} maxLength={200} placeholder="Holiday Inn Des Moines – Airport Conference Center" onChange={(event) => update("hotelName", event.target.value || null)} />
        <small>Leave blank for an event with no room block. Everything below is then unused.</small>
      </label>
      <label>
        Reservation link
        <input type="url" value={draft.hotelBookingUrl ?? ""} maxLength={500} placeholder="https://…" onChange={(event) => update("hotelBookingUrl", event.target.value || null)} />
      </label>
      <label>
        Reservation phone
        <input value={draft.hotelPhone ?? ""} maxLength={60} placeholder="(515) 287-2400" onChange={(event) => update("hotelPhone", event.target.value || null)} />
      </label>
      <label>
        Group name to ask for
        <input value={draft.hotelGroupName ?? ""} maxLength={200} placeholder="IA-MO Conference of Seventh-day Adventists Women’s Retreat" onChange={(event) => update("hotelGroupName", event.target.value || null)} />
      </label>
      <label>
        Group rate
        <input value={draft.hotelRate ?? ""} maxLength={120} placeholder="$120 per night plus tax" onChange={(event) => update("hotelRate", event.target.value || null)} />
      </label>
      <label>
        Additional lodging notes
        <textarea value={draft.hotelInstructions ?? ""} rows={3} maxLength={1000} placeholder="Pro tip: share a room with a friend and split the cost." onChange={(event) => update("hotelInstructions", event.target.value || null)} />
        <small>Shown under the reservation details in every message that includes lodging.</small>
      </label>
    </section>
  );

  const eventKind = eventKindFromAudience(draft.audience);
  // Placement follows what was last saved, so typing into a hidden section
  // never moves it out from under the cursor.
  const nonDefaultSections = sectionsWithNonDefaultValues(savedDraft);
  const placementOf = (id: EventSettingsSectionId) =>
    resolveSectionPlacement(id, eventKind, nonDefaultSections);

  const optionFields: Array<{ id: EventSettingsSectionId; node: React.ReactNode }> = [
    { id: "attendee-edit-policy", node: attendeeEditField },
    { id: "payment-instructions", node: paymentInstructionsField },
    { id: "seminar-preferences", node: seminarField },
    { id: "shirt-sizes", node: shirtField },
    { id: "adult-background-checks", node: backgroundField },
  ];
  const optionalFields = {
    primary: optionFields.filter((field) => placementOf(field.id) === "primary"),
    more: optionFields.filter((field) => placementOf(field.id) === "more"),
  };
  const lodgingInMore = placementOf("lodging") === "more";

  return (
    <section className="page-stack event-settings-workspace">
      {mode === "edit" && initialEvent && (
        <DraftCreatedGuideBanner eventId={initialEvent.id} />
      )}
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
        <span className={`count-badge ${published ? "green" : ""}`}>
          <ShieldCheck size={16} aria-hidden="true" />
          {published ? "Published" : "Private draft"}
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
            <label>
              Audience
              <select
                value={draft.audience}
                onChange={(event) => update(
                  "audience",
                  event.target.value as EventSettingsInput["audience"],
                )}
              >
                <option value="GENERAL">General event</option>
                <option value="CLUB">Club or church event</option>
              </select>
              <small>
                Controls Clubs and churches navigation, club oversight, and club reports —
                Club registration uses church billing. For an event where individuals pay
                (for example Man Camp), choose General.
              </small>
            </label>
            <label>
              Billing mode
              <select
                value={draft.billingMode}
                onChange={(event) => update(
                  "billingMode",
                  event.target.value as EventSettingsInput["billingMode"],
                )}
              >
                <option value="ATTENDEE_PAY">Attendees pay online</option>
                <option value="DEFERRED_ORGANIZATION_INVOICE">Bill the responsible organization later</option>
              </select>
              <small>
                Club/church group events such as Spring Camporee: registration shows informational
                rates only, no attendee balance or online payment is created, and the responsible
                organization is billed later based on final attendance.
              </small>
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

          {optionalFields.primary.length > 0 && <section className="panel form-stack event-settings-panel">
            <div className="section-heading">
              <div><p className="eyebrow">Options</p><h2>Registration options</h2><p>Settings that apply to this kind of event.</p></div>
            </div>
            {optionalFields.primary.map((field) => <div className="event-settings-option" key={field.id}>{field.node}</div>)}
          </section>}


          <section className="panel form-stack event-settings-panel">
            <div className="section-heading">
              <div><p className="eyebrow">Step 3</p><h2>Public information &amp; help</h2><p>Event information lives on IMSDA Events. Link an IMSDA.org page too only if one still exists for this event.</p></div>
              <Globe2 size={21} aria-hidden="true" />
            </div>
            <label>
              IMSDA.org event page (optional)
              <input type="url" value={draft.publicInfoUrl ?? ""} maxLength={500} placeholder="https://imsda.org/event/your-event/" onChange={(event) => update("publicInfoUrl", event.target.value || null)} />
              <small>Not required to publish. Leave blank when schedules, speakers, and event details live only on this event&rsquo;s IMSDA Events page.</small>
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


          {!lodgingInMore && lodgingPanel}

          {(optionalFields.more.length > 0 || lodgingInMore) && (
            <details className="panel event-more-settings">
              <summary>
                <strong>More settings</strong>
                <small>Settings that do not apply to {eventKind === "club" ? "club" : "general"} events. They are kept, not removed.</small>
              </summary>
              <div className="form-stack">
                {optionalFields.more.map((field) => <div className="event-settings-option" key={field.id}>{field.node}</div>)}
                {lodgingInMore && lodgingPanel}
              </div>
            </details>
          )}
        </div>

        <aside className="event-settings-side">
          <section className="panel event-readiness-panel" id="event-readiness-panel">
            <p className="eyebrow">Publish readiness</p>
            <h2>{readiness.ready ? "Ready to publish" : `${readiness.completedCount} of ${readiness.items.length} ready`}</h2>
            <p>Publishing turns on the event’s public registration links. Form versions and registration dates still control what attendees can submit.</p>
            {mode === "edit" && dirty && <p className="field-help">This checklist reflects the saved settings. Save your changes to update it.</p>}
            <ul className="event-readiness-list">
              {readiness.items.map((item) => (
                <li className={item.complete ? "complete" : ""} key={item.id}>
                  {item.complete ? <CheckCircle2 size={18} aria-hidden="true" /> : <span aria-hidden="true" />}
                  <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                </li>
              ))}
            </ul>
            {/* Never blocks publish (#575): a warning only. */}
            {!published && publishWarnings.map((warning) => (
              <div className="inline-notice clone-warning" key={warning} role="status"><AlertTriangle size={17} aria-hidden="true" /> {warning}</div>
            ))}
            {/* Never blocks publish (#593): dates and fees staff still need to set. */}
            {setupWarnings.map((warning) => (
              <div className="inline-notice clone-warning" key={warning.id} role="status"><AlertTriangle size={17} aria-hidden="true" /> <span><strong>{warning.label}.</strong> {warning.detail}{warning.href ? <>{" "}<Link href={warning.href}>Open the registration builder</Link></> : null}</span></div>
            ))}
            {/* Never blocks publish (#467): shown for visibility only. */}
            <p className="event-readiness-optional-heading">Optional</p>
            <ul className="event-readiness-list event-readiness-optional">
              {readiness.optionalItems.map((item) => (
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
              // Publishing and unpublishing are their own actions (#471), each
              // its own request the instant it's clicked — never folded into
              // the settings save below, so unpublishing can't happen as a
              // side effect of an unrelated save.
              <div className={`event-publish-toggle ${readiness.ready ? "ready" : ""}`}>
                <span>
                  <strong>{published ? "Public registration is on" : "Publish this event"}</strong>
                  <small>
                    {published
                      ? "Unpublish to close every public form immediately."
                      : publishBlockedBySave
                        ? "Save your changes first. Publishing checks the saved settings."
                        : "Available after every checklist item is complete."}
                  </small>
                </span>
                {published ? (
                  <button className="secondary-button full-button" disabled={unpublishing} onClick={openUnpublishDialog} type="button">
                    Unpublish event
                  </button>
                ) : (
                  <button className="primary-button full-button" disabled={!canPublish} onClick={openPublishDialog} type="button">
                    {publishing ? "Publishing…" : "Publish event"}
                  </button>
                )}
              </div>
            )}
          </section>

          {mode === "edit" && (
            <section className="panel event-sharing-panel">
              <p className="eyebrow">Website sharing</p>
              <h2>Public registration</h2>
              {published && initialEvent?.publishedForms.length ? (
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
                  <small className="event-embed-note"><Code2 size={14} aria-hidden="true" /> The full block includes automatic height and scroll handling. It works only on domains allowed by the deployment’s embed policy.</small>
                </>
              ) : (
                <p>Publish the event and at least one registration form to unlock its public link and website embed code.</p>
              )}
            </section>
          )}

          {mode === "edit" && initialEvent && (
            <section className="panel event-delete-panel">
              <p className="eyebrow">Danger zone</p>
              <h2>Delete this event</h2>
              <p>Permanently removes the event and everything it owns, whatever its state. You will see exactly what is removed before you confirm.</p>
              <button className="secondary-button full-button lifecycle-danger-button" onClick={() => setDeleteDialogOpen(true)} type="button">
                Delete event…
              </button>
            </section>
          )}

          <section className="panel event-save-panel">
            <p>{mode === "create" ? "Nothing is public when this draft is created." : "Saving never changes whether this event is published — use Publish or Unpublish above for that."}</p>
            {dirty && <span className="unsaved-dot" role="status">Unsaved changes</span>}
            <button className="primary-button full-button" type="submit" disabled={saving || !dirty}>
              <Save size={16} aria-hidden="true" />
              {saving ? "Saving…" : mode === "create" ? "Create event draft" : "Save event settings"}
            </button>
          </section>
        </aside>
      </form>
      {mode === "edit" && initialEvent && (
        <EventLocationsPanel eventId={initialEvent.id} initialLocations={initialLocations ?? []} areaCoordinators={areaCoordinators ?? []} />
      )}
      {mode === "edit" && (
        <PublishEventDialog
          busy={publishing}
          eventName={initialEvent?.name ?? draft.name}
          error={publishError}
          warnings={publishWarnings}
          onCancel={cancelPublish}
          onConfirm={() => void publish()}
          open={publishDialogOpen}
        />
      )}
      {mode === "edit" && initialEvent && (
        <DeleteEventDialog
          eventId={initialEvent.id}
          onCancel={() => setDeleteDialogOpen(false)}
          open={deleteDialogOpen}
        />
      )}
      {mode === "edit" && (
        <UnpublishEventDialog
          busy={unpublishing}
          eventName={initialEvent?.name ?? draft.name}
          error={unpublishError}
          onCancel={cancelUnpublish}
          onConfirm={() => void unpublish()}
          open={unpublishDialogOpen}
        />
      )}
    </section>
  );
}
