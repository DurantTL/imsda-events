"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Trash2, UserPlus, UsersRound } from "lucide-react";
import {
  PublicRegistrationForm,
  type FormResponses,
  type RosterAttendee,
} from "@/components/public-registration-form";
import { clubRosterAttendeeTypeLabels } from "@/modules/club-rosters/domain";
import {
  clubGuestClientId,
  formatCalendarDate,
  guestIdFromClientId,
  guestIsAdult,
  MAX_CLUB_GUESTS,
  rosterMemberIdFromClientId,
  rosterOwnedResponses,
  rosterRolePrefill,
  type ClubGuest,
} from "@/modules/club-registrations/domain";
import type { ClubEventWorkspace } from "@/modules/club-registrations/repository";
import type { PublicRegistrationExperience } from "@/modules/forms/public-repository";

type Workspace = ClubEventWorkspace & { experience: PublicRegistrationExperience };

type DraftState = {
  selectedMemberIds: string[];
  guests: ClubGuest[];
  responses: FormResponses;
  attendeeResponses: Record<string, FormResponses>;
};

export function ClubRegistrationWorkspace({
  contactPrefill,
  organizationId,
  workspace,
}: {
  contactPrefill: Record<string, string>;
  organizationId: string;
  workspace: Workspace;
}) {
  const router = useRouter();
  const rosterIds = useMemo(() => new Set(workspace.roster.map((person) => person.memberId)), [workspace.roster]);
  const [draft, setDraft] = useState<DraftState>(() => ({
    selectedMemberIds: (workspace.draft?.selectedMemberIds ?? []).filter((memberId) => rosterIds.has(memberId)),
    guests: workspace.draft?.guests ?? [],
    responses: (workspace.draft?.responses as FormResponses | undefined) ?? contactPrefill,
    attendeeResponses: (workspace.draft?.attendeeResponses as Record<string, FormResponses> | undefined) ?? {},
  }));
  const [step, setStep] = useState<"who" | "form">("who");
  const [addingGuest, setAddingGuest] = useState(false);
  const [guestError, setGuestError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">(workspace.draft ? "saved" : "idle");
  const pending = useRef<DraftState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const base = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(workspace.event.id)}`;

  const flush = useCallback(async () => {
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    setSaveState("saving");
    try {
      const response = await fetch(`${base}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      setSaveState(response.ok ? "saved" : "error");
    } catch {
      setSaveState("error");
    }
  }, [base]);

  const queueSave = useCallback((next: DraftState) => {
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, 1200);
  }, [flush]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function toggle(memberId: string) {
    setDraft((current) => {
      const selected = current.selectedMemberIds.includes(memberId)
        ? current.selectedMemberIds.filter((id) => id !== memberId)
        : [...current.selectedMemberIds, memberId];
      const next = { ...current, selectedMemberIds: selected };
      queueSave(next);
      return next;
    });
  }

  function selectAll(all: boolean) {
    setDraft((current) => {
      const next = { ...current, selectedMemberIds: all ? workspace.roster.map((person) => person.memberId) : [] };
      queueSave(next);
      return next;
    });
  }

  const selected = workspace.roster.filter((person) => draft.selectedMemberIds.includes(person.memberId));
  const goingCount = selected.length + draft.guests.length;

  function addGuest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const firstName = String(data.get("firstName") ?? "").trim();
    const lastName = String(data.get("lastName") ?? "").trim();
    const age = Number(data.get("age"));
    const email = String(data.get("email") ?? "").trim().toLowerCase();
    if (!firstName || !lastName) return setGuestError("Enter a first and last name.");
    if (!Number.isInteger(age) || age < 0 || age > 120) return setGuestError("Enter their age as a whole number.");
    if (draft.guests.length >= MAX_CLUB_GUESTS) return setGuestError(`Add up to ${MAX_CLUB_GUESTS} extra people.`);
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => (byte % 36).toString(36)).join("") + Date.now().toString(36);
    setGuestError("");
    setAddingGuest(false);
    setDraft((current) => {
      const next = { ...current, guests: [...current.guests, { id: id.slice(0, 24), firstName, lastName, age, email: email || null }] };
      queueSave(next);
      return next;
    });
  }

  function removeGuest(guestId: string) {
    setDraft((current) => {
      const key = clubGuestClientId(guestId);
      const attendeeResponses = Object.fromEntries(Object.entries(current.attendeeResponses).filter(([candidate]) => candidate !== key));
      const next = { ...current, guests: current.guests.filter((guest) => guest.id !== guestId), attendeeResponses };
      queueSave(next);
      return next;
    });
  }

  const initialAttendees: RosterAttendee[] = useMemo(() => [
    ...selected.map((person) => ({
      clientId: person.clientId,
      responses: {
        ...(person.prefillResponses as FormResponses),
        ...(draft.attendeeResponses[person.memberId] ?? {}),
        ...(person.ownedResponses as FormResponses),
      },
    })),
    // Extra people: names and age come from Who's going, like roster people.
    ...draft.guests.map((guest) => {
      const clientId = clubGuestClientId(guest.id);
      const definition = workspace.experience.form.definition;
      return {
        clientId,
        responses: {
          ...(rosterRolePrefill(definition, {
            firstName: guest.firstName, lastName: guest.lastName, ageOnEventDate: guest.age, gender: null,
            attendeeType: guestIsAdult(guest) ? "ADULT" : undefined,
          }) as FormResponses),
          ...(draft.attendeeResponses[clientId] ?? {}),
          ...(rosterOwnedResponses(definition, {
            firstName: guest.firstName, lastName: guest.lastName, ageOnEventDate: guest.age, gender: null,
          }) as FormResponses),
        },
      };
    }),
  ],
  // Built once per visit to the form step; later edits live in the form itself.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [step]);

  const onDraftChange = useCallback((form: { responses: FormResponses; attendees: RosterAttendee[] }) => {
    setDraft((current) => {
      const attendeeResponses = { ...current.attendeeResponses };
      for (const attendee of form.attendees) {
        const memberId = rosterMemberIdFromClientId(attendee.clientId);
        if (memberId) attendeeResponses[memberId] = attendee.responses;
        else if (guestIdFromClientId(attendee.clientId)) attendeeResponses[attendee.clientId] = attendee.responses;
      }
      const next = { ...current, responses: form.responses, attendeeResponses };
      queueSave(next);
      return next;
    });
  }, [queueSave]);

  const club = useMemo(() => ({
    initialAttendees,
    lockedAttendeeFieldKeys: workspace.lockedAttendeeFieldKeys,
    submitUrl: `${base}/registration`,
    onDraftChange,
    onSubmitted: () => {
      if (timer.current) clearTimeout(timer.current);
      pending.current = null;
      router.refresh();
    },
  }), [initialAttendees, workspace.lockedAttendeeFieldKeys, base, onDraftChange, router]);

  const saveLabel = saveState === "saving" ? "Saving draft…" : saveState === "saved" ? "Draft saved" : saveState === "error" ? "Draft not saved. Check your connection." : "";

  if (step === "form") {
    const { experience } = workspace;
    return (
      <div className="club-roster-stack">
        <div className="club-registration-toolbar">
          <button className="secondary-button" onClick={() => { void flush(); setStep("who"); }} type="button">
            <ArrowLeft aria-hidden="true" size={15} /> Change who&apos;s going
          </button>
          <span className="public-registration-eyebrow">Step 2 of 3 · Event form</span>
          <span className="field-help" role="status">{saveLabel}</span>
        </div>
        <PublicRegistrationForm
          choiceUsage={experience.choiceUsage}
          club={club}
          event={experience.event}
          form={experience.form}
          initialResponses={draft.responses}
          lifecycle={experience.lifecycle}
          pricingDate={experience.pricingDate}
        />
      </div>
    );
  }

  return (
    <section className="public-manage-card">
      <div className="public-manage-card-heading club-roster-heading">
        <div>
          <p className="public-registration-eyebrow">Step 1 of 3 · Who&apos;s going</p>
          <h2>Who&apos;s going?</h2>
        </div>
        <span className="count-badge">{goingCount} chosen</span>
      </div>
      <p>
        Tap everyone from your roster who is attending. Ages are as of the first day of the
        event, {formatCalendarDate(workspace.event.eventDate)}. Your choices save automatically.
      </p>
      {workspace.roster.length === 0 ? (
        <p className="public-manage-empty">
          <UsersRound size={17} aria-hidden="true" /> Your roster is empty. Add your club members first.
        </p>
      ) : (
        <>
          <div className="club-roster-tools">
            <span>
              <button className="text-button" onClick={() => selectAll(true)} type="button">Select everyone</button>
              {" · "}
              <button className="text-button" onClick={() => selectAll(false)} type="button">Clear</button>
            </span>
            <span className="field-help" role="status">{saveLabel}</span>
          </div>
          <ul className="club-going-list">
            {workspace.roster.map((person) => (
              <li key={person.memberId}>
                <label className="checkbox-label">
                  <input
                    checked={draft.selectedMemberIds.includes(person.memberId)}
                    onChange={() => toggle(person.memberId)}
                    type="checkbox"
                  />
                  <span>
                    <strong translate="no">{person.lastName}, {person.firstName}</strong>
                    <small>
                      {clubRosterAttendeeTypeLabels[person.attendeeType]}
                      {person.role ? ` · ${person.role}` : ""}
                      {person.ageOnEventDate !== null ? <> · Age <span translate="no">{person.ageOnEventDate}</span></> : ""}
                    </small>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      <section className="club-guest-section" aria-labelledby="club-guests-title">
        <div className="club-roster-tools">
          <span>
            <strong id="club-guests-title">Not on your roster</strong>
            <small className="field-help"> For this event only, e.g. a parent driver. They won&apos;t be added to your roster.</small>
          </span>
          {!addingGuest && (
            <button className="text-button" onClick={() => { setGuestError(""); setAddingGuest(true); }} type="button">
              <UserPlus aria-hidden="true" size={14} /> Add a person for this event
            </button>
          )}
        </div>
        {draft.guests.length > 0 && (
          <ul className="club-going-list club-guest-list">
            {draft.guests.map((guest) => (
              <li key={guest.id}>
                <span>
                  <strong translate="no">{guest.lastName}, {guest.firstName}</strong>
                  <small>
                    This event only · Age <span translate="no">{guest.age}</span>
                    {guest.email ? <> · <span translate="no">{guest.email}</span></> : ""}
                  </small>
                </span>
                <button aria-label={`Remove ${guest.firstName} ${guest.lastName}`} className="text-button" onClick={() => removeGuest(guest.id)} type="button">
                  <Trash2 aria-hidden="true" size={14} /> Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {addingGuest && (
          <form className="club-guest-form" onSubmit={addGuest}>
            {guestError && <div className="inline-notice error" role="alert">{guestError}</div>}
            <div className="form-grid two-column">
              <label>First name<input autoComplete="off" maxLength={80} name="firstName" required /></label>
              <label>Last name<input autoComplete="off" maxLength={80} name="lastName" required /></label>
              <label>Age at the event<input inputMode="numeric" max={120} min={0} name="age" required type="number" /></label>
              <label>
                Email (optional)
                <input autoComplete="off" maxLength={254} name="email" type="email" />
                <small className="field-help">Adults at youth events need a background check; an email helps match it.</small>
              </label>
            </div>
            <div className="club-registration-toolbar">
              <button className="secondary-button" onClick={() => { setGuestError(""); setAddingGuest(false); }} type="button">Cancel</button>
              <button className="primary-button" type="submit"><UserPlus aria-hidden="true" size={15} /> Add</button>
            </div>
          </form>
        )}
      </section>

      <div className="club-registration-toolbar club-sticky-bar">
        <Link className="secondary-button" href={`/account/clubs/${organizationId}`} onClick={() => { void flush(); }}>
          <UserPlus aria-hidden="true" size={15} /> Add someone new to the roster
        </Link>
        <button
          className="primary-button"
          disabled={goingCount === 0}
          onClick={() => { void flush(); setStep("form"); }}
          type="button"
        >
          Continue with {goingCount} {goingCount === 1 ? "person" : "people"} <ArrowRight aria-hidden="true" size={15} />
        </button>
      </div>
    </section>
  );
}
