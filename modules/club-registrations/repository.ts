import "server-only";

import { Prisma, RegistrationFormStatus } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { openBirthDate } from "@/modules/club-rosters/birth-dates";
import { ageOn, clubYearFor } from "@/modules/club-rosters/domain";
import {
  clubAttendeeClientId,
  clubDirectoryOwnedResponses,
  clubDirectoryPrefillResponses,
  clubDraftResponsesWithDirectory,
  clubExistingAttendeeClientId,
  clubFormProblem,
  clubGuestClientId,
  clubRegistrationEditWindow,
  type ClubDirectoryIdentity,
  type ClubRegistrationEditInput,
  formatCalendarDate,
  guestIdFromClientId,
  guestIsAdult,
  attendeeAgeKey,
  guestsFromJson,
  rosterAgeSaveOffFromJson,
  rosterAgesFromJson,
  type ClubGuest,
  lockedAttendeeFieldKeys,
  lockedClubDirectoryFieldKeys,
  rosterCarryoverMismatches,
  rosterGenderPrefill,
  rosterRolePrefill,
  rosterMemberIdFromClientId,
  rosterOwnedResponses,
  type RosterPerson,
} from "@/modules/club-registrations/domain";
import { pickClubPortalForm } from "@/modules/club-registrations/portal-form";
import { type RegistrationFormDefinition } from "@/modules/forms/definition";
import type { PublicRegistrationInput } from "@/modules/forms/public-domain";
import {
  PublicRegistrationError,
  getPublicRegistrationExperience,
  submitPublicRegistration,
  type ClubSubmissionContext,
} from "@/modules/forms/public-repository";
import {
  activeRegistrationStatuses,
  calendarDateInEventTimeZone,
} from "@/modules/events/lifecycle";
import { locationOpenProblem } from "@/modules/event-locations/admission";
import {
  effectiveLocationDates,
  evaluateLocationPhase,
  hasLocationEnded,
  remainingLocationSeats,
  type LocationDateSource,
} from "@/modules/event-locations/domain";
import { EventLocationError } from "@/modules/event-locations/errors";
import { isSeminarPreferenceField } from "@/modules/attendee-accounts/registration-answer-policy";
import {
  amendRegistration,
  currentRegistrationAnswers,
  previewRegistrationAmendment,
  storedRegistrationResponses,
  RegistrationAmendmentError,
  type AmendmentAttendeeServerOptions,
  type AmendmentServerOptions,
} from "@/modules/registrations/amendments-repository";
import { registrationOperationFingerprint } from "@/modules/registrations/operations-domain";
import type { RegistrationAmendmentInput } from "@/modules/registrations/schemas";
import { moneyToCents } from "@/modules/payments/square-domain";
import { getTeamSettings } from "@/modules/club-teams/settings-repository";
import { NO_TEAM_KEY, draftKeySchema, resolveTeamName, teamLabel, type TeamSettings } from "@/modules/club-teams/domain";
import { ClubTeamError } from "@/modules/club-teams/errors";
import { ALTERNATE_FIELD_KEY, isAlternateAnswer, teamAgeDate, teamRoleFor, teamRuleProblems, type TeamPerson } from "@/modules/club-teams/rules";
import { formHasPrices } from "@/modules/club-registrations/per-person-price";
import { permissionNotice, type PermissionStatus } from "@/modules/club-teams/permission-domain";
import { permissionNoticesForRegistration, permissionsForRegistration } from "@/modules/club-teams/permission-repository";
import { peopleOnOtherTeams, throwIfOnOtherTeams } from "@/modules/club-teams/registration-guard";
import { confirmationEmailStatusFromMessages, describeClubConfirmationEmail } from "@/modules/forms/confirmation-email-status";

// The registrant messages that confirm a club registration (or its waitlist spot).
const confirmationTemplateKeys = ["REGISTRATION_CONFIRMATION_PAID", "REGISTRATION_CONFIRMATION_UNPAID", "REGISTRATION_CONFIRMATION_ORGANIZATION_BILLED", "WAITLIST_JOINED", "WAITLIST_PROMOTED"] as const;
import { currentPricingSnapshot, perPersonPriceFromSnapshot } from "@/modules/club-registrations/per-person-price";
import {
  churchOwedCents,
  isChurchBilledStatus,
  sortChurchAmountsOwed,
  groupOwedRows,
  individualOwedRows,
  type ChurchAmountOwedRow,
} from "@/modules/club-registrations/church-owed";

/**
 * Club registration (#358): a director picks who's going from the roster and
 * submits the event's own published form. The result is an ordinary
 * registration billed to the church, linked to the club, one per club per
 * event. Birth dates stay in the roster; the registration keeps age only.
 */

export class ClubRegistrationError extends Error {
  constructor(
    public readonly code:
      | "EVENT_NOT_FOUND"
      | "FORM_UNAVAILABLE"
      | "MEMBER_NOT_ON_ROSTER"
      | "DRAFT_TOO_LARGE"
      | "DRAFT_CONFLICT"
      | "GUEST_INVALID"
      | "REGISTRATION_NOT_FOUND"
      | "REGISTRATION_CLOSED"
      | "ATTENDEES_INVALID"
      | "TEAM_INVALID"
      | "TEAM_NAME_TAKEN"
      | "CLASS_CHOICES_NOT_EDITABLE",
    message: string,
  ) {
    super(message);
    this.name = "ClubRegistrationError";
  }
}

const MAX_DRAFT_BYTES = 200_000;

/** Version-level status decides what is live; a draft beside it must not close club registration (#564). */
export async function publishedClubForm(eventId: string) {
  // Oldest first, ties by id: the same order `pickClubPortalForm` applies, which
  // owns the rule (and which the public event page uses for the same pick).
  const form = await getPrisma().registrationForm.findFirst({
    where: {
      eventId,
      versions: { some: { status: RegistrationFormStatus.PUBLISHED } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      slug: true,
      createdAt: true,
      versions: {
        where: { status: RegistrationFormStatus.PUBLISHED },
        orderBy: { versionNumber: "desc" },
        take: 1,
        select: { definition: true },
      },
    },
  });
  const version = form?.versions[0];
  if (!form || !version) return null;
  const picked = pickClubPortalForm([{ id: form.id, slug: form.slug, createdAt: form.createdAt, definition: version.definition }]);
  return picked ? { slug: picked.form.slug, definition: picked.definition } : null;
}

export const clubEventSelect = {
  id: true,
  slug: true,
  name: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  location: true,
  isPublished: true,
  registrationOpensOn: true,
  registrationClosesOn: true,
  waitlistEnabled: true,
  billingMode: true,
  supportContact: true,
} satisfies Prisma.EventSelect;

export type ClubEvent = Prisma.EventGetPayload<{ select: typeof clubEventSelect }>;

export const clubLocationSelect = {
  id: true,
  name: true,
  address: true,
  firstDay: true,
  lastDay: true,
  capacity: true,
  registrationClosesOn: true,
  isActive: true,
  sortOrder: true,
} satisfies Prisma.EventLocationSelect;

type ClubLocation = Prisma.EventLocationGetPayload<{ select: typeof clubLocationSelect }>;

/**
 * The registration phase a club sees (#413). With no location it is the
 * event's. With locations, a registration at a location follows that
 * location's dates, and a club that hasn't registered yet sees the event as
 * open while any active location still is (else upcoming, else closed).
 */
export function clubPhase(
  event: ClubEvent,
  locations: readonly ClubLocation[],
  registered: LocationDateSource | null,
  now: Date,
) {
  if (registered || locations.length === 0) return evaluateLocationPhase(event, registered, now);
  const phases = locations.map((location) => evaluateLocationPhase(event, location, now));
  return phases.includes("OPEN") ? "OPEN" as const : phases.includes("UPCOMING") ? "UPCOMING" as const : "CLOSED" as const;
}

/** What a director sees for one location: its own dates (the event's when unset), seats, and whether it can be picked. */
export function clubLocationView(event: ClubEvent, location: ClubLocation, occupied: number, now: Date) {
  const dates = effectiveLocationDates(event, location);
  const remaining = remainingLocationSeats(location.capacity, occupied);
  const phase = evaluateLocationPhase(event, location, now);
  return {
    id: location.id,
    name: location.name,
    address: location.address,
    firstDay: dates.firstDay,
    lastDay: dates.lastDay,
    registrationClosesOn: dates.registrationClosesOn,
    // Only when this location closes on its own date, so the picker doesn't repeat the event's (#413).
    ownClosingDate: location.registrationClosesOn !== null && location.registrationClosesOn !== event.registrationClosesOn
      ? location.registrationClosesOn
      : null,
    capacity: location.capacity,
    remaining,
    full: remaining !== null && remaining <= 0,
    // A full location can still be picked by a new registration when the event has a waitlist (#599).
    waitlistOnFull: event.waitlistEnabled,
    phase,
    open: phase === "OPEN",
    isActive: location.isActive,
  };
}

function pickDays(event: ClubEvent, location: LocationDateSource) {
  const { firstDay, lastDay } = effectiveLocationDates(event, location);
  return { firstDay, lastDay };
}

/** People registered at each of the event's locations, counted like the event capacity. */
export async function locationSeatCounts(client: Pick<Prisma.TransactionClient, "registration">, eventId: string, excludeRegistrationId?: string) {
  const rows = await client.registration.findMany({
    where: {
      eventId,
      locationId: { not: null },
      status: { in: [...activeRegistrationStatuses] },
      ...(excludeRegistrationId ? { id: { not: excludeRegistrationId } } : {}),
    },
    select: { locationId: true, _count: { select: { attendees: true } } },
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.locationId) counts.set(row.locationId, (counts.get(row.locationId) ?? 0) + row._count.attendees);
  }
  return counts;
}

/**
 * Events a club can register for: published, a CLUB audience (#481), billed to
 * the church, with a usable published form. Bulk club registration needs both:
 * a GENERAL event billed to an organization is not a club event, and a CLUB
 * event that is attendee-paid has no church bill for this workflow to build.
 */
export async function listClubEvents(organizationId: string, now = new Date()) {
  const events = await getPrisma().event.findMany({
    where: { isPublished: true, audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", endsAt: { gte: now } },
    orderBy: { startsAt: "asc" },
    select: {
      ...clubEventSelect,
      clubRegistrations: {
        where: { organizationId },
        // A club's teams (#809) in the order it registered them; an event without teams has just the one.
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          teamName: true,
          teamKey: true,
          registration: {
            select: {
              confirmationCode: true,
              status: true,
              _count: { select: { attendees: true } },
              location: { select: clubLocationSelect },
            },
          },
        },
      },
      clubRegistrationDrafts: { where: { organizationId }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], select: { updatedAt: true, selectedMemberIds: true, draftKey: true, teamName: true } },
      locations: { where: { isActive: true }, select: clubLocationSelect },
      teamSettings: { select: { allowMultipleTeams: true } },
    },
  });
  const results = [];
  for (const event of events) {
    const form = await publishedClubForm(event.id);
    const problem = form ? clubFormProblem(form.definition) : "The event has no published registration form yet.";
    const registration = event.clubRegistrations[0]?.registration ?? null;
    const draft = event.clubRegistrationDrafts[0] ?? null;
    const multipleTeams = event.teamSettings?.allowMultipleTeams === true;
    // A club may register another team at any open location, so where its first team is does not decide
    // what the event looks like to it (#809); an event without teams keeps following the registration's location.
    const registeredLocation = multipleTeams ? null : registration?.location ?? null;
    results.push({
      id: event.id,
      name: event.name,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      timezone: event.timezone,
      location: event.location,
      phase: clubPhase(event, event.locations, registeredLocation, now),
      registrationClosesOn: effectiveLocationDates(event, registeredLocation).registrationClosesOn,
      // The location this club registered at (#413), with its own dates.
      registeredLocation: registeredLocation
        ? { id: registeredLocation.id, name: registeredLocation.name, address: registeredLocation.address, ...pickDays(event, registeredLocation) }
        : null,
      hasLocations: event.locations.length > 0,
      available: !problem,
      problem,
      registration: registration
        ? {
          confirmationCode: registration.confirmationCode,
          status: registration.status,
          attendeeCount: registration._count.attendees,
        }
        : null,
      draft: draft ? { updatedAt: draft.updatedAt.toISOString(), selectedCount: draft.selectedMemberIds.length } : null,
      // The club's teams on an event that lets it register several (#809); empty otherwise.
      multipleTeams,
      teams: multipleTeams
        ? event.clubRegistrations.map((row) => ({
          teamKey: row.teamKey,
          teamName: row.teamName ?? "",
          confirmationCode: row.registration.confirmationCode,
          status: row.registration.status,
          attendeeCount: row.registration._count.attendees,
          locationName: row.registration.location?.name ?? null,
        }))
        : [],
      drafts: multipleTeams
        ? event.clubRegistrationDrafts.map((row) => ({ draftKey: row.draftKey, teamName: row.teamName, updatedAt: row.updatedAt.toISOString(), selectedCount: row.selectedMemberIds.length }))
        : [],
    });
  }
  return results;
}

export type ClubEventSummary = Awaited<ReturnType<typeof listClubEvents>>[number];

export type ClubEventRegistrationStep = { key: string; text: string; href: string; action: string };

/**
 * Club home's "What's next" (#478): one item per open club event the club
 * hasn't registered for yet, so a director always sees where to register —
 * not only on the Events tab. A club with a saved draft still gets
 * an item, worded to continue rather than start.
 */
export function clubEventRegistrationSteps(events: ClubEventSummary[], base: string): ClubEventRegistrationStep[] {
  return events
    .filter((event) => !event.registration && event.available && event.phase === "OPEN")
    .map((event) => ({
      key: event.id,
      text: `${event.draft ? "Finish registering" : "Register"} for ${event.name}${event.registrationClosesOn ? ` by ${formatCalendarDate(event.registrationClosesOn)}` : ""}.`,
      href: `${base}/events/${event.id}`,
      action: event.draft ? "Continue" : "Register",
    }));
}

/**
 * What each club's church owes for an event billed to the church (#409):
 * read-only, for staff finance screens. This is never an attendee or director
 * balance and never a card payment — the amount is the estimate the pricing
 * engine already recorded on the club's registration
 * (`Registration.totalAmount`), and only a submitted or confirmed
 * registration is billed. Waitlisted and cancelled clubs stay listed, owing $0.
 */
export async function listChurchAmountsOwed(eventId: string, options: { locationId?: string | null } = {}): Promise<ChurchAmountOwedRow[]> {
  const rows = await getPrisma().clubEventRegistration.findMany({
    where: { eventId, ...(options.locationId ? { registration: { locationId: options.locationId } } : {}) },
    select: {
      teamName: true,
      organization: {
        select: { id: true, name: true, parentOrganization: { select: { id: true, name: true } } },
      },
      registration: {
        select: {
          confirmationCode: true,
          status: true,
          totalAmount: true,
          location: { select: { name: true } },
          _count: { select: { attendees: true } },
        },
      },
    },
  });
  const clubRows: ChurchAmountOwedRow[] = rows.map((row) => ({
    organizationId: row.organization.id,
    organizationName: row.organization.name,
    churchId: row.organization.parentOrganization?.id ?? null,
    churchName: row.organization.parentOrganization?.name ?? null,
    confirmationCode: row.registration.confirmationCode,
    status: row.registration.status,
    attendeeCount: row.registration._count.attendees,
    isBilled: isChurchBilledStatus(row.registration.status),
    amountOwedCents: churchOwedCents(row.registration.status, moneyToCents(row.registration.totalAmount)),
    ...(row.registration.location ? { locationName: row.registration.location.name } : {}),
    ...(row.teamName ? { teamName: row.teamName } : {}),
  }));
  // A church-billed event whose registrations are not club registrations (#606: Leadership Weekend, Outdoor
  // School) is reported by the organization each form names. Club events keep exactly the rows above.
  // Only a GENERAL event: a CLUB event (Spring Camporee) keeps club rows only, whatever else is registered on it.
  const event = await getPrisma().event.findUnique({ where: { id: eventId }, select: { billingMode: true, audience: true } });
  // "Group" registrations (#650) are billed to their own contact, never to a church: their own rows, on club events only.
  if (event?.billingMode === "DEFERRED_ORGANIZATION_INVOICE" && event.audience === "CLUB") {
    const groupLinks = await getPrisma().groupEventRegistration.findMany({
      where: {
        eventId,
        registration: {
          status: { in: ["SUBMITTED", "CONFIRMED", "WAITLISTED", "CANCELLED"] },
          ...(options.locationId ? { locationId: options.locationId } : {}),
        },
      },
      select: {
        registration: {
          select: {
            id: true,
            confirmationCode: true,
            status: true,
            totalAmount: true,
            location: { select: { name: true } },
            accountHolderPerson: { select: { firstName: true, lastName: true, normalizedEmail: true } },
            contactSnapshot: true,
            _count: { select: { attendees: true } },
          },
        },
      },
    });
    const groupRows = groupOwedRows(groupLinks.map(({ registration }) => {
      const contact = recordFromJson(registration.contactSnapshot);
      const name = `${typeof contact.firstName === "string" ? contact.firstName : registration.accountHolderPerson.firstName} ${typeof contact.lastName === "string" ? contact.lastName : registration.accountHolderPerson.lastName}`.trim();
      return {
        registrationId: registration.id,
        confirmationCode: registration.confirmationCode,
        status: registration.status,
        totalAmountCents: moneyToCents(registration.totalAmount),
        attendeeCount: registration._count.attendees,
        contactName: name || "Group contact",
        contactEmail: typeof contact.email === "string" ? contact.email : registration.accountHolderPerson.normalizedEmail,
        locationName: registration.location?.name ?? null,
      };
    }));
    return sortChurchAmountsOwed([...clubRows, ...groupRows]);
  }
  if (event?.billingMode !== "DEFERRED_ORGANIZATION_INVOICE" || event.audience !== "GENERAL") return sortChurchAmountsOwed(clubRows);
  const individuals = await getPrisma().registration.findMany({
    where: {
      eventId,
      clubRegistration: null,
      status: { in: ["SUBMITTED", "CONFIRMED", "WAITLISTED", "CANCELLED"] },
      ...(options.locationId ? { locationId: options.locationId } : {}),
    },
    select: {
      id: true,
      confirmationCode: true,
      status: true,
      totalAmount: true,
      location: { select: { name: true } },
      accountHolderPerson: { select: { firstName: true, lastName: true } },
      publicFormSubmission: { select: { responses: true } },
      // The latest amendment's snapshot wins over the original answers, as in the amendment engine.
      operations: { where: { type: "AMENDMENT" }, orderBy: { createdAt: "desc" }, take: 1, select: { afterSnapshot: true } },
      _count: { select: { attendees: true } },
    },
  });
  return sortChurchAmountsOwed([...clubRows, ...individualOwedRows(individuals.map((registration) => ({
    id: registration.id,
    confirmationCode: registration.confirmationCode,
    status: registration.status,
    totalAmountCents: moneyToCents(registration.totalAmount),
    attendeeCount: registration._count.attendees,
    registrantName: `${registration.accountHolderPerson.firstName} ${registration.accountHolderPerson.lastName}`.trim(),
    responses: storedRegistrationResponses(registration),
    locationName: registration.location?.name ?? null,
  })))]);
}

export type ChurchAmountOwed = ChurchAmountOwedRow;

export type ClubCheckInInfo = {
  organizationId: string;
  organizationName: string;
  confirmationCode: string;
  /** The team's name (#809), on an event where a club registers several; absent otherwise. */
  teamName?: string;
  /** Read-only estimate billed to the church (#409); never an attendee balance or a door payment. */
  amountOwedCents: number;
  /** The event location the club registered at (#413); null when the event has none. */
  locationName?: string | null;
};

/**
 * Clubs eligible for check-in at this event (#412): one row per active
 * (submitted or confirmed) club registration, the same eligibility rule
 * single-attendee check-in already enforces. Lets check-in staff find a
 * whole club by confirmation code or club name and see what its church owes,
 * without exposing an attendee balance or a payment action.
 */
export async function listClubCheckInInfo(eventId: string, options: { locationId?: string | null } = {}): Promise<ClubCheckInInfo[]> {
  const rows = await getPrisma().clubEventRegistration.findMany({
    where: {
      eventId,
      registration: {
        status: { in: [...activeRegistrationStatuses] },
        ...(options.locationId ? { locationId: options.locationId } : {}),
      },
    },
    select: {
      teamName: true,
      organization: { select: { id: true, name: true } },
      registration: { select: { confirmationCode: true, status: true, totalAmount: true, location: { select: { name: true } } } },
    },
  });
  return rows.map((row) => ({
    organizationId: row.organization.id,
    // A team shows as "Team (Club)", so check-in lists and finds each team by either name (#809).
    organizationName: teamLabel(row.organization.name, row.teamName),
    ...(row.teamName ? { teamName: row.teamName } : {}),
    confirmationCode: row.registration.confirmationCode,
    amountOwedCents: churchOwedCents(row.registration.status, moneyToCents(row.registration.totalAmount)),
    // Only when the club registered at a location, so an event without locations returns what it always did (#413).
    ...(row.registration.location ? { locationName: row.registration.location.name } : {}),
  }));
}

/** The club and its sponsoring church, straight from the `Organization`
 * record — never from anything a client sends (#482). An inactive church is
 * treated as none, so it is never offered as the default. */
async function clubDirectoryIdentity(
  client: Pick<Prisma.TransactionClient, "organization">,
  organizationId: string,
): Promise<ClubDirectoryIdentity> {
  const organization = await client.organization.findUnique({
    where: { id: organizationId },
    select: { name: true, parentOrganization: { select: { name: true, isActive: true } } },
  });
  const church = organization?.parentOrganization;
  return { clubName: organization?.name ?? "", churchName: church?.isActive ? church.name : null };
}

export async function requireClubEvent(eventId: string): Promise<ClubEvent> {
  const event = await getPrisma().event.findFirst({
    // Same gate as `listClubEvents`: CLUB audience and church billing (#481).
    where: { id: eventId, isPublished: true, audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE" },
    select: clubEventSelect,
  });
  if (!event) throw new ClubRegistrationError("EVENT_NOT_FOUND", "That club event could not be found.");
  return event;
}

function rosterPerson(
  member: { sealedBirthDate: string | null; gender: "FEMALE" | "MALE" | null; person: { firstName: string; lastName: string } | null },
  eventDate: string,
): RosterPerson {
  return {
    firstName: member.person?.firstName ?? "",
    lastName: member.person?.lastName ?? "",
    ageOnEventDate: member.sealedBirthDate ? ageOn(openBirthDate(member.sealedBirthDate), eventDate) : null,
    gender: member.gender,
  };
}

async function activeRosterFor(client: Prisma.TransactionClient, organizationId: string, event: Pick<ClubEvent, "startsAt">) {
  return client.clubRosterMember.findMany({
    where: { organizationId, clubYear: clubYearFor(event.startsAt), status: "ACTIVE", personId: { not: null } },
    select: {
      id: true,
      personId: true,
      attendeeType: true,
      classLevel: true,
      role: true,
      gender: true,
      sealedBirthDate: true,
      reportedAge: true,
      person: { select: { firstName: true, lastName: true } },
    },
  });
}

/**
 * Saves an age a director changed back to the roster as the member's
 * reported age (#639), inside the caller's transaction. Only an active member
 * of this club and club year with no birth date is ever touched (the filter is
 * part of the write), and a birth date is never written or guessed from an age.
 */
async function saveRosterAgesBack(
  tx: Prisma.TransactionClient,
  organizationId: string,
  clubYear: string,
  actor: ClubRegistrationActor,
  updates: ReadonlyArray<{ memberId: string; age: number }>,
) {
  for (const { memberId, age } of updates) {
    // Same row filter as the active roster (this club, this club year, ACTIVE), so an erased or
    // transferred row is never written. `reportedAge IS NULL` is spelled out because
    // `NOT (reportedAge = age)` is never true for NULL in SQL.
    const result = await tx.clubRosterMember.updateMany({
      where: {
        id: memberId,
        organizationId,
        clubYear,
        status: "ACTIVE",
        sealedBirthDate: null,
        OR: [{ reportedAge: null }, { reportedAge: { not: age } }],
      },
      data: { reportedAge: age },
    });
    if (result.count === 0) continue;
    await writeAuditLog({
      ...("userId" in actor ? { actorUserId: actor.userId } : {}),
      action: "CLUB_ROSTER_MEMBER_UPDATED",
      entityType: "ClubRosterMember",
      entityId: memberId,
      summary: "Updated a person on a club roster.",
      metadata: {
        organizationId,
        ...("accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : { actAsId: actor.actAsId }),
        fields: ["reportedAge"],
        source: "CLUB_REGISTRATION",
      },
    }, tx);
  }
}

/** The director edit window (#366) for a registration, on its location's dates when it has one (#413). */
export function clubEditWindow(event: ClubEvent, location: (LocationDateSource & { name?: string }) | null, now: Date) {
  const dates = effectiveLocationDates(event, location);
  return clubRegistrationEditWindow({
    phase: evaluateLocationPhase(event, location, now),
    registrationClosesOn: dates.registrationClosesOn,
    today: calendarDateInEventTimeZone(now, event.timezone),
    eventDate: dates.firstDay,
    ended: hasLocationEnded(event, location, now),
    locationName: location?.name ?? null,
  });
}

/**
 * Which of a club's teams the director's page is showing (#809), on an event that lets a club register several:
 * a registered team by its key, or an unsubmitted draft by its draft key. Ignored on every other event.
 */
export type ClubWorkspaceSelection = { teamKey?: string | null; draftKey?: string | null };

/** Everything the director's page needs for one club event. */
export async function getClubEventWorkspace(organizationId: string, eventId: string, now = new Date(), selection: ClubWorkspaceSelection = {}) {
  const event = await requireClubEvent(eventId);
  const eventDate = calendarDateInEventTimeZone(event.startsAt, event.timezone);
  const teamSettings = await getTeamSettings(eventId);
  const multipleTeams = teamSettings?.allowMultipleTeams === true;
  // The date ages are counted on (#809): the event's own age date when it has one, else its first day.
  const ageDate = teamAgeDate(teamSettings, eventDate);
  // An event without teams has the one registration and the one draft it always had, under the empty keys.
  const selectedTeamKey = multipleTeams ? selection.teamKey ?? null : NO_TEAM_KEY;
  const selectedDraftKey = multipleTeams ? selection.draftKey ?? null : NO_TEAM_KEY;
  const [form, members, clubRegistration, draft, identity, eventLocations, registeredTeams, savedDrafts] = await Promise.all([
    publishedClubForm(event.id),
    activeRosterFor(getPrisma(), organizationId, event),
    selectedTeamKey === null ? Promise.resolve(null) : getPrisma().clubEventRegistration.findUnique({
      where: { eventId_organizationId_teamKey: { eventId, organizationId, teamKey: selectedTeamKey } },
      select: {
        id: true,
        teamName: true,
        teamKey: true,
        createdAt: true,
        registrationId: true,
        // Staff's results for the team (#809), shown to the director read only.
        teamResults: { select: { level: true, placement: true, qualified: true, notes: true, updatedAt: true } },
        registration: {
          select: {
            confirmationCode: true,
            status: true,
            updatedAt: true,
            totalAmount: true,
            _count: { select: { adjustments: true } },
            publicFormSubmission: { select: { pricingSnapshot: true } },
            // The latest amendment's pricing wins over the original submission's (#621).
            operations: { where: { type: "AMENDMENT" }, orderBy: { createdAt: "desc" }, take: 1, select: { afterSnapshot: true } },
            location: { select: clubLocationSelect },
            attendees: { orderBy: { position: "asc" }, select: { id: true, profileSnapshot: true, formResponses: true } },
            // The real delivery state of the confirmation email (#642).
            messages: {
              where: { recipientKind: "REGISTRANT", templateKey: { in: [...confirmationTemplateKeys] } },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { status: true },
            },
          },
        },
      },
    }),
    selectedDraftKey === null ? Promise.resolve(null) : getPrisma().clubRegistrationDraft.findUnique({
      where: { eventId_organizationId_draftKey: { eventId, organizationId, draftKey: selectedDraftKey } },
    }),
    clubDirectoryIdentity(getPrisma(), organizationId),
    getPrisma().eventLocation.findMany({
      where: { eventId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { name: "asc" }],
      select: clubLocationSelect,
    }),
    // The club's teams and unsubmitted drafts (#809): what the page lists beside the one it is showing.
    multipleTeams
      ? getPrisma().clubEventRegistration.findMany({
        where: { eventId, organizationId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { teamName: true, teamKey: true, registration: { select: { confirmationCode: true, status: true, _count: { select: { attendees: true } }, location: { select: { name: true } } } } },
      })
      : Promise.resolve([]),
    multipleTeams
      ? getPrisma().clubRegistrationDraft.findMany({
        where: { eventId, organizationId },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        select: { draftKey: true, teamName: true, updatedAt: true, selectedMemberIds: true },
      })
      : Promise.resolve([]),
  ]);
  // Locations (#413): seats are counted like the event capacity, leaving out
  // this club's own registration so it never sees its own seats as taken.
  const registeredLocation = clubRegistration?.registration.location ?? null;
  const seatCounts = eventLocations.length > 0
    ? await locationSeatCounts(getPrisma(), eventId, clubRegistration?.registrationId)
    : new Map<string, number>();
  const problem = form ? clubFormProblem(form.definition) : "The event has no published registration form yet.";
  const experience = form && !problem ? await getPublicRegistrationExperience(event.slug, form.slug) : null;
  const activeMemberIds = new Set(members.map((member) => member.id));
  // A team event with nothing to pay (#809): no priced form field, no lodging, and for a registered team no charge or
  // adjustment on it. Then the page says "No cost." instead of "billed to your church".
  const noCost = teamSettings !== null && experience !== null && !formHasPrices(experience.form.definition)
    && (await getPrisma().eventLodging.findUnique({ where: { eventId }, select: { eventId: true } })) === null
    && (clubRegistration === null || (moneyToCents(clubRegistration.registration.totalAmount) === 0 && clubRegistration.registration._count.adjustments === 0));
  // Where the Area Coordinator's permission stands for each team member of 18 or older (#809).
  const permissions = clubRegistration ? await permissionsForRegistration(clubRegistration.id) : new Map<string, { status: PermissionStatus; decidedAt: string | null; decidedBy: string | null }>();
  const registrationAnswers = clubRegistration
    ? await currentRegistrationAnswers(eventId, clubRegistration.registrationId)
    : null;
  const roster = members
    .map((member) => {
      const person = rosterPerson(member, ageDate);
      return {
        memberId: member.id,
        clientId: clubAttendeeClientId(member.id),
        firstName: person.firstName,
        lastName: person.lastName,
        ageOnEventDate: person.ageOnEventDate,
        // An age a form reported for someone with no birth date (#376); prefills the age field (#639).
        reportedAge: member.sealedBirthDate ? null : member.reportedAge,
        attendeeType: member.attendeeType,
        classLevel: member.classLevel,
        role: member.role,
        ownedResponses: experience ? rosterOwnedResponses(experience.form.definition, person) : {},
        prefillResponses: experience
          ? {
            // The reported age starts the form's age answer until one is typed in (#639).
            ...(person.ageOnEventDate === null && member.reportedAge !== null && attendeeAgeKey(experience.form.definition)
              ? { [attendeeAgeKey(experience.form.definition)!]: String(member.reportedAge) }
              : {}),
            ...rosterGenderPrefill(experience.form.definition, person),
            ...rosterRolePrefill(experience.form.definition, { ...person, role: member.role, attendeeType: member.attendeeType }),
          }
          : {},
        // Carried-over values that don't match a form option, so the form can
        // prompt for them instead of leaving the field silently blank (#483).
        carryoverMismatches: experience
          ? rosterCarryoverMismatches(experience.form.definition, { ...person, role: member.role, attendeeType: member.attendeeType })
          : [],
      };
    })
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
  return {
    event: {
      id: event.id,
      name: event.name,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      timezone: event.timezone,
      eventDate,
      /** The date ages are counted on, and whether the event sets it itself rather than using its first day (#809). */
      ageDate,
      ageAsOf: teamSettings?.ageAsOf != null,
      noCost,
      phase: clubPhase(event, eventLocations, registeredLocation, now),
      ended: hasLocationEnded(event, registeredLocation, now),
      registrationClosesOn: effectiveLocationDates(event, registeredLocation).registrationClosesOn,
      // Whether a submitted registration may still be reopened (H3b, #366),
      // on its location's dates when it has one (#413).
      edit: clubEditWindow(event, registeredLocation, now),
    },
    // The event's active locations (#413). Empty: the event works as always.
    locations: eventLocations.map((location) => clubLocationView(event, location, seatCounts.get(location.id) ?? 0, now)),
    problem,
    experience,
    lockedAttendeeFieldKeys: experience ? lockedAttendeeFieldKeys(experience.form.definition) : [],
    /** The event form's attendee age question, if it has one (#639). */
    attendeeAgeKey: experience ? attendeeAgeKey(experience.form.definition) : null,
    // The directory fields (#482): the club is always the director's own and
    // locked (enforced again server-side by `clubDirectoryOwnedResponses`);
    // the church starts as the club's sponsoring church but stays editable.
    directory: {
      lockedFieldKeys: experience ? lockedClubDirectoryFieldKeys(experience.form.definition) : [],
      prefillResponses: experience ? clubDirectoryPrefillResponses(experience.form.definition, identity) : {},
    },
    roster,
    // The team rules (#809); null on an event without teams.
    teams: {
      multiple: multipleTeams,
      settings: teamSettings,
      registered: registeredTeams.map((row) => ({
        teamKey: row.teamKey,
        teamName: row.teamName ?? "",
        confirmationCode: row.registration.confirmationCode,
        status: row.registration.status,
        attendeeCount: row.registration._count.attendees,
        locationName: row.registration.location?.name ?? null,
      })),
      drafts: savedDrafts.map((row) => ({
        draftKey: row.draftKey,
        teamName: row.teamName,
        updatedAt: row.updatedAt.toISOString(),
        selectedCount: row.selectedMemberIds.length,
      })),
    },
    registration: clubRegistration
      ? {
        teamKey: clubRegistration.teamKey,
        teamName: clubRegistration.teamName ?? "",
        // What the director is told about team members of 18 or older: pending, declined and granted (#809).
        permissionNotices: clubRegistration.registration.attendees.flatMap(({ id, profileSnapshot, formResponses }) => {
          const flag = permissions.get(id);
          if (!flag) return [];
          const snapshot = recordFromJson(profileSnapshot);
          // A TLT is always a team member, so "make them a coach" is not an option for them.
          const rosterId = typeof snapshot.clubRosterMemberId === "string" ? snapshot.clubRosterMemberId : null;
          const answered = recordFromJson(formResponses).attendee_type;
          const tlt = members.find((member) => member.id === rosterId)?.classLevel === "TLT" || (typeof answered === "string" && answered.trim().toLowerCase() === "tlt");
          return [{ attendeeId: id, status: flag.status, text: permissionNotice(flag.status, snapshotName(snapshot), tlt) }];
        }),
        results: clubRegistration.teamResults.map((result) => ({
          level: result.level, placement: result.placement, qualified: result.qualified, notes: result.notes,
        })),
        confirmationCode: clubRegistration.registration.confirmationCode,
        status: clubRegistration.registration.status,
        submittedAt: clubRegistration.createdAt.toISOString(),
        updatedAt: clubRegistration.registration.updatedAt.toISOString(),
        // Saved and emailed are separate outcomes (#642).
        confirmationEmail: describeClubConfirmationEmail(
          confirmationEmailStatusFromMessages(clubRegistration.registration.messages.map((message) => message.status)),
          event.supportContact,
        ),
        // Where this club registered (#413), even if the location was deactivated since.
        location: registeredLocation
          ? clubLocationView(event, registeredLocation, seatCounts.get(registeredLocation.id) ?? 0, now)
          : null,
        // The director sees the per-person price only, never what the church
        // owes (#621); the amount stays on the staff finance views (#409).
        perPerson: perPersonPriceFromSnapshot(
          currentPricingSnapshot(clubRegistration.registration),
          true,
          clubRegistration.registration.attendees.map(({ profileSnapshot }) => {
            const snapshot = recordFromJson(profileSnapshot);
            return `${typeof snapshot.firstName === "string" ? snapshot.firstName : ""} ${typeof snapshot.lastName === "string" ? snapshot.lastName : ""}`.trim();
          }),
        ),
        // The registration-scope answers as they stand now, so a reopened
        // edit can evaluate attendee questions that depend on them. The
        // edit never changes these.
        registrationResponses: registrationAnswers?.responses ?? {},
        attendees: clubRegistration.registration.attendees.map(({ id, profileSnapshot, formResponses }) => {
          const snapshot = profileSnapshot as {
            firstName?: string;
            lastName?: string;
            ageOnEventDate?: number | null;
            temporary?: boolean;
            clubRosterMemberId?: string;
            clubGuestId?: string;
            teamRole?: string;
          };
          const temporary = snapshot.temporary === true;
          const clubRosterMemberId = snapshot.clubRosterMemberId ?? null;
          return {
            attendeeId: id,
            firstName: snapshot.firstName ?? "",
            lastName: snapshot.lastName ?? "",
            ageOnEventDate: snapshot.ageOnEventDate ?? null,
            // On a team (#809): a coach, and whether the person is the alternate; null/false on any other event.
            teamRole: snapshot.teamRole === "COACH" || snapshot.teamRole === "MEMBER" ? snapshot.teamRole : null,
            alternate: isAlternateAnswer(recordFromJson(formResponses)[ALTERNATE_FIELD_KEY]),
            permission: permissions.get(id) ?? null,
            temporary,
            // For seeding a reopened edit (H3b, #366): which roster person
            // or extra person this attendee is. An extra person submitted
            // before guests carried an id is known by their attendee id,
            // which the edit endpoint accepts the same way.
            clubRosterMemberId,
            guestId: temporary ? (snapshot.clubGuestId ?? id) : null,
            // Registered, but no longer on the club's active roster: the
            // edit shows them separately, kept unless the director unticks.
            offRoster: !temporary && !(clubRosterMemberId && activeMemberIds.has(clubRosterMemberId)),
            responses: (formResponses as Record<string, unknown> | null) ?? {},
          };
        }),
      }
      : null,
    draft: draft
      ? {
        draftKey: draft.draftKey,
        teamName: draft.teamName,
        selectedMemberIds: draft.selectedMemberIds,
        guests: guestsFromJson(draft.guests),
        // The locked club (and a missing church) come from the directory,
        // not the draft (#482).
        responses: experience
          ? clubDraftResponsesWithDirectory(experience.form.definition, identity, draft.responses as Record<string, unknown>)
          : draft.responses as Record<string, unknown>,
        attendeeResponses: draft.attendeeResponses as Record<string, Record<string, unknown>>,
        honorSelections: recordFromJson(draft.honorSelections) as Record<string, string[]>,
        rosterAges: rosterAgesFromJson(draft.rosterAges),
        rosterAgeSaveOff: rosterAgeSaveOffFromJson(draft.rosterAgeSaveOff),
        // The page revalidates this against the locations above (#659).
        locationId: draft.locationId,
        revision: draft.revision,
        updatedAt: draft.updatedAt.toISOString(),
      }
      : null,
  };
}

export type ClubEventWorkspace = Awaited<ReturnType<typeof getClubEventWorkspace>>;

export type ClubRegistrationDraftInput = {
  selectedMemberIds: string[];
  guests: ClubGuest[];
  responses: Record<string, unknown>;
  attendeeResponses: Record<string, Record<string, unknown>>;
  /** Honors picked while registering (#618), by the event form's client id. */
  honorSelections?: Record<string, string[]>;
  /** Ages typed in for roster people with no birth date on file (#639), by roster member id. */
  rosterAges?: Record<string, number>;
  /** Roster members whose typed-in age is not also saved to the roster at submit (#639). */
  rosterAgeSaveOff?: string[];
  /** The location picked so far (#659). A draft reserves no seats; it is checked again on restore. */
  locationId?: string | null;
  /** Which of the club's drafts this is (#809): `''` on an event without teams, else the id the page picked for this team. */
  draftKey?: string;
  /** The team name typed so far (#809); only kept on an event with teams. */
  teamName?: string;
  /** The revision this save was based on (0 when the page loaded with no draft). An older one is refused (#659). */
  baseRevision: number;
  /** Names one logical snapshot; a retry of the same snapshot reuses it, so a save whose response was lost isn't a conflict (#659). */
  saveId: string;
};

/** Never an attendee account credited for a staff action (#442): `userId` for a staff "act as" director. */
export type ClubRegistrationActor = { accountId: string } | { userId: string; actAsId: string };

/**
 * The draft a request names, against what the event allows (#809): an event with several teams per club needs the id the
 * page picked for the team, and one without has only the empty key, so a stray id can never start a second draft there.
 */
export function clubDraftKey(settings: Pick<TeamSettings, "allowMultipleTeams"> | null, requested: string | undefined): string {
  if (!settings?.allowMultipleTeams) {
    if (requested) throw new ClubRegistrationError("TEAM_INVALID", "This event takes one registration per club.");
    return NO_TEAM_KEY;
  }
  const parsed = draftKeySchema.safeParse(requested ?? "");
  if (!parsed.success) throw new ClubRegistrationError("TEAM_INVALID", parsed.error.issues[0]?.message ?? "Refresh the page and start the team again.");
  return parsed.data;
}

/** Saves the director's work in progress. People are roster IDs from this club only. */
export async function saveClubRegistrationDraft(
  organizationId: string,
  eventId: string,
  actor: ClubRegistrationActor,
  input: ClubRegistrationDraftInput,
) {
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_DRAFT_BYTES) {
    throw new ClubRegistrationError("DRAFT_TOO_LARGE", "This draft is too large to save.");
  }
  const event = await requireClubEvent(eventId);
  const teamSettings = await getTeamSettings(eventId);
  const draftKey = clubDraftKey(teamSettings, input.draftKey);
  const members = await activeRosterFor(getPrisma(), organizationId, event);
  const allowed = new Set(members.map((member) => member.id));
  if (input.selectedMemberIds.some((memberId) => !allowed.has(memberId))) {
    throw new ClubRegistrationError("MEMBER_NOT_ON_ROSTER", "Everyone going must be active on your club roster.");
  }
  const guestKeys = new Set(input.guests.map((guest) => clubGuestClientId(guest.id)));
  if (guestKeys.size !== input.guests.length) {
    throw new ClubRegistrationError("GUEST_INVALID", "Each extra person needs their own entry. Refresh the page and try again.");
  }
  const attendeeResponses = Object.fromEntries(
    Object.entries(input.attendeeResponses).filter(([key]) => allowed.has(key) || guestKeys.has(key)),
  );
  const pickable = new Set([...input.selectedMemberIds.map(clubAttendeeClientId), ...guestKeys]);
  const honorSelections = Object.fromEntries(
    Object.entries(input.honorSelections ?? {}).filter(([key, ids]) => pickable.has(key) && ids.length > 0),
  );
  // Only for people going who really have no birth date: a roster age always wins.
  const rosterAges = Object.fromEntries(
    members
      .filter((member) => !member.sealedBirthDate && input.selectedMemberIds.includes(member.id))
      .flatMap((member) => {
        const age = input.rosterAges?.[member.id];
        return age === undefined ? [] : [[member.id, age] as const];
      }),
  );
  const rosterAgeSaveOff = (input.rosterAgeSaveOff ?? []).filter((memberId) => memberId in rosterAges);
  const data = {
    rosterAges: rosterAges as Prisma.InputJsonValue,
    rosterAgeSaveOff: rosterAgeSaveOff as Prisma.InputJsonValue,
    honorSelections: honorSelections as Prisma.InputJsonValue,
    selectedMemberIds: input.selectedMemberIds,
    guests: input.guests as Prisma.InputJsonValue,
    responses: input.responses as Prisma.InputJsonValue,
    attendeeResponses: attendeeResponses as Prisma.InputJsonValue,
    teamName: teamSettings?.allowMultipleTeams ? (input.teamName ?? "").slice(0, 200) : "",
    ...("accountId" in actor ? { updatedByAccountId: actor.accountId, updatedByUserId: null } : { updatedByUserId: actor.userId, updatedByAccountId: null }),
  };
  // Only a location of this event is kept; anything else is dropped, not an error.
  const location = input.locationId
    ? await getPrisma().eventLocation.findFirst({ where: { id: input.locationId, eventId, isActive: true }, select: { id: true } })
    : null;
  const fields = { ...data, locationId: location?.id ?? null, lastSaveId: input.saveId };
  const where = { eventId_organizationId_draftKey: { eventId, organizationId, draftKey } };
  const select = { updatedAt: true, revision: true, lastSaveId: true } as const;
  const done = (draft: { updatedAt: Date; revision: number }) => ({ updatedAt: draft.updatedAt.toISOString(), revision: draft.revision });
  const conflict = new ClubRegistrationError(
    "DRAFT_CONFLICT",
    "This draft changed in another tab or window. Reload the page to see the latest version.",
  );
  // A save whose response was lost and is now being retried already landed: same save id, one revision on.
  const alreadySaved = (draft: { revision: number; lastSaveId: string | null }, revision: number) =>
    draft.lastSaveId === input.saveId && draft.revision === revision;
  // The write is one short transaction that first takes the same lock a team-rules save takes (#809), so a draft is never
  // saved under the one-per-club key just as the event switches to teams, or the reverse; the rules are read again under it.
  return getPrisma().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR SHARE`;
    const current = await getTeamSettings(eventId, tx);
    if ((current?.allowMultipleTeams === true) !== (teamSettings?.allowMultipleTeams === true)) {
      throw new ClubRegistrationError("TEAM_INVALID", "This event's team rules changed while you were working. Reload the page and try again.");
    }
    // Optimistic revision (#659): only a save based on the current revision lands,
    // and the write and the read-back are one statement.
    try {
      return done(await tx.clubRegistrationDraft.update({
        where: { ...where, revision: input.baseRevision },
        data: { ...fields, revision: { increment: 1 } },
        select,
      }));
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== "P2025") throw error;
    }
    const existing = await tx.clubRegistrationDraft.findUnique({ where, select });
    if (existing) {
      if (alreadySaved(existing, input.baseRevision + 1)) return done(existing);
      throw conflict;
    }
    // No draft. Only a page that loaded with none may create one: any other base means the draft
    // existed and was submitted or deleted, and must not come back (#659).
    if (input.baseRevision !== 0) throw conflict;
    // `skipDuplicates` rather than a failing insert: a unique violation would abort this transaction.
    const created = await tx.clubRegistrationDraft.createMany({ data: [{ eventId, organizationId, draftKey, ...fields, revision: 1 }], skipDuplicates: true });
    if (created.count === 1) return done(await tx.clubRegistrationDraft.findUniqueOrThrow({ where, select }));
    // Another tab created the first draft at the same moment, or this save landed and its response was lost.
    const winner = await tx.clubRegistrationDraft.findUnique({ where, select });
    if (winner && alreadySaved(winner, 1)) return done(winner);
    throw conflict;
  });
}

/**
 * Fixes each attendee to a roster person of this club, inside the submit
 * transaction: names and age are overwritten from the roster, so the client
 * can only choose who, never change who they are.
 */
export function clubAttendeePreparer(organizationId: string, actor?: ClubRegistrationActor, draftKey: string = NO_TEAM_KEY): ClubSubmissionContext["prepareAttendees"] {
  return async (tx, { definition, event, input }) => {
    const problem = clubFormProblem(definition);
    if (problem) throw new PublicRegistrationError("CLUB_REGISTRATION_UNAVAILABLE", problem);
    const attendees = input.attendees ?? [];
    if (attendees.length === 0) {
      throw new PublicRegistrationError("CLUB_ATTENDEES_INVALID", "Choose at least one person from your roster.");
    }
    const members = await activeRosterFor(tx, organizationId, event);
    const byId = new Map(members.map((member) => [member.id, member]));
    // Extra people come from the saved draft, never the request, so the
    // client can only choose them, not change who they are (#388).
    const draft = await tx.clubRegistrationDraft.findUnique({
      where: { eventId_organizationId_draftKey: { eventId: event.id, organizationId, draftKey } },
      select: { guests: true, rosterAges: true, rosterAgeSaveOff: true, honorSelections: true },
    });
    const draftRosterAges = rosterAgesFromJson(draft?.rosterAges);
    const saveOff = new Set(rosterAgeSaveOffFromJson(draft?.rosterAgeSaveOff));
    const saveBack: Array<{ memberId: string; age: number }> = [];
    const draftHonorPicks = recordFromJson(draft?.honorSelections);
    const guestsById = new Map(guestsFromJson(draft?.guests).map((guest) => [guest.id, guest]));
    const eventDate = calendarDateInEventTimeZone(event.startsAt, event.timezone);
    // The event's team rules (#809): ages are counted on its age date, and the team is checked against its limits below.
    const teamSettings = await getTeamSettings(event.id, tx);
    const ageDate = teamAgeDate(teamSettings, eventDate);
    const teamPeople: TeamPerson[] = [];
    const teamMemberPersons: Array<{ personId: string | null; name: string; onRoster: boolean }> = [];
    // The club directory field (#482) is locked to this club's own
    // `Organization` record, read inside the transaction — never from
    // anything the client sent, whatever the client's UI let through. The
    // church is the director's choice and is left as sent. Only queried when
    // the form has a club directory field, so most forms pay no extra cost.
    const hasClubDirectoryField = lockedClubDirectoryFieldKeys(definition as RegistrationFormDefinition).length > 0;
    const directoryResponses = hasClubDirectoryField
      ? clubDirectoryOwnedResponses(definition as RegistrationFormDefinition, await clubDirectoryIdentity(tx, organizationId))
      : {};
    const resolved: Awaited<ReturnType<ClubSubmissionContext["prepareAttendees"]>>["attendees"] = new Map();
    const rewritten = attendees.map((attendee) => {
      const guestId = guestIdFromClientId(attendee.clientId);
      if (guestId !== null) {
        const guest = guestsById.get(guestId);
        if (!guest) {
          throw new PublicRegistrationError(
            "CLUB_ATTENDEES_INVALID",
            "An extra person on this registration wasn't saved. Go back to Who's going, check the extra people, and try again.",
          );
        }
        // An extra person's typed age is their age on the event's age date (#809).
        const role = teamRoleFor({ responses: attendee.responses, maxMemberAge: teamSettings?.maxMemberAge ?? null, age: guest.age });
        resolved.set(attendee.clientId, {
          personId: null,
          rosterMemberId: null,
          ageOnEventDate: guest.age,
          ...(teamSettings ? { teamRole: role } : {}),
          guest: { email: guest.email, attendeeType: guestIsAdult(guest) ? "ADULT" : "YOUTH", guestId: guest.id },
        });
        const person = { firstName: guest.firstName, lastName: guest.lastName, ageOnEventDate: guest.age, gender: null };
        teamMemberPersons.push({ personId: null, name: `${guest.firstName} ${guest.lastName}`.trim(), onRoster: false });
        teamPeople.push({
          name: `${guest.firstName} ${guest.lastName}`.trim(),
          role,
          alternate: isAlternateAnswer(attendee.responses[ALTERNATE_FIELD_KEY]),
          age: guest.age,
        });
        return { ...attendee, responses: { ...attendee.responses, ...rosterOwnedResponses(definition as RegistrationFormDefinition, person) } };
      }
      const memberId = rosterMemberIdFromClientId(attendee.clientId);
      const member = memberId ? byId.get(memberId) : undefined;
      if (!member || !member.personId) {
        throw new PublicRegistrationError(
          "CLUB_ATTENDEES_INVALID",
          "Everyone going must be active on your club roster. Refresh the page and choose again.",
        );
      }
      const rosterOnly = rosterPerson(member, ageDate);
      // A roster person with no birth date takes the age typed in for this
      // registration (#639), else the roster's reported age; a birth date on file always wins.
      const typedAge = rosterOnly.ageOnEventDate === null ? draftRosterAges[member.id] : undefined;
      const effectiveAge = typedAge ?? (rosterOnly.ageOnEventDate === null ? member.reportedAge ?? undefined : undefined);
      if (rosterOnly.ageOnEventDate === null && effectiveAge === undefined) {
        const picks = draftHonorPicks[attendee.clientId];
        const needsAge = attendeeAgeKey(definition as RegistrationFormDefinition) !== null || (Array.isArray(picks) && picks.length > 0);
        if (needsAge) {
          throw new PublicRegistrationError(
            "CLUB_ATTENDEES_INVALID",
            `Enter ${`${rosterOnly.firstName} ${rosterOnly.lastName}`.trim() || "everyone going"}'s age on the event date. Go back to Who's going and add it.`,
          );
        }
      }
      const person = effectiveAge === undefined ? rosterOnly : { ...rosterOnly, ageOnEventDate: effectiveAge };
      if (typedAge !== undefined && typedAge !== (member.reportedAge ?? undefined) && actor && !teamSettings?.ageAsOf && !saveOff.has(member.id)) saveBack.push({ memberId: member.id, age: typedAge });
      const memberRole = teamRoleFor({ responses: attendee.responses, rosterAttendeeType: member.attendeeType, rosterClassLevel: member.classLevel, maxMemberAge: teamSettings?.maxMemberAge ?? null, age: person.ageOnEventDate });
      teamMemberPersons.push({ personId: member.personId, name: `${person.firstName} ${person.lastName}`.trim(), onRoster: true });
      resolved.set(attendee.clientId, { personId: member.personId, rosterMemberId: member.id, ageOnEventDate: person.ageOnEventDate, ...(teamSettings ? { teamRole: memberRole } : {}) });
      teamPeople.push({
        name: `${person.firstName} ${person.lastName}`.trim(),
        role: memberRole,
        alternate: isAlternateAnswer(attendee.responses[ALTERNATE_FIELD_KEY]),
        age: person.ageOnEventDate,
      });
      return { ...attendee, responses: { ...attendee.responses, ...rosterOwnedResponses(definition as RegistrationFormDefinition, person) } };
    });
    // The team's size, alternate and age rules (#809), checked on the server whatever the page let through.
    const teamProblems = teamRuleProblems(teamSettings, teamPeople, eventDate);
    if (teamProblems.length > 0) throw new ClubTeamError("TEAM_RULES", teamProblems.join(" "), teamProblems);
    if (teamSettings?.allowMultipleTeams) {
      throwIfOnOtherTeams((await peopleOnOtherTeams(tx, { eventId: event.id, organizationId, people: teamMemberPersons })).conflicts);
    }
    // Part of the submit transaction: a failed submit saves nothing back (#639).
    if (actor && saveBack.length > 0) await saveRosterAgesBack(tx, organizationId, clubYearFor(event.startsAt), actor, saveBack);
    return {
      input: {
        ...input,
        responses: { ...input.responses, ...directoryResponses },
        attendees: rewritten,
      } satisfies PublicRegistrationInput,
      attendees: resolved,
    };
  };
}

/** Who submitted, for the club submission: the attendee director, or the staff user plus their act-as record (#442). */
export function clubSubmissionAttribution(actor: ClubRegistrationActor): Pick<ClubSubmissionContext, "submittedByAccountId" | "submittedByUserId" | "actAsId"> {
  return "accountId" in actor
    ? { submittedByAccountId: actor.accountId }
    : { submittedByUserId: actor.userId, actAsId: actor.actAsId };
}

export async function submitClubRegistration(
  organizationId: string,
  eventId: string,
  actor: ClubRegistrationActor,
  input: PublicRegistrationInput,
  now = new Date(),
  options: { locationId?: string | null; report?: ClubSubmissionContext["report"]; registered?: ClubSubmissionContext["registered"]; teamName?: string | null; draftKey?: string } = {},
) {
  const event = await requireClubEvent(eventId);
  const form = await publishedClubForm(event.id);
  if (!form) throw new ClubRegistrationError("FORM_UNAVAILABLE", "The event has no published registration form yet.");
  // The team (#809): named when the event lets a club register several, and never otherwise.
  const teamSettings = await getTeamSettings(eventId);
  const team = resolveTeamName(teamSettings, options.teamName);
  if (!team.ok) throw new ClubRegistrationError("TEAM_INVALID", team.message);
  const draftKey = clubDraftKey(teamSettings, options.draftKey);
  return submitPublicRegistration(event.slug, form.slug, input, now, {
    organizationId,
    ...clubSubmissionAttribution(actor),
    ...(team.teamName !== null ? { team: { name: team.teamName, key: team.teamKey, draftKey } } : {}),
    // Picked, locked, and capacity-checked inside the submit transaction (#413).
    locationId: options.locationId ?? null,
    ...(options.report ? { report: options.report } : {}),
    ...(options.registered ? { registered: options.registered } : {}),
    prepareAttendees: clubAttendeePreparer(organizationId, actor, draftKey),
  });
}

export function recordFromJson(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type CurrentClubAttendee = { id: string; personId: string | null; profileSnapshot: unknown; formResponses: unknown };

// Answer keys that identify a person. The amendment engine refuses any change
// to them on a kept attendee, so a kept extra person or off-roster person
// always carries their registered values, whatever the client sent.
const IDENTITY_ANSWER_KEYS = ["first_name", "last_name", "full_name", "name", "attendee_name", "guest_name"];

/** `responses` with every identity and roster-owned answer put back to `current`. */
function withRegisteredIdentity(
  definition: RegistrationFormDefinition,
  responses: Record<string, unknown>,
  current: Record<string, unknown>,
) {
  const next = { ...responses };
  for (const key of new Set([...IDENTITY_ANSWER_KEYS, ...lockedAttendeeFieldKeys(definition)])) {
    if (Object.hasOwn(current, key)) next[key] = current[key];
    else delete next[key];
  }
  return next;
}

function snapshotName(snapshot: Record<string, unknown>) {
  return `${typeof snapshot.firstName === "string" ? snapshot.firstName : ""} ${typeof snapshot.lastName === "string" ? snapshot.lastName : ""}`.trim()
    || "Someone";
}

/**
 * What a director sees after an edit (H3b, #366): enough to confirm it saved,
 * never the staff view the amendment engine returns (adjustment reasons,
 * staff names, payment references, message bodies). Reads defensively, since
 * an idempotent replay hands back the stored JSON snapshot.
 */
function clubEditResult(response: unknown) {
  const record = recordFromJson(response);
  const registration = recordFromJson(record.registration);
  const amendment = recordFromJson(record.amendment);
  return {
    result: {
      confirmationCode: typeof registration.confirmationCode === "string" ? registration.confirmationCode : null,
      updatedAt: typeof registration.updatedAt === "string" ? registration.updatedAt : null,
      attendeeCount: typeof amendment.attendeeCount === "number" ? amendment.attendeeCount : null,
    },
    pendingMessageIds: Array.isArray(record.pendingMessageIds)
      ? record.pendingMessageIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export type ClubRegistrationEditResult = ReturnType<typeof clubEditResult>["result"];

/**
 * H3b (#366): a director reopens a submitted club registration and adds or
 * removes roster people or extra people, or changes their answers, through
 * the same staff amendment engine (`amendRegistration`) a staff member's
 * edit goes through — a director actor instead, so capacity, audit, and
 * notices stay the one path. Refused unless registration is open in the
 * event's own time zone (`clubRegistrationEditWindow`), or if the published
 * form has since become unusable for club registration (`clubFormProblem`,
 * reused here exactly as the submit path uses it).
 *
 * Who each person is comes only from the server: a roster person's names
 * and age from the roster (linked to their roster person, never matched by
 * name), a kept extra person or off-roster person exactly as registered.
 * Pricing stays on the original pricing date (the engine's rule).
 */
export async function amendClubRegistration(
  organizationId: string,
  eventId: string,
  actor: ClubRegistrationActor,
  input: ClubRegistrationEditInput,
  now = new Date(),
) {
  const event = await requireClubEvent(eventId);
  // Which of the club's registrations is being changed (#809): its team's key, the empty key on an event without teams.
  const clubRegistration = await getPrisma().clubEventRegistration.findUnique({
    where: { eventId_organizationId_teamKey: { eventId, organizationId, teamKey: input.teamKey ?? NO_TEAM_KEY } },
    select: { registrationId: true, registration: { select: { location: { select: clubLocationSelect } } } },
  });
  // The edit window follows the registration's own location when it has one (#413).
  const currentLocation = clubRegistration?.registration?.location ?? null;
  const window = clubEditWindow(event, currentLocation, now);
  if (!window.open) throw new ClubRegistrationError("REGISTRATION_CLOSED", window.message);
  const form = await publishedClubForm(event.id);
  if (!form) throw new ClubRegistrationError("FORM_UNAVAILABLE", "The event has no published registration form yet.");
  const problem = clubFormProblem(form.definition);
  if (problem) throw new ClubRegistrationError("FORM_UNAVAILABLE", problem);

  if (!clubRegistration) {
    throw new ClubRegistrationError("REGISTRATION_NOT_FOUND", "Your club hasn't registered for this event yet.");
  }
  const registrationId = clubRegistration.registrationId;
  // A switch to another location needs that location to still be open; its
  // seats are counted under its lock in the amendment transaction (#413).
  if (input.locationId && input.locationId !== currentLocation?.id) {
    const target = await getPrisma().eventLocation.findFirst({
      where: { id: input.locationId, eventId, isActive: true },
      select: clubLocationSelect,
    });
    if (!target) throw new EventLocationError("LOCATION_INVALID", "That location isn't available. Refresh the page and choose again.");
    const closed = locationOpenProblem(event, target, now);
    if (closed) throw new ClubRegistrationError("REGISTRATION_CLOSED", `${closed} Choose another location.`);
  }

  // A retried save (same request id and same content) returns what the first
  // one did, even though the registration has moved on since. The same id
  // with different content is refused.
  const { clientRequestId, ...editContent } = input;
  const requestFingerprint = registrationOperationFingerprint({
    eventId,
    registrationId,
    operation: "AMENDMENT",
    payload: { clubEdit: editContent },
  });
  const replay = await getPrisma().registrationOperation.findUnique({
    where: { eventId_clientRequestId: { eventId, clientRequestId } },
    select: { registrationId: true, type: true, requestFingerprint: true, responseSnapshot: true },
  });
  if (replay) {
    if (replay.registrationId !== registrationId || replay.type !== "AMENDMENT" || replay.requestFingerprint !== requestFingerprint) {
      throw new RegistrationAmendmentError(
        "IDEMPOTENCY_KEY_REUSED",
        "That amendment request ID was already used for different changes. Start a new review.",
      );
    }
    const replayed = clubEditResult(replay.responseSnapshot);
    return { ...replayed, result: { ...replayed.result, permissionNotices: await permissionNoticesForRegistration(registrationId) } };
  }

  const [account, answers, currentAttendees, members] = await Promise.all([
    "accountId" in actor
      ? getPrisma().attendeeAccount.findUnique({ where: { id: actor.accountId }, select: { displayName: true } })
      : Promise.resolve(null),
    currentRegistrationAnswers(eventId, registrationId),
    getPrisma().registrationAttendee.findMany({
      where: { registrationId },
      select: { id: true, personId: true, profileSnapshot: true, formResponses: true },
    }) as Promise<CurrentClubAttendee[]>,
    activeRosterFor(getPrisma(), organizationId, event),
  ]);
  if (!answers) {
    throw new ClubRegistrationError("REGISTRATION_NOT_FOUND", "Your club's registration for this event could not be found.");
  }

  const membersById = new Map(members.map((member) => [member.id, member]));
  if (input.selectedMemberIds.some((memberId) => !membersById.has(memberId))) {
    throw new ClubRegistrationError("MEMBER_NOT_ON_ROSTER", "Everyone going must be active on your club roster. Refresh the page and try again.");
  }
  if (new Set(input.selectedMemberIds).size !== input.selectedMemberIds.length) {
    throw new ClubRegistrationError("ATTENDEES_INVALID", "Each person can be chosen once. Refresh the page and try again.");
  }

  const currentByMemberId = new Map<string, CurrentClubAttendee>();
  const currentByGuestId = new Map<string, CurrentClubAttendee>();
  const offRosterById = new Map<string, CurrentClubAttendee>();
  for (const attendee of currentAttendees) {
    const snapshot = recordFromJson(attendee.profileSnapshot);
    if (snapshot.temporary === true) {
      // An extra person submitted before guests carried an id is known by
      // their attendee id (the workspace offers the same fallback).
      currentByGuestId.set(typeof snapshot.clubGuestId === "string" ? snapshot.clubGuestId : attendee.id, attendee);
      continue;
    }
    const memberId = typeof snapshot.clubRosterMemberId === "string" ? snapshot.clubRosterMemberId : null;
    if (memberId && membersById.has(memberId)) currentByMemberId.set(memberId, attendee);
    else offRosterById.set(attendee.id, attendee);
  }
  if (input.keptGuestIds.some((guestId) => !currentByGuestId.has(guestId))) {
    throw new ClubRegistrationError(
      "GUEST_INVALID",
      "One of the extra people on this registration wasn't found. Refresh the page and try again.",
    );
  }
  if (input.keptOffRosterAttendeeIds.some((attendeeId) => !offRosterById.has(attendeeId))) {
    throw new ClubRegistrationError(
      "ATTENDEES_INVALID",
      "Someone on this registration changed since you opened it. Refresh the page and try again.",
    );
  }
  const newGuestIds = new Set(input.newGuests.map((guest) => guest.id));
  if (
    newGuestIds.size !== input.newGuests.length
    || new Set(input.keptGuestIds).size !== input.keptGuestIds.length
    || input.keptGuestIds.some((guestId) => newGuestIds.has(guestId))
    || input.newGuests.some((guest) => currentByGuestId.has(guest.id))
  ) {
    throw new ClubRegistrationError("GUEST_INVALID", "Each extra person needs their own entry. Refresh the page and try again.");
  }

  // A newly added roster person who is already on this registration under
  // another entry (an extra person, or someone kept from off the roster)
  // would be registered twice; say so instead of failing as a conflict.
  const keptAttendees = [
    ...input.selectedMemberIds.flatMap((memberId) => currentByMemberId.get(memberId) ?? []),
    ...input.keptGuestIds.flatMap((guestId) => currentByGuestId.get(guestId) ?? []),
    ...input.keptOffRosterAttendeeIds.flatMap((attendeeId) => offRosterById.get(attendeeId) ?? []),
  ];
  const keptPersonIds = new Set(keptAttendees.flatMap((attendee) => attendee.personId ?? []));
  const alreadyRegistered = input.selectedMemberIds
    .filter((memberId) => !currentByMemberId.has(memberId))
    .map((memberId) => membersById.get(memberId)!)
    .find((member) => member.personId && keptPersonIds.has(member.personId));
  if (alreadyRegistered) {
    throw new ClubRegistrationError(
      "ATTENDEES_INVALID",
      `${alreadyRegistered.person?.firstName ?? ""} ${alreadyRegistered.person?.lastName ?? ""}`.trim() + " is already on this registration. Untick their other entry before adding them from the roster.",
    );
  }

  const eventDate = calendarDateInEventTimeZone(event.startsAt, event.timezone);
  // The event's team rules (#809): ages are counted on its age date, and the whole team is checked against its limits.
  const teamSettings = await getTeamSettings(eventId);
  const ageDate = teamAgeDate(teamSettings, eventDate);
  const definition = form.definition;
  const seminarKeys = definition.sections.flatMap((section) => section.fields)
    .filter(isSeminarPreferenceField)
    .map((field) => field.key);
  const amendmentAttendees: RegistrationAmendmentInput["attendees"] = [];
  const serverOptions = new Map<string, AmendmentAttendeeServerOptions>();
  const saveAgeBack: Array<{ memberId: string; age: number }> = [];
  const typedAges = input.rosterAges ?? {};
  const saveAgeIds = new Set(input.saveAgeToRosterIds ?? []);

  /** The answers to keep for an attendee already registered: sent ones, or theirs as they stand. */
  function keptAnswers(clientId: string, current: CurrentClubAttendee) {
    return input.attendeeResponses[clientId] ?? recordFromJson(current.formResponses);
  }

  /** Class/seminar picks are chosen elsewhere; an edit here must leave them as they are. */
  function assertSeminarPicksUnchanged(current: CurrentClubAttendee, responses: Record<string, unknown>) {
    const registered = recordFromJson(current.formResponses);
    const changed = seminarKeys.some((key) => JSON.stringify(registered[key] ?? null) !== JSON.stringify(responses[key] ?? null));
    if (changed) {
      throw new ClubRegistrationError(
        "CLASS_CHOICES_NOT_EDITABLE",
        `${snapshotName(recordFromJson(current.profileSnapshot))}'s class or seminar choices can't be changed here. Put them back as they were, or ask the event team to change them.`,
      );
    }
  }

  for (const memberId of input.selectedMemberIds) {
    const member = membersById.get(memberId)!;
    const rosterOnly = rosterPerson(member, ageDate);
    const clientId = clubAttendeeClientId(memberId);
    const current = currentByMemberId.get(memberId);
    // A roster person with no birth date needs an age entered for this
    // registration (#639); a kept person's registered age stands until changed.
    let person = rosterOnly;
    if (rosterOnly.ageOnEventDate === null) {
      const registeredAge = current ? recordFromJson(current.profileSnapshot).ageOnEventDate : undefined;
      const age = typedAges[memberId] ?? (typeof registeredAge === "number" ? registeredAge : member.reportedAge ?? undefined);
      if (age === undefined) {
        if (attendeeAgeKey(definition) !== null) {
          throw new ClubRegistrationError(
            "ATTENDEES_INVALID",
            `Enter ${`${rosterOnly.firstName} ${rosterOnly.lastName}`.trim() || "everyone going"}'s age on the event date.`,
          );
        }
      } else {
        person = { ...rosterOnly, ageOnEventDate: age };
        // Only an age the director changed from where it started (the registered age, else the roster's reported age).
        const startingAge = typeof registeredAge === "number" ? registeredAge : member.reportedAge ?? undefined;
        if (typedAges[memberId] !== undefined && typedAges[memberId] !== startingAge && !teamSettings?.ageAsOf && saveAgeIds.has(memberId)) saveAgeBack.push({ memberId, age });
      }
    }
    const owned = rosterOwnedResponses(definition, person);
    const responses = {
      ...(current ? keptAnswers(clientId, current) : (input.attendeeResponses[clientId] ?? {})),
      ...owned,
    };
    if (current) assertSeminarPicksUnchanged(current, responses);
    amendmentAttendees.push({ attendeeId: current?.id ?? null, clientId, responses });
    const memberRole = teamRoleFor({ responses, rosterAttendeeType: member.attendeeType, rosterClassLevel: member.classLevel, maxMemberAge: teamSettings?.maxMemberAge ?? null, age: person.ageOnEventDate });
    serverOptions.set(clientId, {
      // A newly added roster person is that roster person, never a new or
      // name-matched one (the submit path links them the same way).
      ...(current ? {} : { personId: member.personId! }),
      // The roster is the source of truth for names: a kept person takes a
      // name corrected on the roster since submitting, and only that name.
      ...(current ? { rosterName: { firstName: person.firstName, lastName: person.lastName } } : {}),
      profileMetadata: {
        clubOrganizationId: organizationId,
        clubRosterMemberId: memberId,
        ageOnEventDate: person.ageOnEventDate,
        ...(teamSettings ? { teamRole: memberRole } : {}),
      },
    });
  }

  for (const guestId of input.keptGuestIds) {
    const current = currentByGuestId.get(guestId)!;
    const snapshot = recordFromJson(current.profileSnapshot);
    const clientId = clubGuestClientId(guestId);
    const responses = withRegisteredIdentity(definition, keptAnswers(clientId, current), recordFromJson(current.formResponses));
    assertSeminarPicksUnchanged(current, responses);
    const ageOnEventDate = typeof snapshot.ageOnEventDate === "number" ? snapshot.ageOnEventDate : null;
    amendmentAttendees.push({ attendeeId: current.id, clientId, responses });
    const guestRole = teamRoleFor({ responses, maxMemberAge: teamSettings?.maxMemberAge ?? null, age: ageOnEventDate });
    serverOptions.set(clientId, {
      // Their own email, as submitted, not whatever the form answers imply.
      email: typeof snapshot.email === "string" ? snapshot.email : null,
      profileMetadata: {
        clubOrganizationId: organizationId,
        ageOnEventDate,
        temporary: true,
        temporaryAttendeeType: snapshot.temporaryAttendeeType === "YOUTH" || snapshot.temporaryAttendeeType === "ADULT"
          ? snapshot.temporaryAttendeeType
          : ageOnEventDate !== null && !guestIsAdult({ age: ageOnEventDate }) ? "YOUTH" : "ADULT",
        clubGuestId: guestId,
        ...(teamSettings ? { teamRole: guestRole } : {}),
      },
    });
  }

  for (const attendeeId of input.keptOffRosterAttendeeIds) {
    // Kept exactly as registered: no roster lookup, snapshot untouched.
    const current = offRosterById.get(attendeeId)!;
    const clientId = clubExistingAttendeeClientId(attendeeId);
    const responses = withRegisteredIdentity(definition, keptAnswers(clientId, current), recordFromJson(current.formResponses));
    assertSeminarPicksUnchanged(current, responses);
    amendmentAttendees.push({ attendeeId: current.id, clientId, responses });
  }

  for (const guest of input.newGuests) {
    const person: RosterPerson = { firstName: guest.firstName, lastName: guest.lastName, ageOnEventDate: guest.age, gender: null };
    const clientId = clubGuestClientId(guest.id);
    const responses = {
      ...(input.attendeeResponses[clientId] ?? {}),
      ...rosterOwnedResponses(definition, person),
    };
    amendmentAttendees.push({ attendeeId: null, clientId, responses });
    const newGuestRole = teamRoleFor({ responses, maxMemberAge: teamSettings?.maxMemberAge ?? null, age: guest.age });
    serverOptions.set(clientId, {
      email: guest.email,
      profileMetadata: {
        clubOrganizationId: organizationId,
        ageOnEventDate: guest.age,
        temporary: true,
        temporaryAttendeeType: guestIsAdult(guest) ? "ADULT" : "YOUTH",
        clubGuestId: guest.id,
        ...(teamSettings ? { teamRole: newGuestRole } : {}),
      },
    });
  }

  if (amendmentAttendees.length === 0) {
    throw new ClubRegistrationError("ATTENDEES_INVALID", "Choose at least one person from your roster.");
  }
  // The team rules (size, alternate, age, one team per person) are checked inside the amendment's own Serializable
  // transaction by `enforceTeamRegistrationRules`, from the settings read there, so a race cannot slip past them (#809).

  const amendmentInput: RegistrationAmendmentInput = {
    clientRequestId: input.clientRequestId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    reason: "",
    responses: answers.responses,
    attendees: amendmentAttendees,
    previewOnly: true,
  };
  // The club directory field (#482) stays this club's own on amendment, as
  // on submit: whatever the registration held (a "Not listed" entry, a
  // since-renamed name, or anything a client tried to slip in) is set to the
  // club's current directory record. The engine applies it against the
  // registration's own hydrated form, before validating. The church is left
  // as the registration holds it.
  // Read inside the engine's transaction, so a rename landing between the
  // preview and the commit can't leave a stale club name to fail on.
  const engineOptions: AmendmentServerOptions = {
    attendees: serverOptions,
    // Inside the amendment's own transaction, so a failed save changes nothing (#639).
    ...(saveAgeBack.length > 0 ? { inTransaction: (tx: Prisma.TransactionClient) => saveRosterAgesBack(tx, organizationId, clubYearFor(event.startsAt), actor, saveAgeBack) } : {}),
    requestFingerprint,
    ...(input.locationId ? { locationId: input.locationId } : {}),
    ownedRegistrationResponses: async (hydrated, tx) => (
      clubDirectoryOwnedResponses(hydrated, await clubDirectoryIdentity(tx, organizationId))
    ),
  };
  try {
    const preview = await previewRegistrationAmendment(eventId, registrationId, amendmentInput, engineOptions);
    const response = await amendRegistration(
      eventId,
      registrationId,
      { ...amendmentInput, previewOnly: false, quoteFingerprint: preview.quoteFingerprint },
      "accountId" in actor
        ? { kind: "CLUB_DIRECTOR", attendeeAccountId: actor.accountId, displayName: account?.displayName ?? "Club director" }
        : { kind: "STAFF_ACTING_DIRECTOR", id: actor.userId, actAsId: actor.actAsId, displayName: "A system administrator acting as director" },
      now,
      engineOptions,
    );
    const edited = clubEditResult(response);
    // Who needs the Area Coordinator's permission after this edit, told to the director on the result (#809).
    return { ...edited, result: { ...edited.result, permissionNotices: await permissionNoticesForRegistration(registrationId) } };
  } catch (error) {
    // Field problems come back keyed by the engine's attendee position; the
    // editor knows people by client id, so carry that along.
    if (error instanceof RegistrationAmendmentError && error.issues.length > 0) {
      throw new RegistrationAmendmentError(
        error.code,
        error.message,
        error.issues.map((issue) => ({
          ...issue,
          clientId: issue.attendeeIndex !== null ? amendmentAttendees[issue.attendeeIndex]?.clientId ?? null : null,
        })),
        error.details,
      );
    }
    throw error;
  }
}
