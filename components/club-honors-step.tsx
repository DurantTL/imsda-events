"use client";

import { useMemo } from "react";
import { ArrowLeft, ArrowRight, Award } from "lucide-react";
import { attendeeTypeLabel, seatsNote, unavailableReason } from "@/modules/honors/class-picker-view";
import { offeringsAtLocation, type PickingAttendee } from "@/modules/honors/registration-picks";
import { sortHonorSessions } from "@/modules/honors/session-order";
import type { RegistrationHonorsCatalog } from "@/modules/honors/enrollment-repository";

type Offering = RegistrationHonorsCatalog["offerings"][number];

export type HonorPicks = Record<string, string[]>;

/**
 * The honors step of a club registration (#618): each person going can be
 * given one class per session, or one class that fills every session, at the
 * site the club chose. It only guides; the same enrollment rules run on the
 * server when the registration is saved, and picks stay changeable on the
 * registered page afterwards.
 */
export function ClubHonorsStep({
  attendees,
  catalog,
  locationId,
  locationName,
  onBack,
  onChange,
  onContinue,
  picks,
  problem,
  saveLabel,
}: {
  attendees: PickingAttendee[];
  catalog: RegistrationHonorsCatalog;
  locationId: string | null;
  locationName: string | null;
  onBack: () => void;
  onChange: (picks: HonorPicks) => void;
  onContinue: () => void;
  picks: HonorPicks;
  problem: string | null;
  saveLabel: string;
}) {
  const offerings = useMemo(() => offeringsAtLocation(catalog.offerings, locationId), [catalog.offerings, locationId]);
  const offeringById = useMemo(() => new Map(offerings.map((offering) => [offering.id, offering])), [offerings]);
  const bySession = useMemo(() => {
    const groups = new Map<string, Offering[]>();
    for (const offering of offerings) {
      if (offering.span !== "SINGLE_SESSION" || !offering.sessionId) continue;
      groups.set(offering.sessionId, [...(groups.get(offering.sessionId) ?? []), offering]);
    }
    return groups;
  }, [offerings]);
  const sessions = useMemo(() => sortHonorSessions(catalog.sessions), [catalog.sessions]);
  const allSessionOfferings = offerings.filter((offering) => offering.span === "ALL_SESSIONS");

  function setAllSessions(clientId: string, offeringId: string) {
    onChange({ ...picks, [clientId]: offeringId ? [offeringId] : [] });
  }

  function setSession(clientId: string, sessionId: string, offeringId: string) {
    const kept = (picks[clientId] ?? []).filter((id) => {
      const offering = offeringById.get(id);
      return offering && offering.span === "SINGLE_SESSION" && offering.sessionId !== sessionId;
    });
    onChange({ ...picks, [clientId]: offeringId ? [...kept, offeringId] : kept });
  }

  const option = (offering: Offering, attendee: PickingAttendee) => {
    const reason = unavailableReason(offering, false, attendee);
    return (
      <option disabled={Boolean(reason)} key={offering.id} value={offering.id}>
        {offering.honorName} ({reason ?? seatsNote(offering, false, attendee)})
      </option>
    );
  };

  const chosenCount = Object.values(picks).reduce((total, ids) => total + ids.length, 0);

  return (
    <section className="public-manage-card" aria-labelledby="honors-step-heading">
      <div className="club-registration-toolbar">
        <button className="secondary-button" onClick={onBack} type="button">
          <ArrowLeft aria-hidden="true" size={15} /> Change who&apos;s going
        </button>
        <span className="field-help" role="status">{saveLabel}</span>
      </div>
      <div className="public-manage-card-heading club-roster-heading">
        <div>
          <p className="public-registration-eyebrow">Step 2 of 4 · Honors</p>
          <h2 id="honors-step-heading"><Award size={18} aria-hidden="true" /> Choose honors</h2>
        </div>
      </div>
      {locationName && <p className="field-help">Classes at <strong translate="no">{locationName}</strong>.</p>}
      <p>
        Pick one class per session, or one class that fills every session, for each person. This is
        optional now; you can also choose or change classes after you register. Seats go to the first
        clubs to save. Only youth use a seat; staff, adults, and underage children join without one.
      </p>
      {problem && <div className="inline-notice error" role="alert">{problem}</div>}
      <div className="club-class-grid">
        {attendees.map((attendee) => {
          const chosen = picks[attendee.clientId] ?? [];
          const chosenAll = chosen.find((id) => offeringById.get(id)?.span === "ALL_SESSIONS") ?? "";
          return (
            <fieldset className="club-class-person" key={attendee.clientId}>
              <legend>
                <strong translate="no">{attendee.lastName}, {attendee.firstName}</strong>
                <small>
                  {attendee.ageOnEventDate !== null ? <>Age <span translate="no">{attendee.ageOnEventDate}</span> · </> : null}
                  {attendeeTypeLabel(attendee)}{attendee.consumesSeat ? "" : " · no seat needed"}
                </small>
              </legend>
              {allSessionOfferings.length > 0 && (
                <label>
                  All sessions
                  <select onChange={(event) => setAllSessions(attendee.clientId, event.target.value)} value={chosenAll}>
                    <option value="">Not an all-sessions class</option>
                    {allSessionOfferings.map((offering) => option(offering, attendee))}
                  </select>
                </label>
              )}
              {sessions.map((session) => {
                const inSession = bySession.get(session.id) ?? [];
                if (inSession.length === 0) return null;
                const value = chosen.find((id) => offeringById.get(id)?.sessionId === session.id) ?? "";
                return (
                  <label key={session.id}>
                    {session.name}
                    <select
                      disabled={Boolean(chosenAll)}
                      onChange={(event) => setSession(attendee.clientId, session.id, event.target.value)}
                      value={value}
                    >
                      <option value="">No class</option>
                      {inSession.map((offering) => option(offering, attendee))}
                    </select>
                  </label>
                );
              })}
            </fieldset>
          );
        })}
      </div>
      <div className="club-registration-toolbar club-sticky-bar">
        <span className="field-help">{chosenCount} {chosenCount === 1 ? "class" : "classes"} chosen</span>
        <button className="primary-button" onClick={onContinue} type="button">
          Continue to the event form <ArrowRight aria-hidden="true" size={15} />
        </button>
      </div>
    </section>
  );
}
