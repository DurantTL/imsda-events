"use client";

import { ageInputAttributes } from "@/modules/attendee-types/age-limits";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Trash2, UserPlus, UsersRound } from "lucide-react";
import {
  PublicRegistrationForm,
  type FormResponses,
  type RosterAttendee,
} from "@/components/public-registration-form";
import { createDraftSaveQueue } from "@/modules/club-registrations/draft-save-queue";
import { createDraftSender, DRAFT_CONFLICT_MESSAGE, draftBlockedReason } from "@/modules/club-registrations/draft-sender";
import { restoreDraftLocation } from "@/modules/club-registrations/draft-location";
import { rosterHrefFromRegistration } from "@/modules/club-registrations/roster-return";
import { ClubRosterAgeField } from "@/components/club-roster-age-field";
import { sortHonorSessions } from "@/modules/honors/session-order";
import { ClassStatus } from "@/components/class-status";
import { classChoiceReadiness } from "@/modules/honors/class-readiness";
import { backgroundCheckAttention, classAttention, type AttentionItem } from "@/modules/club-registrations/attention";
import type { ClubComplianceState } from "@/modules/background-checks/display";
import { MissingAgeSummary } from "@/components/missing-age-summary";
import { ageFieldId, ageInputProblem, ageInputValue, effectiveRosterAges, parseTypedAge, peopleMissingAges, withRosterAge } from "@/modules/club-registrations/roster-ages";
import { continueButtonLabel, focusFirstMissingAge, leaveAfterSave } from "@/modules/club-registrations/roster-age-flow";
import { ClubLocationPicker } from "@/components/club-location-picker";
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
import { fillMissingAnswers } from "@/modules/club-registrations/contact-prefill";
import { permissionPendingNotice } from "@/modules/club-teams/permission-domain";
import { teamRoleFor } from "@/modules/club-teams/rules";
import type { ClubEventWorkspace } from "@/modules/club-registrations/repository";
import { ClassPickFields } from "@/components/class-pick-fields";
import { attendeeTypeLabel } from "@/modules/honors/class-picker-view";
import { firstPickProblem, honorsNoteKey, offeringsAtLocation, pickingAttendees, prunePicks } from "@/modules/honors/registration-picks";
import type { RegistrationHonorsCatalog } from "@/modules/honors/enrollment-repository";
import type { PublicRegistrationExperience } from "@/modules/forms/public-repository";

type Workspace = ClubEventWorkspace & { experience: PublicRegistrationExperience };

/** Class picks by attendee client id (#618). */
type HonorPicks = Record<string, string[]>;

type DraftState = {
  selectedMemberIds: string[];
  guests: ClubGuest[];
  responses: FormResponses;
  attendeeResponses: Record<string, FormResponses>;
  honorSelections: HonorPicks;
  /** Ages typed in for roster people with no birth date on file (#639), by roster member id. */
  rosterAges: Record<string, number>;
  /** Roster people whose typed-in age is NOT also saved to the roster at submit (#639); saving is the default. */
  rosterAgeSaveOff: string[];
  /** The chosen location (#659), saved with the draft and checked again on restore. */
  locationId: string | null;
  /** Which team this draft is for and the name typed so far (#809); empty on an event without teams. */
  draftKey: string;
  teamName: string;
};

export function ClubRegistrationWorkspace({
  contactPrefill,
  draftKey = "",
  honorsCatalog = null,
  backgroundStates,
  organizationId,
  workspace,
}: {
  /** Each staff or adult roster member's Sterling Volunteers state, by roster member id (#853). Only for someone allowed to see it. */
  backgroundStates?: Record<string, ClubComplianceState>;
  contactPrefill: Record<string, string>;
  /** The id of the team's draft (#809), picked by the page; empty on an event without teams. */
  draftKey?: string;
  /** The event's honors classes, when it has any (#618). */
  honorsCatalog?: RegistrationHonorsCatalog | null;
  organizationId: string;
  workspace: Workspace;
}) {
  const router = useRouter();
  const ageKey = workspace.attendeeAgeKey;
  // The event's locations (#413): a location is required before continuing when there are any.
  // The choice is part of the draft (#659); the server locks it and counts its seats when the registration is saved.
  const locations = workspace.locations;
  const [restoredLocation] = useState(() => restoreDraftLocation(locations, workspace.draft?.locationId));
  const [locationNote, setLocationNote] = useState<string | null>(restoredLocation.note);
  const rosterIds = useMemo(() => new Set(workspace.roster.map((person) => person.memberId)), [workspace.roster]);
  const [draft, setDraft] = useState<DraftState>(() => ({
    selectedMemberIds: (workspace.draft?.selectedMemberIds ?? []).filter((memberId) => rosterIds.has(memberId)),
    guests: workspace.draft?.guests ?? [],
    // The director's own details fill in only what the draft (or the person) left blank (#618).
    responses: fillMissingAnswers(workspace.draft?.responses, contactPrefill) as FormResponses,
    attendeeResponses: (workspace.draft?.attendeeResponses as Record<string, FormResponses> | undefined) ?? {},
    honorSelections: workspace.draft?.honorSelections ?? {},
    rosterAges: workspace.draft?.rosterAges ?? {},
    rosterAgeSaveOff: workspace.draft?.rosterAgeSaveOff ?? [],
    locationId: restoredLocation.locationId,
    draftKey,
    teamName: workspace.draft?.teamName ?? "",
  }));
  const multipleTeams = workspace.teams.multiple;
  const teamNameMissing = multipleTeams && draft.teamName.trim().length === 0;
  const [step, setStep] = useState<"who" | "form">("who");
  const locationId = draft.locationId;
  const chosenLocation = locations.find((location) => location.id === locationId) ?? null;
  const needsLocation = locations.length > 0 && !chosenLocation;
  const [addingGuest, setAddingGuest] = useState(false);
  const [guestError, setGuestError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">(workspace.draft ? "saved" : "idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const base = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(workspace.event.id)}`;

  const [leaveHref, setLeaveHref] = useState<string | null>(null);
  // The revision the saved draft is at (#659); every save names it, so a stale save from another tab is refused.
  const [conflict, setConflict] = useState(false);
  const [sender] = useState(() => createDraftSender<DraftState>({
    url: `${base}/draft`,
    initialRevision: workspace.draft?.revision ?? 0,
    onConflict: () => setConflict(true),
  }));
  const [queue] = useState(() => createDraftSaveQueue<DraftState>({
    onState: (state) => {
      setSaveState(state);
      if (state === "saved") setLeaveHref(null);
    },
    send: (next) => sender.send(next),
  }));

  /** Saves the pending draft now; true when nothing is left unsaved. */
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    // Nothing more is sent once the draft is in conflict (#659).
    if (sender.isConflicted()) return false;
    return queue.flush();
  }, [queue, sender]);

  // Leaving for the roster (#643): save first, and warn instead of silently dropping an unsaved edit.
  const rosterHref = rosterHrefFromRegistration(organizationId, workspace.event.id);
  const [leaving, setLeaving] = useState(false);
  async function goToRoster(href: string) {
    if (leaving) return;
    setLeaving(true);
    setLeaveHref(null);
    await leaveAfterSave({
      flush,
      href,
      push: (to) => router.push(to),
      onUnsaved: (to) => { setLeaveHref(to); setLeaving(false); },
    });
  }
  function followRosterLink(event: { preventDefault: () => void; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number }, href: string) {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || (event.button ?? 0) !== 0) return;
    event.preventDefault();
    void goToRoster(href);
  }

  const queueSave = useCallback((next: DraftState) => {
    queue.set(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; if (!sender.isConflicted()) void queue.flush(false); }, 1200);
  }, [queue, sender]);

  const setTeamName = (next: string) => {
    setDraft((current) => {
      const updated = { ...current, teamName: next };
      queueSave(updated);
      return updated;
    });
  };

  const setLocationId = (next: string) => {
    setLocationNote(null);
    setDraft((current) => {
      const updated = { ...current, locationId: next };
      queueSave(updated);
      return updated;
    });
  };

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Back online: send whatever failed while the connection was down (#659).
  useEffect(() => {
    const retry = () => { if (queue.hasPending() && !sender.isConflicted()) void queue.flush(); };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [queue, sender]);

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
  // The event's team rules (#809), shown beside who is going; the server checks them again on save.
  const teamRules = workspace.teams.settings;
  const coachCount = selected.filter((person) => teamRoleFor({ responses: draft.attendeeResponses[person.clientId] ?? {}, rosterAttendeeType: person.attendeeType, rosterClassLevel: person.classLevel, maxMemberAge: teamRules?.maxMemberAge ?? null, age: person.ageOnEventDate }) === "COACH").length
    + draft.guests.filter((guest) => teamRoleFor({ responses: draft.attendeeResponses[clubGuestClientId(guest.id)] ?? {}, maxMemberAge: teamRules?.maxMemberAge ?? null, age: guest.age }) === "COACH").length;
  const teamMemberCount = goingCount - coachCount;
  // What will happen to people who are over the team-member age or 18 and over, said before the team is saved (#809).
  const teamHints: string[] = [];
  if (teamRules) {
    const hintFor = (name: string, age: number | null, role: "MEMBER" | "COACH") => {
      if (age === null || age < 18) return;
      if (role === "COACH" && teamRules.maxMemberAge !== null && age > teamRules.maxMemberAge) teamHints.push(`${name} is over the team-member age and will be listed as a coach.`);
      if (role === "MEMBER") teamHints.push(permissionPendingNotice(name));
    };
    for (const person of selected) {
      const age = person.ageOnEventDate ?? draft.rosterAges[person.memberId] ?? person.reportedAge ?? null;
      const role = teamRoleFor({ responses: draft.attendeeResponses[person.clientId] ?? {}, rosterAttendeeType: person.attendeeType, rosterClassLevel: person.classLevel, maxMemberAge: teamRules.maxMemberAge, age });
      hintFor(`${person.firstName} ${person.lastName}`.trim(), age, role);
    }
    for (const guest of draft.guests) {
      const role = teamRoleFor({ responses: draft.attendeeResponses[clubGuestClientId(guest.id)] ?? {}, maxMemberAge: teamRules.maxMemberAge, age: guest.age });
      hintFor(`${guest.firstName} ${guest.lastName}`.trim(), guest.age, role);
    }
  }
  const sizeLimits = teamRules && (teamRules.minTeamMembers !== null || teamRules.maxTeamMembers !== null)
    ? `${teamRules.minTeamMembers ?? 1} to ${teamRules.maxTeamMembers ?? "any number"}`
    : null;
  const sizeProblem = teamRules && ((teamRules.minTeamMembers !== null && teamMemberCount < teamRules.minTeamMembers)
    || (teamRules.maxTeamMembers !== null && teamMemberCount > teamRules.maxTeamMembers));
  const ageDateText = formatCalendarDate(workspace.event.ageDate);
  // Roster people with no birth date need an age typed in for this registration (#639).
  // The raw text of the age fields, so a half-typed entry is reported rather than read as blank.
  const [ageText, setAgeText] = useState<Record<string, string>>({});
  // Problems show only after Continue was pressed and blocked, or once a field is touched (#718).
  const [agesAttempted, setAgesAttempted] = useState(false);
  const missingAges = peopleMissingAges(workspace.roster, draft.selectedMemberIds, ageText, draft.rosterAges);

  function changeRosterAge(memberId: string, raw: string) {
    setAgeText((current) => ({ ...current, [memberId]: raw }));
    setDraft((current) => {
      // A blank or invalid entry clears the age; only whole numbers 0 to 120 are kept, like guests.
      const next = withRosterAge(current, memberId, parseTypedAge(raw), ageKey);
      queueSave(next);
      return next;
    });
  }

  function changeSaveToRoster(memberId: string, save: boolean) {
    setDraft((current) => {
      const off = current.rosterAgeSaveOff.filter((id) => id !== memberId);
      const next = { ...current, rosterAgeSaveOff: save ? off : [...off, memberId] };
      queueSave(next);
      return next;
    });
  }

  // Classes (#618, #650): chosen under each person's details, only when the event has classes at the
  // chosen site (or at no site), so an event without honors shows nothing extra.
  const honorAttendees = useMemo(
    () => pickingAttendees({ roster: workspace.roster, selectedMemberIds: draft.selectedMemberIds, guests: draft.guests, rosterAges: effectiveRosterAges(workspace.roster, draft.selectedMemberIds, ageText, draft.rosterAges) }),
    [workspace.roster, draft.selectedMemberIds, draft.guests, ageText, draft.rosterAges],
  );
  const honorOfferings = useMemo(
    () => (honorsCatalog ? offeringsAtLocation(honorsCatalog.offerings, locationId) : []),
    [honorsCatalog, locationId],
  );
  // A club that will be waitlisted holds no seats yet, so it picks no classes and is told why on Who's going.
  const hasHonors = honorOfferings.length > 0 && !chosenLocation?.full;
  const honorPicks = useMemo(
    () => prunePicks(draft.honorSelections, honorAttendees, honorOfferings),
    [draft.honorSelections, honorAttendees, honorOfferings],
  );
  // Who's going, each person's details (with their location and classes), then review.
  const totalSteps = 3;

  function changeHonors(clientId: string, ids: string[]) {
    setDraft((current) => {
      const updated = { ...current, honorSelections: { ...honorPicks, [clientId]: ids } };
      queueSave(updated);
      return updated;
    });
  }

  function leaveWho() {
    const first = missingAges[0];
    if (first) {
      setAgesAttempted(true);
      focusFirstMissingAge(ageFieldId(first.memberId), (id) => document.getElementById(id));
      return;
    }
    setAgesAttempted(false);
    void flush();
    setStep("form");
  }

  // Who still owes a class for a session they can take (#799 G3): said next to their name, never shown as done early.
  const classReadiness = useMemo(
    () => (hasHonors && honorsCatalog
      ? classChoiceReadiness({
        attendees: honorAttendees.map((person) => ({ ...person, id: person.clientId })),
        sessions: sortHonorSessions(honorsCatalog.sessions),
        offerings: honorOfferings,
        selections: honorPicks,
      })
      : null),
    [hasHonors, honorsCatalog, honorAttendees, honorOfferings, honorPicks],
  );

  // The same age, session and all-sessions rules the server applies on save, checked before anything is sent.
  const honorsProblem = hasHonors ? firstPickProblem(honorPicks, honorAttendees, honorOfferings) : null;

  /** A person's location and classes, shown under their name in the event form (C7, #650). */
  const renderAttendeeExtras = (attendee: RosterAttendee) => {
    const person = honorAttendees.find((candidate) => candidate.clientId === attendee.clientId);
    if (!chosenLocation && !hasHonors) return null;
    return (
      <section className="public-registration-attendee-section" aria-label={`Location and classes for ${person?.firstName ?? "this person"}`}>
        {chosenLocation && <p className="field-help">Location: <strong translate="no">{chosenLocation.name}</strong></p>}
        {hasHonors && honorsCatalog && person && (
          <fieldset className="club-class-person">
            <legend>
              <strong>Classes</strong>
              <small>
                {person.ageOnEventDate !== null ? <>Age <span translate="no">{person.ageOnEventDate}</span> · </> : null}
                {attendeeTypeLabel(person)}{person.consumesSeat ? "" : " · no seat needed"}
              </small>
            </legend>
            {classReadiness?.people.find((entry) => entry.attendeeId === person.clientId) && (
              <p className="class-person-status"><ClassStatus person={classReadiness.people.find((entry) => entry.attendeeId === person.clientId)!} /></p>
            )}
            <ClassPickFields
              attendee={person}
              offerings={honorOfferings}
              onChange={(ids) => changeHonors(attendee.clientId, ids)}
              picks={honorPicks[attendee.clientId] ?? []}
              sessions={honorsCatalog.sessions}
            />
          </fieldset>
        )}
      </section>
    );
  };

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
      // Compact attendee cards (#483): a roster person's card starts
      // collapsed, and any carried-over value that didn't match a form
      // option is prompted for instead of left silently blank.
      carriedFromRoster: true,
      carryoverMismatches: person.carryoverMismatches,
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
            attendeeType: guestIsAdult(guest) ? "ADULT" : "YOUTH",
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
    lockedRegistrationFieldKeys: workspace.directory.lockedFieldKeys,
    locationId,
    teamName: multipleTeams ? draft.teamName.trim() : null,
    noCost: workspace.event.noCost,
    draftKey: multipleTeams ? draft.draftKey : null,
    honorSelections: hasHonors ? honorPicks : {},
    renderAttendeeExtras,
    attendeeAttention: (attendee: RosterAttendee): AttentionItem[] => {
      const memberId = rosterMemberIdFromClientId(attendee.clientId);
      return [
        ...classAttention(classReadiness?.people.find((person) => person.attendeeId === attendee.clientId)),
        ...backgroundCheckAttention(memberId ? backgroundStates?.[memberId] : undefined),
      ];
    },
    blockedReason: draftBlockedReason({ conflict, honorsProblem }),
    submitUrl: `${base}/registration`,
    onDraftChange,
    onSubmitted: (result?: { honors?: { error?: string } | null }) => {
      if (timer.current) clearTimeout(timer.current);
      queue.submitted();
      // The registration is saved even when a class filled up meanwhile; the class picker on the next screen says so.
      if (result?.honors?.error) {
        try { sessionStorage.setItem(honorsNoteKey(organizationId, workspace.event.id), result.honors.error); } catch { /* the picker still shows the picks */ }
      }
      router.refresh();
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [initialAttendees, workspace.lockedAttendeeFieldKeys, workspace.directory.lockedFieldKeys, locationId, multipleTeams, draft.teamName, draft.draftKey, hasHonors, honorPicks, honorsProblem, conflict, honorAttendees, honorOfferings, classReadiness, backgroundStates, base, onDraftChange, router, organizationId, workspace.event.id, queue]);

  const saveLabel = conflict
    ? DRAFT_CONFLICT_MESSAGE
    : saveState === "saving" ? "Saving draft…" : saveState === "saved" ? "Draft saved" : saveState === "error" ? "Draft not saved. Check your connection." : "";
  const saveAction = conflict
    ? <button className="text-button" onClick={() => window.location.reload()} type="button">Reload</button>
    : saveState === "error"
      ? <button className="text-button" onClick={() => void flush()} type="button">Retry</button>
      : null;

  if (step === "form") {
    const { experience } = workspace;
    return (
      <div className="club-roster-stack">
        <div className="club-registration-toolbar">
          <button className="secondary-button" onClick={() => { void flush(); setStep("who"); }} type="button">
            <ArrowLeft aria-hidden="true" size={15} /> Change who’s going
          </button>
          <span className="public-registration-eyebrow">Step 2 of {totalSteps} · Each person&apos;s details{chosenLocation ? ` · ${chosenLocation.name}` : ""}</span>
          <span className="field-help" role="status">{saveLabel}{saveAction && <> {saveAction}</>}</span>
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
          <p className="public-registration-eyebrow">Step 1 of {totalSteps} · Who&apos;s going</p>
          <h2>Who&apos;s going?</h2>
        </div>
        <span className="count-badge">{goingCount} chosen</span>
      </div>
      {locationNote && <p className="field-help" role="status">{locationNote}</p>}
      {multipleTeams && (
        <div className="club-team-name">
          <label htmlFor="club-team-name">Team name</label>
          <input
            autoComplete="off"
            id="club-team-name"
            maxLength={80}
            onChange={(event) => setTeamName(event.target.value)}
            required
            value={draft.teamName}
          />
          <small className="field-help">Each team needs its own name, different from every other team at this event.</small>
        </div>
      )}
      <ClubLocationPicker allowWaitlist locations={locations} onChange={setLocationId} value={locationId} />
      <p>
        Tap everyone from your roster who is attending. Ages are as of {workspace.event.ageAsOf ? "" : "the first day of the event, "}
        {workspace.event.ageAsOf ? ageDateText : formatCalendarDate(chosenLocation?.firstDay ?? workspace.event.eventDate)}. Your choices save automatically.
      </p>
      {teamRules && (
        <div className={`inline-notice${sizeProblem ? " error" : ""}`} role="status">
          <strong>{teamMemberCount} team {teamMemberCount === 1 ? "member" : "members"}</strong>
          {sizeLimits ? <> (a team has {sizeLimits}{teamRules.maxAlternates > 0 ? `, including ${teamRules.maxAlternates === 1 ? "the alternate" : `up to ${teamRules.maxAlternates} alternates`}` : ""})</> : null}
          {" · "}{coachCount} {coachCount === 1 ? "coach" : "coaches"}. Coaches are adults who come with the team; they don&apos;t count toward the team.
          {teamRules.maxMemberAge !== null && <> A team member can be at most {teamRules.maxMemberAge} on {ageDateText}.</>}
          {teamRules.maxAlternates > 0 && <> You mark the alternate on the next step.</>}
        </div>
      )}
      {teamHints.length > 0 && (
        <ul className="inline-notice warning team-hints" role="status">
          {teamHints.map((hint) => <li key={hint}>{hint}</li>)}
        </ul>
      )}
      {workspace.roster.length === 0 ? (
        <p className="public-manage-empty">
          <UsersRound size={17} aria-hidden="true" /> Your roster is empty. Add regular members using Add to roster on the roster page, or import a CSV. You can add event-only guests when registering.
        </p>
      ) : (
        <>
          <div className="club-roster-tools">
            <span>
              <button className="text-button" onClick={() => selectAll(true)} type="button">Select everyone</button>
              {" · "}
              <button className="text-button" onClick={() => selectAll(false)} type="button">Clear</button>
            </span>
            <span className="field-help" role="status">{saveLabel}{saveAction && <> {saveAction}</>}</span>
          </div>
          {agesAttempted && missingAges.length > 0 && (
            <MissingAgeSummary missing={missingAges} />
          )}
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
                      {person.ageOnEventDate !== null
                        ? <> · Age <span translate="no">{person.ageOnEventDate}</span></>
                        : person.reportedAge !== null ? <> · Age <span translate="no">{person.reportedAge}</span> (reported)</> : ""}
                    </small>
                  </span>
                </label>
                {person.ageOnEventDate === null && draft.selectedMemberIds.includes(person.memberId) && (
                  <ClubRosterAgeField
                    attempted={agesAttempted}
                    error={ageInputProblem(person, ageText, draft.rosterAges)}
                    memberId={person.memberId}
                    value={ageInputValue(person, ageText, draft.rosterAges)}
                    onAge={(raw) => changeRosterAge(person.memberId, raw)}
                    href={rosterHref}
                    onNavigate={(event) => followRosterLink(event, rosterHref)}
                    onSaveToRoster={(save) => changeSaveToRoster(person.memberId, save)}
                    dateText={workspace.event.ageAsOf ? ageDateText : undefined}
                    organizationId={organizationId}
                    saveToRoster={!draft.rosterAgeSaveOff.includes(person.memberId)}
                  />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <section className="club-guest-section" aria-labelledby="club-guests-title">
        <div className="club-roster-tools">
          <span>
            <strong id="club-guests-title">Not on your roster</strong>
            <small className="field-help"> For this event only, e.g. a visiting parent. They won&apos;t be added to your roster.</small>
          </span>
          {!addingGuest && (
            <button className="secondary-button" onClick={() => { setGuestError(""); setAddingGuest(true); }} type="button">
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
              <label>{workspace.event.ageAsOf ? `Age on ${ageDateText}` : "Age at the event"}<input {...ageInputAttributes} name="age" required type="number" /></label>
              <label>
                Email (optional)
                <input autoComplete="off" maxLength={254} name="email" type="email" />
                <small className="field-help">Adults at youth events need to be in compliance with Sterling Volunteers; an email helps match it.</small>
              </label>
            </div>
            <div className="club-registration-toolbar">
              <button className="secondary-button" onClick={() => { setGuestError(""); setAddingGuest(false); }} type="button">Cancel</button>
              <button className="primary-button" type="submit"><UserPlus aria-hidden="true" size={15} /> Add</button>
            </div>
          </form>
        )}
      </section>

      {leaveHref && (
        <div className="inline-notice error" role="alert">
          Your latest changes aren&apos;t saved yet.{" "}
          <button className="text-button" onClick={() => { const href = leaveHref; setLeaveHref(null); void goToRoster(href); }} type="button">Retry</button>{" "}
          <button className="text-button" onClick={() => router.push(leaveHref)} type="button">Leave anyway</button>
        </div>
      )}
      {honorsCatalog && chosenLocation?.full && (
        <p className="inline-notice" role="status">This club will be waitlisted; pick classes after you&apos;re confirmed.</p>
      )}
      <div className="club-registration-toolbar club-sticky-bar">
        <Link className="secondary-button" href={rosterHref} onClick={(event) => followRosterLink(event, rosterHref)}>
          <UserPlus aria-hidden="true" size={15} /> {leaving ? "Saving…" : "Add someone new to the roster"}
        </Link>
        <button
          className="primary-button"
          disabled={goingCount === 0 || needsLocation || teamNameMissing}
          onClick={leaveWho}
          title={needsLocation ? "Choose a location first" : teamNameMissing ? "Name the team first" : undefined}
          type="button"
        >
          {continueButtonLabel({ missingAges: missingAges.length, goingCount, otherwiseDisabled: goingCount === 0 || needsLocation || teamNameMissing })} <ArrowRight aria-hidden="true" size={15} />
        </button>
      </div>
    </section>
  );
}
