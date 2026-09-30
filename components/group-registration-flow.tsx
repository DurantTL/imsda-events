"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, UsersRound } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { ClassPickFields } from "@/components/class-pick-fields";
import { ClubLocationPicker, locationUnavailableLabel } from "@/components/club-location-picker";
import { PublicRegistrationForm, type FormResponses, type RosterAttendee } from "@/components/public-registration-form";
import { attendeeTypeLabel } from "@/modules/honors/class-picker-view";
import { groupPickingAttendee, GROUP_LABEL } from "@/modules/group-registrations/domain";
import { offeringsAtLocation, prunePicks, type PickingAttendee } from "@/modules/honors/registration-picks";
import type { GroupRegistrationExperience } from "@/modules/group-registrations/repository";

type Ready = GroupRegistrationExperience & {
  event: NonNullable<GroupRegistrationExperience["event"]>;
  experience: NonNullable<GroupRegistrationExperience["experience"]>;
  billingNotice: string;
};

type Saved = { locationId: string | null; picks: Record<string, string[]> };

function storageKey(eventSlug: string) {
  return `imsda-group-registration:${eventSlug}`;
}

function readSaved(eventSlug: string): Saved | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(eventSlug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Saved>;
    return {
      locationId: typeof parsed.locationId === "string" ? parsed.locationId : null,
      picks: parsed.picks && typeof parsed.picks === "object" ? parsed.picks : {},
    };
  } catch {
    return null;
  }
}

/**
 * "Register as a group or individual" on a club event (#650): people who are
 * not in a club register through one contact. Pick a location, then add each
 * person with their details and, under their name, their classes; the review
 * shows an estimated total and says the contact is billed after the event. There
 * is no payment step. The server prices, checks ages and takes the seats; this
 * only guides.
 */
export function GroupRegistrationFlow({ eventSlug, ready }: { eventSlug: string; ready: Ready }) {
  const { experience, locations, honorsCatalog } = ready;
  const definition = experience.form.definition;
  const pickableLocations = locations.filter((location) => (
    locationUnavailableLabel({ ...location, phase: location.phase }, null, location.id, true) === null
  ));
  const [locationId, setLocationId] = useState<string | null>(() => (pickableLocations.length === 1 ? pickableLocations[0]!.id : null));
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [started, setStarted] = useState(locations.length === 0);
  const chosenLocation = locations.find((location) => location.id === locationId) ?? null;

  // What the visitor chose survives a refresh in this tab only.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = readSaved(eventSlug);
      if (!saved) return;
      if (saved.locationId && locations.some((location) => location.id === saved.locationId)) {
        setLocationId(saved.locationId);
        setStarted(true);
      }
      setPicks(saved.picks);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [eventSlug, locations]);

  const remember = useCallback((next: Saved) => {
    try { window.sessionStorage.setItem(storageKey(eventSlug), JSON.stringify(next)); } catch { /* storage is optional */ }
  }, [eventSlug]);

  const offerings = useMemo(
    () => (honorsCatalog ? offeringsAtLocation(honorsCatalog.offerings, locationId) : []),
    [honorsCatalog, locationId],
  );
  // A group that will be waitlisted holds no seats yet, so it picks classes once confirmed.
  const waitlisted = Boolean(chosenLocation?.full);
  const hasClasses = offerings.length > 0 && !waitlisted;

  function changePicks(clientId: string, ids: string[]) {
    setPicks((current) => {
      const next = { ...current, [clientId]: ids };
      remember({ locationId, picks: next });
      return next;
    });
  }

  function chooseLocation(id: string) {
    setLocationId(id);
    // Classes belong to a site: anything not offered at the new one is dropped.
    setPicks((current) => {
      const next = honorsCatalog ? prunePicks(current, Object.keys(current).map((clientId) => ({ clientId })), offeringsAtLocation(honorsCatalog.offerings, id)) : current;
      remember({ locationId: id, picks: next });
      return next;
    });
  }

  const renderAttendeeExtras = useCallback((attendee: RosterAttendee) => {
    if (!hasClasses || !honorsCatalog) return null;
    const person: PickingAttendee = groupPickingAttendee(definition, attendee);
    return (
      <section className="public-registration-attendee-section" aria-label={`Classes for ${person.firstName || "this person"}`}>
        <h4>Classes</h4>
        {person.ageOnEventDate === null ? (
          <p className="field-help">Enter this person&apos;s age above to choose classes.</p>
        ) : (
          <fieldset className="club-class-person">
            <legend>
              <small>
                Age <span translate="no">{person.ageOnEventDate}</span> · {attendeeTypeLabel(person)}{person.consumesSeat ? "" : " · no seat needed"}
              </small>
            </legend>
            <ClassPickFields
              attendee={person}
              noun="group"
              offerings={offerings}
              onChange={(ids) => changePicks(attendee.clientId, ids)}
              picks={picks[attendee.clientId] ?? []}
              sessions={honorsCatalog.sessions}
            />
          </fieldset>
        )}
      </section>
    );
    // changePicks reads the latest location and picks through state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasClasses, honorsCatalog, definition, offerings, picks, locationId]);

  const blockedReason = useMemo(() => {
    if (locations.length > 0 && !chosenLocation) return "Choose a location first.";
    return null;
  }, [locations.length, chosenLocation]);

  if (!started) {
    return (
      <main className="public-registration-page">
        <header className="public-registration-header">
          <div className="public-registration-header-inner">
            <Link className="public-registration-brand public-event-brand-link" href={`/events/${encodeURIComponent(eventSlug)}`}>
              <BrandMark /><span><strong>IMSDA</strong><small>Events</small></span>
            </Link>
          </div>
        </header>
        <section className="public-manage-card" style={{ maxWidth: 720, margin: "24px auto" }}>
          <p className="public-registration-eyebrow">{GROUP_LABEL} registration · {ready.event.name}</p>
          <h1><UsersRound aria-hidden="true" size={22} /> Register as a group or individual</h1>
          <p>
            One contact can register several people. Each person gets their own details and classes, and the
            same age rules and seat limits apply as for clubs. {ready.billingNotice} There is no payment to make now.
          </p>
          <ClubLocationPicker allowWaitlist locations={locations} noun="group" onChange={chooseLocation} value={locationId} />
          <div className="club-registration-toolbar">
            <button
              className="primary-button"
              disabled={!chosenLocation}
              onClick={() => { remember({ locationId, picks }); setStarted(true); }}
              type="button"
            >
              Continue <ArrowRight aria-hidden="true" size={15} />
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <PublicRegistrationForm
      choiceUsage={experience.choiceUsage}
      event={experience.event}
      // Drafts are kept apart from the ordinary form of the same event.
      form={{ ...experience.form, slug: `${experience.form.slug}:group` }}
      group={{
        submitUrl: `/api/public/events/${encodeURIComponent(eventSlug)}/group-registrations`,
        locationId,
        honorSelections: picks,
        billingNotice: ready.billingNotice,
        renderAttendeeExtras: hasClasses ? renderAttendeeExtras : undefined,
        blockedReason,
        locationName: chosenLocation?.name ?? null,
        onChangeLocation: locations.length > 1 ? () => setStarted(false) : undefined,
        waitlistNote: waitlisted ? "This location is full, so your group will join its waitlist. Pick classes after you are confirmed." : null,
      }}
      initialResponses={{} as FormResponses}
      lifecycle={experience.lifecycle}
      pricingDate={experience.pricingDate}
    />
  );
}
