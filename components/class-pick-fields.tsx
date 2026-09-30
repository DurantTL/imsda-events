"use client";

import { useMemo } from "react";
import { seatsNote, unavailableReason, type SeatOwnerNoun } from "@/modules/honors/class-picker-view";
import type { PickingAttendee } from "@/modules/honors/registration-picks";
import { sortHonorSessions } from "@/modules/honors/session-order";
import type { RegistrationHonorsCatalog } from "@/modules/honors/enrollment-repository";

type Offering = RegistrationHonorsCatalog["offerings"][number];

/**
 * One person's class choices while registering: one class per session, or one
 * class that fills every session (#618). Used under each person's name, both in
 * a club's and in a group's per-person details (#618, #650). It only
 * guides (a class that is full, too advanced, or over the limit is disabled);
 * the same rules run on the server when the registration is saved.
 *
 * `offerings` are the active classes at the chosen site. `picks` are this
 * person's chosen class ids.
 */
export function ClassPickFields({
  attendee,
  noun = "club",
  offerings,
  onChange,
  picks,
  sessions,
}: {
  attendee: PickingAttendee;
  noun?: SeatOwnerNoun;
  offerings: readonly Offering[];
  onChange: (offeringIds: string[]) => void;
  picks: readonly string[];
  sessions: RegistrationHonorsCatalog["sessions"];
}) {
  const offeringById = useMemo(() => new Map(offerings.map((offering) => [offering.id, offering])), [offerings]);
  const bySession = useMemo(() => {
    const groups = new Map<string, Offering[]>();
    for (const offering of offerings) {
      if (offering.span !== "SINGLE_SESSION" || !offering.sessionId) continue;
      groups.set(offering.sessionId, [...(groups.get(offering.sessionId) ?? []), offering]);
    }
    return groups;
  }, [offerings]);
  const orderedSessions = useMemo(() => sortHonorSessions(sessions), [sessions]);
  const allSessionOfferings = offerings.filter((offering) => offering.span === "ALL_SESSIONS");
  const chosenAll = picks.find((id) => offeringById.get(id)?.span === "ALL_SESSIONS") ?? "";

  function setAllSessions(offeringId: string) {
    onChange(offeringId ? [offeringId] : []);
  }

  function setSession(sessionId: string, offeringId: string) {
    const kept = picks.filter((id) => {
      const offering = offeringById.get(id);
      return offering && offering.span === "SINGLE_SESSION" && offering.sessionId !== sessionId;
    });
    onChange(offeringId ? [...kept, offeringId] : kept);
  }

  const option = (offering: Offering) => {
    const reason = unavailableReason(offering, false, attendee);
    return (
      <option disabled={Boolean(reason)} key={offering.id} value={offering.id}>
        {offering.honorName} ({reason ?? seatsNote(offering, false, attendee, noun)})
      </option>
    );
  };

  if (offerings.length === 0) return null;
  return (
    <>
      {allSessionOfferings.length > 0 && (
        <label>
          All sessions
          <select onChange={(event) => setAllSessions(event.target.value)} value={chosenAll}>
            <option value="">Not an all-sessions class</option>
            {allSessionOfferings.map(option)}
          </select>
        </label>
      )}
      {orderedSessions.map((session) => {
        const inSession = bySession.get(session.id) ?? [];
        if (inSession.length === 0) return null;
        const value = picks.find((id) => offeringById.get(id)?.sessionId === session.id) ?? "";
        return (
          <label key={session.id}>
            {session.name}
            <select
              disabled={Boolean(chosenAll)}
              onChange={(event) => setSession(session.id, event.target.value)}
              value={value}
            >
              <option value="">No class</option>
              {inSession.map(option)}
            </select>
          </label>
        );
      })}
    </>
  );
}
