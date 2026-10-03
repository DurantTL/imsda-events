"use client";

import { ageInputAttributes } from "@/modules/attendee-types/age-limits";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Pencil, Trash2, UserPlus, X } from "lucide-react";
import { ClubLocationPicker } from "@/components/club-location-picker";
import {
  PublicRegistrationForm,
  type FormIssue,
  type FormResponses,
  type RosterAttendee,
} from "@/components/public-registration-form";
import { rosterOwnedResponses, rosterRolePrefill } from "@/modules/club-registrations/domain";
import { groupSeatType, MAX_GROUP_ATTENDEES } from "@/modules/group-registrations/domain";
import type { GroupRegistrationWorkspace } from "@/modules/group-registrations/repository";

type Workspace = GroupRegistrationWorkspace & { experience: NonNullable<GroupRegistrationWorkspace["experience"]> };
type NewPerson = { clientId: string; firstName: string; lastName: string; age: number };

function newClientId() {
  return `p-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => (byte % 36).toString(36)).join("")}`;
}

/**
 * The contact of a "Group" registration reopening it (#650), until registration
 * closes: keep or remove the people, add someone, move to another location, and
 * check each person's answers. Saves through the same amendment engine clubs
 * use, so the server re-checks capacity, ages, and class seats and refuses a
 * change that would leave someone in a class they no longer fit. Classes are
 * changed in their own picker on the same page.
 */
export function GroupRegistrationEditor({ token, workspace }: { token: string; workspace: Workspace }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"who" | "form">("who");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const definition = workspace.experience.form.definition;
  const ageKey = workspace.attendeeAgeKey;
  const registered = workspace.registration.attendees;
  const currentLocationId = workspace.registration.location?.id ?? null;

  const [keptIds, setKeptIds] = useState<string[]>(() => registered.map((person) => person.attendeeId));
  const [newPeople, setNewPeople] = useState<NewPerson[]>([]);
  const [locationId, setLocationId] = useState<string | null>(currentLocationId);
  const [answers, setAnswers] = useState<Record<string, FormResponses>>({});

  const locationChoices = useMemo(() => {
    const registeredLocation = workspace.registration.location;
    return registeredLocation && !workspace.locations.some((location) => location.id === registeredLocation.id)
      ? [registeredLocation, ...workspace.locations]
      : workspace.locations;
  }, [workspace.locations, workspace.registration.location]);

  const goingCount = keptIds.length + newPeople.length;

  function toggleKept(attendeeId: string) {
    setKeptIds((current) => (current.includes(attendeeId) ? current.filter((id) => id !== attendeeId) : [...current, attendeeId]));
  }

  function addPerson(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const firstName = String(data.get("firstName") ?? "").trim();
    const lastName = String(data.get("lastName") ?? "").trim();
    const age = Number(data.get("age"));
    if (!firstName || !lastName) return setError("Enter a first and last name.");
    if (!Number.isInteger(age) || age < 0 || age > 120) return setError("Enter their age as a whole number from 0 to 120.");
    if (goingCount >= MAX_GROUP_ATTENDEES) return setError(`Add up to ${MAX_GROUP_ATTENDEES} people.`);
    setError("");
    setAdding(false);
    setNewPeople((current) => [...current, { clientId: newClientId(), firstName, lastName, age }]);
  }

  // The people in the form: current answers for kept people, a starting set for new ones.
  const initialAttendees: RosterAttendee[] = useMemo(() => {
    const withEdits = (clientId: string, base: Record<string, unknown>, owned: Record<string, unknown> = {}) => ({
      clientId,
      responses: { ...(base as FormResponses), ...(answers[clientId] ?? {}), ...(owned as FormResponses) },
    });
    return [
      ...registered.filter((person) => keptIds.includes(person.attendeeId)).map((person) => withEdits(person.clientId, person.responses)),
      ...newPeople.map((person) => {
        const details = { firstName: person.firstName, lastName: person.lastName, ageOnEventDate: person.age, gender: null };
        return withEdits(
          person.clientId,
          rosterRolePrefill(definition, { ...details, attendeeType: groupSeatType(person.age) }),
          rosterOwnedResponses(definition, details),
        );
      }),
    ];
    // Built once per visit to the form step; later edits live in the form itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Only the people's questions: the contact's own details have their own form on this page.
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
    const keptByClientId = new Map(registered.map((person) => [person.clientId, person.attendeeId]));
    const response = await fetch(`/api/public/manage/${encodeURIComponent(token)}/group`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientRequestId: crypto.randomUUID(),
        expectedUpdatedAt: workspace.registration.updatedAt,
        attendees: attendees.map((attendee) => {
          const attendeeId = keptByClientId.get(attendee.clientId) ?? null;
          return attendeeId
            ? { attendeeId, responses: attendee.responses }
            : { attendeeId: null, clientId: attendee.clientId, responses: attendee.responses };
        }),
        ...(locationId && locationId !== currentLocationId ? { locationId } : {}),
      }),
    });
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
  }, [token, registered, workspace.registration.updatedAt, locationId, currentLocationId]);

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
      setNewPeople([]);
      setAnswers({});
      router.refresh();
    },
  }), [initialAttendees, workspace.lockedAttendeeFieldKeys, onDraftChange, submitEdit, router]);

  if (!workspace.event.edit.open) {
    return <p className="field-help" role="status">{workspace.event.edit.message}</p>;
  }

  if (!open) {
    return (
      <button className="secondary-button" onClick={() => setOpen(true)} type="button">
        <Pencil aria-hidden="true" size={14} /> Change people, location, or details
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
    <section aria-labelledby="group-edit-title" className="public-manage-card" id="group-edit-people" tabIndex={-1}>
      <div className="public-manage-card-heading club-roster-heading">
        <div>
          <p className="public-registration-eyebrow">Step 1 of 2 · Who&apos;s going</p>
          <h2 id="group-edit-title">Change people or location</h2>
          <p className="field-help">
            Untick anyone who isn&apos;t going, add anyone new, then check their answers. Nothing changes until you save.
            Removing someone also removes their classes.
          </p>
        </div>
        <span className="count-badge">{goingCount} going</span>
      </div>
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <ClubLocationPicker currentId={currentLocationId} locations={locationChoices} noun="group" onChange={setLocationId} value={locationId} />
      <ul className="club-going-list">
        {registered.map((person) => (
          <li key={person.attendeeId}>
            <label className="checkbox-label">
              <input checked={keptIds.includes(person.attendeeId)} onChange={() => toggleKept(person.attendeeId)} type="checkbox" />
              <span>
                <strong translate="no">{person.lastName}, {person.firstName}</strong>
                {person.ageOnEventDate !== null && <small>Age <span translate="no">{person.ageOnEventDate}</span></small>}
              </span>
            </label>
          </li>
        ))}
        {newPeople.map((person) => (
          <li key={person.clientId}>
            <span>
              <strong translate="no">{person.lastName}, {person.firstName}</strong>
              <small>New · Age <span translate="no">{person.age}</span></small>
            </span>
            <button aria-label={`Remove ${person.firstName} ${person.lastName}`} className="text-button" onClick={() => setNewPeople((current) => current.filter((candidate) => candidate.clientId !== person.clientId))} type="button">
              <Trash2 aria-hidden="true" size={14} /> Remove
            </button>
          </li>
        ))}
      </ul>
      {!adding && (
        <button className="secondary-button" onClick={() => { setError(""); setAdding(true); }} type="button">
          <UserPlus aria-hidden="true" size={14} /> Add a person
        </button>
      )}
      {adding && (
        <form className="club-guest-form" onSubmit={addPerson}>
          <div className="form-grid two-column">
            <label>First name<input autoComplete="off" maxLength={80} name="firstName" required /></label>
            <label>Last name<input autoComplete="off" maxLength={80} name="lastName" required /></label>
            <label>Age on the first day of the event<input {...ageInputAttributes} name="age" required type="number" /></label>
          </div>
          <div className="club-registration-toolbar">
            <button className="secondary-button" onClick={() => { setError(""); setAdding(false); }} type="button">Cancel</button>
            <button className="primary-button" type="submit"><UserPlus aria-hidden="true" size={15} /> Add</button>
          </div>
        </form>
      )}
      <div className="club-registration-toolbar">
        <button className="secondary-button" onClick={() => { setError(""); setOpen(false); }} type="button">
          <X aria-hidden="true" size={15} /> Cancel
        </button>
        <button
          className="primary-button"
          disabled={goingCount === 0 || ageKey === null}
          onClick={() => { setError(""); setStep("form"); }}
          type="button"
        >
          Continue with {goingCount} {goingCount === 1 ? "person" : "people"} <ArrowRight aria-hidden="true" size={15} />
        </button>
      </div>
    </section>
  );
}
