"use client";

import { useMemo, useState } from "react";
import { Award, Save } from "lucide-react";
import { formatCalendarDate } from "@/modules/club-registrations/domain";
import type { ClassSelectionWorkspace } from "@/modules/honors/enrollment-repository";

type Offering = ClassSelectionWorkspace["offerings"][number];
type Attendee = ClassSelectionWorkspace["attendees"][number];

function seatsNote(offering: Offering, heldHere: boolean, attendee: Attendee) {
  if (!attendee.consumesSeat) return "staff, no seat";
  if (heldHere) return "seat held";
  const left = offering.capacity - offering.seatsTaken;
  const clubLeft = offering.perClubLimit === null ? null : offering.perClubLimit - offering.clubSeatsTaken;
  const parts = [`${Math.max(left, 0)} of ${offering.capacity} seats left`];
  if (clubLeft !== null) parts.push(`${Math.max(clubLeft, 0)} left for your club`);
  return parts.join(", ");
}

function unavailableReason(offering: Offering, heldHere: boolean, attendee: Attendee) {
  if (heldHere) return null;
  if (!offering.isActive) return "no longer offered";
  if (offering.minimumAge !== null && (attendee.ageOnEventDate === null || attendee.ageOnEventDate < offering.minimumAge)) {
    return `ages ${offering.minimumAge}+`;
  }
  if (!attendee.consumesSeat) return null;
  if (offering.seatsTaken >= offering.capacity) return "full";
  if (offering.perClubLimit !== null && offering.clubSeatsTaken >= offering.perClubLimit) return "club limit reached";
  return null;
}

/**
 * Choosing Honors Weekend classes for each person on a club registration.
 * These checks only guide the director; the server enforces every rule.
 */
export function ClubClassPicker({
  initialWorkspace,
  organizationId,
  eventId,
}: {
  initialWorkspace: ClassSelectionWorkspace;
  organizationId: string;
  eventId: string;
}) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [selections, setSelections] = useState<Record<string, string[]>>(initialWorkspace.selections);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const bySession = useMemo(() => {
    const groups = new Map<string, Offering[]>();
    for (const offering of workspace.offerings) {
      if (offering.span !== "SINGLE_SESSION" || !offering.sessionId) continue;
      groups.set(offering.sessionId, [...(groups.get(offering.sessionId) ?? []), offering]);
    }
    return groups;
  }, [workspace.offerings]);
  const allSessionOfferings = workspace.offerings.filter((offering) => offering.span === "ALL_SESSIONS");
  const offeringById = useMemo(() => new Map(workspace.offerings.map((offering) => [offering.id, offering])), [workspace.offerings]);

  if (workspace.offerings.length === 0) return null;

  function held(attendeeId: string, offeringId: string) {
    return (workspace.selections[attendeeId] ?? []).includes(offeringId);
  }

  function setAllSessions(attendeeId: string, offeringId: string) {
    setSelections((current) => ({ ...current, [attendeeId]: offeringId ? [offeringId] : [] }));
  }

  function setSession(attendeeId: string, sessionId: string, offeringId: string) {
    setSelections((current) => {
      const kept = (current[attendeeId] ?? []).filter((id) => {
        const offering = offeringById.get(id);
        return offering && offering.span === "SINGLE_SESSION" && offering.sessionId !== sessionId;
      });
      return { ...current, [attendeeId]: offeringId ? [...kept, offeringId] : kept };
    });
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/attendee/clubs/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(eventId)}/classes`,
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selections }) },
      );
      const result = await response.json().catch(() => ({})) as { workspace?: ClassSelectionWorkspace; message?: string };
      if (!response.ok || !result.workspace) throw new Error(result.message ?? "Class choices could not be saved.");
      setWorkspace(result.workspace);
      setSelections(result.workspace.selections);
      setNotice("Classes saved. Seats are held for your club.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Class choices could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const option = (offering: Offering, attendee: Attendee) => {
    const heldHere = held(attendee.id, offering.id);
    const reason = unavailableReason(offering, heldHere, attendee);
    return (
      <option disabled={Boolean(reason)} key={offering.id} value={offering.id}>
        {offering.honorName} ({reason ?? seatsNote(offering, heldHere, attendee)})
      </option>
    );
  };

  return (
    <section className="public-manage-card" aria-labelledby="class-picker-heading">
      <div className="public-manage-card-heading club-roster-heading">
        <div>
          <p className="public-registration-eyebrow">Step 3 of 3 · Classes</p>
          <h2 id="class-picker-heading"><Award size={18} aria-hidden="true" /> Choose classes</h2>
        </div>
      </div>
      <p>
        Pick one class per session, or one class that fills every session. Seats go to the first
        clubs to save, and only youth use a seat.
        {workspace.registrationClosesOn ? ` You can change classes until ${formatCalendarDate(workspace.registrationClosesOn)}.` : ""}
      </p>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      {!workspace.open && <p className="public-manage-empty">Class choices are closed.</p>}
      <div className="club-class-grid">
        {workspace.attendees.map((attendee) => {
          const chosen = selections[attendee.id] ?? [];
          const chosenAll = chosen.find((id) => offeringById.get(id)?.span === "ALL_SESSIONS") ?? "";
          return (
            <fieldset className="club-class-person" disabled={!workspace.open || saving} key={attendee.id}>
              <legend>
                <strong translate="no">{attendee.lastName}, {attendee.firstName}</strong>
                <small>
                  {attendee.ageOnEventDate !== null ? <>Age <span translate="no">{attendee.ageOnEventDate}</span> · </> : null}
                  {attendee.consumesSeat ? "Youth" : "Staff or adult"}
                </small>
              </legend>
              {allSessionOfferings.length > 0 && (
                <label>
                  All sessions
                  <select onChange={(event) => setAllSessions(attendee.id, event.target.value)} value={chosenAll}>
                    <option value="">Not an all-sessions class</option>
                    {allSessionOfferings.map((offering) => option(offering, attendee))}
                  </select>
                </label>
              )}
              {workspace.sessions.map((session) => {
                const offerings = bySession.get(session.id) ?? [];
                if (offerings.length === 0) return null;
                const value = chosen.find((id) => offeringById.get(id)?.sessionId === session.id) ?? "";
                return (
                  <label key={session.id}>
                    {session.name}
                    <select
                      disabled={Boolean(chosenAll)}
                      onChange={(event) => setSession(attendee.id, session.id, event.target.value)}
                      value={value}
                    >
                      <option value="">No class</option>
                      {offerings.map((offering) => option(offering, attendee))}
                    </select>
                  </label>
                );
              })}
            </fieldset>
          );
        })}
      </div>
      {workspace.open && (
        <div className="club-sticky-bar">
          <span className="field-help">{Object.values(selections).reduce((total, ids) => total + ids.length, 0)} classes chosen</span>
          <button className="primary-button" disabled={saving} onClick={save} type="button">
            <Save aria-hidden="true" size={16} /> {saving ? "Saving…" : "Save classes"}
          </button>
        </div>
      )}
    </section>
  );
}
