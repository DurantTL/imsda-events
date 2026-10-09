"use client";

import { useMemo, useState } from "react";
import { Award, Save } from "lucide-react";
import { formatCalendarDate } from "@/modules/club-registrations/domain";
import { NeedsAttention, StatusComplete } from "@/components/needs-attention";
import { ClassStatus } from "@/components/class-status";
import { ClassRequirementNotes } from "@/components/class-requirement-notes";
import { ClassWaitlistPanel } from "@/components/class-waitlist-panel";
import { classChoiceReadiness, readinessSummaryText } from "@/modules/honors/class-readiness";
import { attendeeTypeLabel as typeLabel, seatsNote, unavailableReason } from "@/modules/honors/class-picker-view";
import { honorsNoteKey } from "@/modules/honors/registration-picks";
import { sortHonorSessions } from "@/modules/honors/session-order";
import type { ClassSelectionWorkspace } from "@/modules/honors/enrollment-repository";

type Offering = ClassSelectionWorkspace["offerings"][number];
type Attendee = ClassSelectionWorkspace["attendees"][number];

/**
 * Choosing Honors Weekend classes for each person on a club registration.
 * These checks only guide the director; the server enforces every rule.
 */
export function ClubClassPicker({
  canOverrideRequirements = false,
  endpoint,
  eventId,
  initialWorkspace,
  noun = "club",
  organizationId,
}: {
  /** True for staff acting as the club's director (#832): they may place someone below a class's level or prerequisites, with a reason. */
  canOverrideRequirements?: boolean;
  /** Where picks are saved. A club's own route by default; a "Group" contact's private link passes its own (#650). */
  endpoint?: string;
  eventId?: string;
  initialWorkspace: ClassSelectionWorkspace;
  /** Who holds the seats, in the words the page uses. */
  noun?: "club" | "group";
  organizationId?: string;
}) {
  const saveUrl = endpoint ?? `/api/attendee/clubs/${encodeURIComponent(organizationId ?? "")}/events/${encodeURIComponent(eventId ?? "")}/classes`;
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [selections, setSelections] = useState<Record<string, string[]>>(initialWorkspace.selections);
  // Confirmations of a missing class level or honor record, and staff's reasons for placing someone anyway (#832), by attendee id.
  const [confirmations, setConfirmations] = useState<Record<string, string[]>>({});
  const [overrides, setOverrides] = useState<Record<string, Record<string, string>>>({});
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
  const sessions = useMemo(() => sortHonorSessions(workspace.sessions), [workspace.sessions]);
  const allSessionOfferings = workspace.offerings.filter((offering) => offering.span === "ALL_SESSIONS");
  const offeringById = useMemo(() => new Map(workspace.offerings.map((offering) => [offering.id, offering])), [workspace.offerings]);

  // Who still owes a class choice, from the picks on screen (#799 G3): nobody shows as done until every session they can take has one.
  const readiness = useMemo(
    () => classChoiceReadiness({ attendees: workspace.attendees, sessions, offerings: workspace.offerings, selections, saved: workspace.selections }),
    [workspace.attendees, sessions, workspace.offerings, selections, workspace.selections],
  );
  const readinessById = useMemo(() => new Map(readiness.people.map((person) => [person.attendeeId, person])), [readiness]);

  // With sites on the event, classes are per site: no site picked, nothing to choose (#589).
  if (workspace.locationRequired) {
    return (
      <section className="public-manage-card" aria-labelledby="class-picker-heading">
        <div className="public-manage-card-heading club-roster-heading">
          <div>
            <p className="public-registration-eyebrow">Classes</p>
            <h2 id="class-picker-heading"><Award size={18} aria-hidden="true" /> Choose classes</h2>
          </div>
        </div>
        <p className="public-manage-empty" role="status">{workspace.locationMessage ?? "Choose your location first."}</p>
      </section>
    );
  }
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

  // The waitlist panel returns the whole workspace after a join, accept or decline (#831). A person whose saved classes changed
  // (an accepted seat) takes the server's picks; everyone else keeps what is on screen, unsaved changes included.
  function applyWaitlistWorkspace(next: ClassSelectionWorkspace) {
    setSelections((current) => {
      const merged = { ...current };
      for (const person of next.attendees) {
        const before = (workspace.selections[person.id] ?? []).join();
        const after = (next.selections[person.id] ?? []).join();
        if (before !== after) merged[person.id] = next.selections[person.id] ?? [];
      }
      return merged;
    });
    setWorkspace(next);
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      // Only what still applies: a tick or reason for a class that is no longer picked is dropped (#832).
      const pickedNow = (attendeeId: string) => new Set(selections[attendeeId] ?? []);
      const sentConfirmations = Object.fromEntries(Object.entries(confirmations)
        .map(([attendeeId, ids]) => [attendeeId, ids.filter((id) => pickedNow(attendeeId).has(id))] as const)
        .filter(([, ids]) => ids.length > 0));
      const sentOverrides = Object.fromEntries(Object.entries(overrides)
        .map(([attendeeId, byClass]) => [attendeeId, Object.fromEntries(Object.entries(byClass).filter(([id, reason]) => pickedNow(attendeeId).has(id) && reason.trim()))] as const)
        .filter(([, byClass]) => Object.keys(byClass).length > 0));
      const response = await fetch(
        saveUrl,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selections,
            ...(Object.keys(sentConfirmations).length > 0 ? { confirmations: sentConfirmations } : {}),
            ...(Object.keys(sentOverrides).length > 0 ? { overrides: sentOverrides } : {}),
          }),
        },
      );
      const result = await response.json().catch(() => ({})) as { workspace?: ClassSelectionWorkspace; message?: string };
      if (!response.ok || !result.workspace) throw new Error(result.message ?? "Class choices could not be saved.");
      setWorkspace(result.workspace);
      setSelections(result.workspace.selections);
      setConfirmations({});
      setOverrides({});
      // The earlier "your honors weren't saved" note is settled now (#618).
      if (organizationId && eventId) {
        try { sessionStorage.removeItem(honorsNoteKey(organizationId, eventId)); } catch { /* storage is optional */ }
      }
      setNotice(`Classes saved. Seats are held for your ${noun}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Class choices could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const option = (offering: Offering, attendee: Attendee) => {
    const heldHere = held(attendee.id, offering.id);
    const reason = unavailableReason(offering, heldHere, attendee, { canOverride: canOverrideRequirements, canConfirm: noun === "club" });
    return (
      <option disabled={Boolean(reason)} key={offering.id} value={offering.id}>
        {offering.honorName} ({reason ?? seatsNote(offering, heldHere, attendee, noun)})
      </option>
    );
  };

  return (
    <section className="public-manage-card" aria-labelledby="class-picker-heading">
      <div className="public-manage-card-heading club-roster-heading">
        <div>
          <p className="public-registration-eyebrow">Classes</p>
          <h2 id="class-picker-heading"><Award size={18} aria-hidden="true" /> Choose classes</h2>
        </div>
      </div>
      {workspace.location && (
        <p className="field-help">Classes at <strong translate="no">{workspace.location.name}</strong>.</p>
      )}
      <p>
        Pick one class per session, or one class that fills every session. Seats go to the first
        {noun === "club" ? "clubs" : "registrations"} to save{noun === "club" ? "; a full class has a waitlist below" : ""}. Only youth use a seat; {noun === "club" ? "staff, adults, and underage children join" : "adults join"} without one.
        {workspace.registrationClosesOn ? ` You can change classes until ${formatCalendarDate(workspace.registrationClosesOn)}.` : ""}
      </p>
      {workspace.open && (
        <p className="class-readiness-summary" role="status">
          {readiness.complete ? <StatusComplete label={readinessSummaryText(readiness)} /> : <NeedsAttention label={readinessSummaryText(readiness)} />}
        </p>
      )}
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
                  {typeLabel(attendee)}{attendee.consumesSeat ? "" : " · no seat needed"}
                </small>
                {readinessById.get(attendee.id) && <small><ClassStatus open={workspace.open} person={readinessById.get(attendee.id)!} /></small>}
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
              {sessions.map((session) => {
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
              <ClassRequirementNotes
                canConfirm={noun === "club"}
                canOverride={canOverrideRequirements}
                confirmed={confirmations[attendee.id] ?? []}
                heldIds={workspace.selections[attendee.id] ?? []}
                offerings={chosen.map((id) => offeringById.get(id)).filter((offering): offering is Offering => Boolean(offering))}
                onConfirmedChange={(offeringId, checked) => setConfirmations((current) => {
                  const ids = current[attendee.id] ?? [];
                  return { ...current, [attendee.id]: checked ? [...new Set([...ids, offeringId])] : ids.filter((id) => id !== offeringId) };
                })}
                onReasonChange={(offeringId, reason) => setOverrides((current) => ({ ...current, [attendee.id]: { ...(current[attendee.id] ?? {}), [offeringId]: reason } }))}
                person={attendee}
                reasons={overrides[attendee.id] ?? {}}
              />
            </fieldset>
          );
        })}
      </div>
      {noun === "club" && (
        <ClassWaitlistPanel canOverrideRequirements={canOverrideRequirements} endpoint={`${saveUrl}/waitlist`} onWorkspace={applyWaitlistWorkspace} workspace={workspace} />
      )}
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
