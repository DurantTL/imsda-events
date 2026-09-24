"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2, UserPlus, X } from "lucide-react";
import {
  clubAttendeeClientId,
  clubGuestClientId,
  guestIsAdult,
  MAX_CLUB_GUESTS,
  rosterRolePrefill,
  type ClubGuest,
} from "@/modules/club-registrations/domain";
import type { ClubEventWorkspace } from "@/modules/club-registrations/repository";

type Workspace = ClubEventWorkspace & { registration: NonNullable<ClubEventWorkspace["registration"]>; experience: NonNullable<ClubEventWorkspace["experience"]> };

/**
 * Reopens a submitted club registration (H3b, #366) so the director can
 * re-tick who's going and add or remove extra people, before the event's
 * registration deadline. Commits through the club edit endpoint, which runs
 * the change through the same amendment engine staff use. Editing an
 * attendee's other answers isn't in this editor yet — a kept person's prior
 * answers travel through unchanged.
 */
export function ClubRegistrationEditor({ organizationId, workspace }: { organizationId: string; workspace: Workspace }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [addingGuest, setAddingGuest] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const existingGuests = useMemo(() => workspace.registration.attendees
    .map((attendee, index) => ({ ...attendee, index }))
    .filter((attendee) => attendee.temporary && attendee.guestId), [workspace.registration.attendees]);
  const existingMemberIds = useMemo(() => new Set(
    workspace.registration.attendees.flatMap((attendee) => attendee.clubRosterMemberId ? [attendee.clubRosterMemberId] : []),
  ), [workspace.registration.attendees]);

  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>(() => (
    workspace.roster.map((person) => person.memberId).filter((memberId) => existingMemberIds.has(memberId))
  ));
  const [keptGuestIds, setKeptGuestIds] = useState<string[]>(() => (
    existingGuests.map((guest) => guest.guestId!)
  ));
  const [newGuests, setNewGuests] = useState<ClubGuest[]>([]);

  function toggleMember(memberId: string) {
    setSelectedMemberIds((current) => (
      current.includes(memberId) ? current.filter((id) => id !== memberId) : [...current, memberId]
    ));
  }

  function removeKeptGuest(guestId: string) {
    setKeptGuestIds((current) => current.filter((id) => id !== guestId));
  }

  function removeNewGuest(guestId: string) {
    setNewGuests((current) => current.filter((guest) => guest.id !== guestId));
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

  const goingCount = selectedMemberIds.length + keptGuestIds.length + newGuests.length;

  async function save() {
    if (goingCount === 0) return setError("Choose at least one person from your roster.");
    setSaving(true);
    setError("");
    try {
      const definition = workspace.experience.form.definition;
      const attendeeResponses: Record<string, Record<string, unknown>> = {};
      for (const attendee of workspace.registration.attendees) {
        const clientId = attendee.clubRosterMemberId
          ? clubAttendeeClientId(attendee.clubRosterMemberId)
          : attendee.guestId
            ? clubGuestClientId(attendee.guestId)
            : null;
        if (clientId) attendeeResponses[clientId] = attendee.responses;
      }
      for (const memberId of selectedMemberIds) {
        const clientId = clubAttendeeClientId(memberId);
        if (attendeeResponses[clientId]) continue;
        const person = workspace.roster.find((candidate) => candidate.memberId === memberId);
        if (person) attendeeResponses[clientId] = person.prefillResponses as Record<string, unknown>;
      }
      for (const guest of newGuests) {
        attendeeResponses[clubGuestClientId(guest.id)] = rosterRolePrefill(definition, {
          firstName: guest.firstName, lastName: guest.lastName, ageOnEventDate: guest.age, gender: null,
          attendeeType: guestIsAdult(guest) ? "ADULT" : undefined,
        }) as Record<string, unknown>;
      }
      const response = await fetch(
        `/api/attendee/clubs/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(workspace.event.id)}/registration`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientRequestId: crypto.randomUUID(),
            expectedUpdatedAt: workspace.registration.updatedAt,
            selectedMemberIds,
            keptGuestIds,
            newGuests,
            attendeeResponses,
          }),
        },
      );
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) {
        setError(result.message ?? "That change couldn't be saved. Refresh and try again.");
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError("We could not reach the registration service. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button className="secondary-button" onClick={() => setOpen(true)} type="button">
        <Pencil aria-hidden="true" size={14} /> Reopen to add or remove people
      </button>
    );
  }

  return (
    <section aria-labelledby="club-edit-title" className="public-manage-card">
      <div className="public-manage-card-heading club-roster-heading">
        <div>
          <h2 id="club-edit-title">Add or remove people</h2>
          <p className="field-help">
            Re-tick who&apos;s going. Everyone already registered keeps their existing answers.
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
                onChange={() => toggleMember(person.memberId)}
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
                <button aria-label={`Remove ${guest.firstName} ${guest.lastName}`} className="text-button" onClick={() => removeKeptGuest(guest.guestId!)} type="button">
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
                <button aria-label={`Remove ${guest.firstName} ${guest.lastName}`} className="text-button" onClick={() => removeNewGuest(guest.id)} type="button">
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
        <button className="secondary-button" disabled={saving} onClick={() => setOpen(false)} type="button">
          <X aria-hidden="true" size={15} /> Cancel
        </button>
        <button className="primary-button" disabled={saving || goingCount === 0} onClick={() => { void save(); }} type="button">
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </section>
  );
}
