"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Pencil, Trash2, UserPlus, X } from "lucide-react";
import {
  PublicRegistrationForm,
  type FormIssue,
  type FormResponses,
  type RosterAttendee,
} from "@/components/public-registration-form";
import {
  clubAttendeeClientId,
  clubExistingAttendeeClientId,
  clubGuestClientId,
  guestIsAdult,
  MAX_CLUB_GUESTS,
  rosterOwnedResponses,
  rosterRolePrefill,
  type ClubGuest,
} from "@/modules/club-registrations/domain";
import type { ClubEventWorkspace } from "@/modules/club-registrations/repository";

type Workspace = ClubEventWorkspace & { registration: NonNullable<ClubEventWorkspace["registration"]>; experience: NonNullable<ClubEventWorkspace["experience"]> };

/**
 * Reopens a submitted club registration (H3b, #366) before the event's
 * registration deadline. Step one re-ticks who's going: roster people, the
 * people registered who are no longer on the roster (kept unless unticked),
 * and extra people. Step two is the event's own form for those people, the
 * same one used to submit, pre-filled with their current answers; names and
 * age stay locked to the roster. Saves through the club edit endpoint, which
 * runs the change through the same amendment engine staff use.
 */
export function ClubRegistrationEditor({ organizationId, workspace }: { organizationId: string; workspace: Workspace }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"who" | "form">("who");
  const [addingGuest, setAddingGuest] = useState(false);
  const [error, setError] = useState("");
  const definition = workspace.experience.form.definition;

  const registered = workspace.registration.attendees;
  const offRoster = useMemo(() => registered.filter((attendee) => attendee.offRoster), [registered]);
  const existingGuests = useMemo(() => registered.filter((attendee) => attendee.temporary && attendee.guestId), [registered]);
  const registeredByMemberId = useMemo(() => new Map(
    registered.flatMap((attendee) => attendee.clubRosterMemberId && !attendee.offRoster ? [[attendee.clubRosterMemberId, attendee] as const] : []),
  ), [registered]);

  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>(() => (
    workspace.roster.map((person) => person.memberId).filter((memberId) => registeredByMemberId.has(memberId))
  ));
  // No silent removal: everyone registered who left the roster stays ticked.
  const [keptOffRosterIds, setKeptOffRosterIds] = useState<string[]>(() => offRoster.map((attendee) => attendee.attendeeId));
  const [keptGuestIds, setKeptGuestIds] = useState<string[]>(() => existingGuests.map((guest) => guest.guestId!));
  const [newGuests, setNewGuests] = useState<ClubGuest[]>([]);
  // Answers edited in step two, kept if the director goes back to step one.
  const [answers, setAnswers] = useState<Record<string, FormResponses>>({});

  function toggle(list: string[], id: string) {
    return list.includes(id) ? list.filter((candidate) => candidate !== id) : [...list, id];
  }

  function addGuest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const firstName = String(data.get("firstName") ?? "").trim();
    const lastName = String(data.get("lastName") ?? "").trim();
    const age = Number(data.get("age"));
    const email = String(data.get("email") ?? "").trim().toLowerCase();
    if (!firstName || !lastName) return setError("Enter a first and last name.");
    if (!Number.isInteger(age) || age < 0 || age > 120) return setError("Enter their age as a whole number.");
    if (keptGuestIds.length + newGuests.length >= MAX_CLUB_GUESTS) return setError(`Add up to ${MAX_CLUB_GUESTS} extra people.`);
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => (byte % 36).toString(36)).join("") + Date.now().toString(36);
    setError("");
    setAddingGuest(false);
    setNewGuests((current) => [...current, { id: id.slice(0, 24), firstName, lastName, age, email: email || null }]);
  }

  const goingCount = selectedMemberIds.length + keptOffRosterIds.length + keptGuestIds.length + newGuests.length;

  // The people going, in the same form the club submit uses, pre-filled
  // with their current answers (or the roster's starting answers if new).
  const initialAttendees: RosterAttendee[] = useMemo(() => {
    const withEdits = (clientId: string, base: Record<string, unknown>, owned: Record<string, unknown> = {}) => ({
      clientId,
      responses: { ...(base as FormResponses), ...(answers[clientId] ?? {}), ...(owned as FormResponses) },
    });
    return [
      ...workspace.roster.filter((person) => selectedMemberIds.includes(person.memberId)).map((person) => {
        const current = registeredByMemberId.get(person.memberId);
        return withEdits(clubAttendeeClientId(person.memberId), current ? current.responses : person.prefillResponses, person.ownedResponses);
      }),
      ...offRoster.filter((attendee) => keptOffRosterIds.includes(attendee.attendeeId))
        .map((attendee) => withEdits(clubExistingAttendeeClientId(attendee.attendeeId), attendee.responses)),
      ...existingGuests.filter((guest) => keptGuestIds.includes(guest.guestId!))
        .map((guest) => withEdits(clubGuestClientId(guest.guestId!), guest.responses)),
      ...newGuests.map((guest) => {
        const person = { firstName: guest.firstName, lastName: guest.lastName, ageOnEventDate: guest.age, gender: null };
        return withEdits(
          clubGuestClientId(guest.id),
          rosterRolePrefill(definition, { ...person, attendeeType: guestIsAdult(guest) ? "ADULT" : "YOUTH" }),
          rosterOwnedResponses(definition, person),
        );
      }),
    ];
  // Built once per visit to the form step; later edits live in the form itself.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Only the people's questions: the registration's contact and payment
  // answers aren't changed by this edit.
  const attendeeForm = useMemo(() => ({
    ...workspace.experience.form,
    definition: {
      ...definition,
      sections: definition.sections
        .map((section) => ({ ...section, fields: section.fields.filter((field) => field.scope === "ATTENDEE") }))
        .filter((section) => section.fields.length > 0),
    },
  }), [workspace.experience.form, definition]);

  const onDraftChange = useCallback((form: { attendees: RosterAttendee[] }) => {
    setAnswers((current) => ({
      ...current,
      ...Object.fromEntries(form.attendees.map((attendee) => [attendee.clientId, attendee.responses])),
    }));
  }, []);

  const submitEdit = useCallback(async (attendees: RosterAttendee[]) => {
    const response = await fetch(
      `/api/attendee/clubs/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(workspace.event.id)}/registration`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId: crypto.randomUUID(),
          expectedUpdatedAt: workspace.registration.updatedAt,
          selectedMemberIds,
          keptOffRosterAttendeeIds: keptOffRosterIds,
          keptGuestIds,
          newGuests,
          attendeeResponses: Object.fromEntries(attendees.map((attendee) => [attendee.clientId, attendee.responses])),
        }),
      },
    );
    if (response.ok) return { ok: true as const };
    const result = await response.json().catch(() => ({})) as {
      message?: string;
      issues?: Array<{ key?: unknown; message?: unknown; clientId?: unknown }>;
    };
    const issues: FormIssue[] = (Array.isArray(result.issues) ? result.issues : []).flatMap((issue) => {
      if (typeof issue.key !== "string" || typeof issue.message !== "string") return [];
      const index = typeof issue.clientId === "string" ? attendees.findIndex((attendee) => attendee.clientId === issue.clientId) : -1;
      return [index >= 0
        ? { key: issue.key, message: issue.message, path: `attendees.${index}.responses.${issue.key}`, attendeeIndex: index }
        : { key: issue.key, message: issue.message, attendeeIndex: null }];
    });
    return { ok: false as const, message: result.message ?? "That change couldn't be saved. Refresh and try again.", issues };
  }, [organizationId, workspace.event.id, workspace.registration.updatedAt, selectedMemberIds, keptOffRosterIds, keptGuestIds, newGuests]);

  const club = useMemo(() => ({
    initialAttendees,
    lockedAttendeeFieldKeys: workspace.lockedAttendeeFieldKeys,
    submitUrl: "",
    onDraftChange,
    submitEdit,
    submitLabel: "Save changes",
    onSubmitted: () => {
      setOpen(false);
      setStep("who");
      router.refresh();
    },
  }), [initialAttendees, workspace.lockedAttendeeFieldKeys, onDraftChange, submitEdit, router]);

  if (!open) {
    return (
      <button className="secondary-button" onClick={() => setOpen(true)} type="button">
        <Pencil aria-hidden="true" size={14} /> Reopen to add or remove people
      </button>
    );
  }

  if (step === "form") {
    const { experience } = workspace;
    return (
      <div className="club-roster-stack">
        <div className="club-registration-toolbar">
          <button className="secondary-button" onClick={() => setStep("who")} type="button">
            <ArrowLeft aria-hidden="true" size={15} /> Change who&apos;s going
          </button>
          <span className="public-registration-eyebrow">Step 2 of 2 · Their answers</span>
        </div>
        <PublicRegistrationForm
          choiceUsage={experience.choiceUsage}
          club={club}
          event={experience.event}
          form={attendeeForm}
          initialResponses={workspace.registration.registrationResponses as FormResponses}
          lifecycle={{ ...experience.lifecycle, capacityDecision: "REGISTER" }}
          pricingDate={experience.pricingDate}
        />
      </div>
    );
  }

  return (
    <section aria-labelledby="club-edit-title" className="public-manage-card">
      <div className="public-manage-card-heading club-roster-heading">
        <div>
          <p className="public-registration-eyebrow">Step 1 of 2 · Who&apos;s going</p>
          <h2 id="club-edit-title">Add or remove people</h2>
          <p className="field-help">
            Re-tick who&apos;s going. Next you can check and change their answers.
          </p>
        </div>
        <span className="count-badge">{goingCount} chosen</span>
      </div>
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <ul className="club-going-list">
        {workspace.roster.map((person) => (
          <li key={person.memberId}>
            <label className="checkbox-label">
              <input
                checked={selectedMemberIds.includes(person.memberId)}
                onChange={() => setSelectedMemberIds((current) => toggle(current, person.memberId))}
                type="checkbox"
              />
              <span>
                <strong translate="no">{person.lastName}, {person.firstName}</strong>
                {person.ageOnEventDate !== null && <small>Age <span translate="no">{person.ageOnEventDate}</span></small>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {offRoster.length > 0 && (
        <section className="club-guest-section" aria-labelledby="club-edit-off-roster-title">
          <div className="club-roster-tools">
            <span>
              <strong id="club-edit-off-roster-title">No longer on your club roster</strong>
              <small className="field-help"> Registered, but since removed from your roster. Untick anyone who isn&apos;t going.</small>
            </span>
          </div>
          <ul className="club-going-list">
            {offRoster.map((attendee) => (
              <li key={attendee.attendeeId}>
                <label className="checkbox-label">
                  <input
                    checked={keptOffRosterIds.includes(attendee.attendeeId)}
                    onChange={() => setKeptOffRosterIds((current) => toggle(current, attendee.attendeeId))}
                    type="checkbox"
                  />
                  <span>
                    <strong translate="no">{attendee.lastName}, {attendee.firstName}</strong>
                    {attendee.ageOnEventDate !== null && <small>Age <span translate="no">{attendee.ageOnEventDate}</span></small>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="club-guest-section" aria-labelledby="club-edit-guests-title">
        <div className="club-roster-tools">
          <span>
            <strong id="club-edit-guests-title">Not on your roster</strong>
            <small className="field-help"> For this event only.</small>
          </span>
          {!addingGuest && (
            <button className="text-button" onClick={() => { setError(""); setAddingGuest(true); }} type="button">
              <UserPlus aria-hidden="true" size={14} /> Add a person for this event
            </button>
          )}
        </div>
        {(existingGuests.length > 0 || newGuests.length > 0) && (
          <ul className="club-going-list club-guest-list">
            {existingGuests.map((guest) => keptGuestIds.includes(guest.guestId!) && (
              <li key={guest.guestId}>
                <span>
                  <strong translate="no">{guest.lastName}, {guest.firstName}</strong>
                  <small>This event only{guest.ageOnEventDate !== null ? <> · Age <span translate="no">{guest.ageOnEventDate}</span></> : ""}</small>
                </span>
                <button aria-label={`Remove ${guest.firstName} ${guest.lastName}`} className="text-button" onClick={() => setKeptGuestIds((current) => current.filter((id) => id !== guest.guestId))} type="button">
                  <Trash2 aria-hidden="true" size={14} /> Remove
                </button>
              </li>
            ))}
            {newGuests.map((guest) => (
              <li key={guest.id}>
                <span>
                  <strong translate="no">{guest.lastName}, {guest.firstName}</strong>
                  <small>This event only · Age <span translate="no">{guest.age}</span></small>
                </span>
                <button aria-label={`Remove ${guest.firstName} ${guest.lastName}`} className="text-button" onClick={() => setNewGuests((current) => current.filter((candidate) => candidate.id !== guest.id))} type="button">
                  <Trash2 aria-hidden="true" size={14} /> Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {addingGuest && (
          <form className="club-guest-form" onSubmit={addGuest}>
            <div className="form-grid two-column">
              <label>First name<input autoComplete="off" maxLength={80} name="firstName" required /></label>
              <label>Last name<input autoComplete="off" maxLength={80} name="lastName" required /></label>
              <label>Age at the event<input inputMode="numeric" max={120} min={0} name="age" required type="number" /></label>
              <label>Email (optional)<input autoComplete="off" maxLength={254} name="email" type="email" /></label>
            </div>
            <div className="club-registration-toolbar">
              <button className="secondary-button" onClick={() => { setError(""); setAddingGuest(false); }} type="button">Cancel</button>
              <button className="primary-button" type="submit"><UserPlus aria-hidden="true" size={15} /> Add</button>
            </div>
          </form>
        )}
      </section>
      <div className="club-registration-toolbar">
        <button className="secondary-button" onClick={() => setOpen(false)} type="button">
          <X aria-hidden="true" size={15} /> Cancel
        </button>
        <button
          className="primary-button"
          disabled={goingCount === 0}
          onClick={() => { setError(""); setStep("form"); }}
          type="button"
        >
          Continue with {goingCount} {goingCount === 1 ? "person" : "people"} <ArrowRight aria-hidden="true" size={15} />
        </button>
      </div>
    </section>
  );
}
