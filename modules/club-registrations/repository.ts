import "server-only";

import { Prisma, RegistrationFormStatus } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
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
import { registrationFormDefinitionSchema, type RegistrationFormDefinition } from "@/modules/forms/definition";
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
import { currentPricingSnapshot, perPersonPriceFromSnapshot } from "@/modules/club-registrations/per-person-price";
import {
  churchOwedCents,
  isChurchBilledStatus,
  sortChurchAmountsOwed,
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
      | "GUEST_INVALID"
      | "REGISTRATION_NOT_FOUND"
      | "REGISTRATION_CLOSED"
      | "ATTENDEES_INVALID"
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
  const form = await getPrisma().registrationForm.findFirst({
    where: {
      eventId,
      versions: { some: { status: RegistrationFormStatus.PUBLISHED } },
    },
    orderBy: { createdAt: "asc" },
    select: {
      slug: true,
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
  const parsed = registrationFormDefinitionSchema.safeParse(version.definition);
  return parsed.success ? { slug: form.slug, definition: parsed.data } : null;
}

const clubEventSelect = {
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
} satisfies Prisma.EventSelect;

type ClubEvent = Prisma.EventGetPayload<{ select: typeof clubEventSelect }>;

const clubLocationSelect = {
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
function clubPhase(
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
function clubLocationView(event: ClubEvent, location: ClubLocation, occupied: number, now: Date) {
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
async function locationSeatCounts(client: Pick<Prisma.TransactionClient, "registration">, eventId: string, excludeRegistrationId?: string) {
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
        select: {
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
      clubRegistrationDrafts: { where: { organizationId }, select: { updatedAt: true, selectedMemberIds: true } },
      locations: { where: { isActive: true }, select: clubLocationSelect },
    },
  });
  const results = [];
  for (const event of events) {
    const form = await publishedClubForm(event.id);
    const problem = form ? clubFormProblem(form.definition) : "The event has no published registration form yet.";
    const registration = event.clubRegistrations[0]?.registration ?? null;
    const draft = event.clubRegistrationDrafts[0] ?? null;
    const registeredLocation = registration?.location ?? null;
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
    });
  }
  return results;
}

export type ClubEventSummary = Awaited<ReturnType<typeof listClubEvents>>[number];

export type ClubEventRegistrationStep = { key: string; text: string; href: string; action: string };

/**
 * Club home's "What's next" (#478): one item per open club event the club
 * hasn't registered for yet, so a director always sees where to register —
 * not only on the Events & classes tab. A club with a saved draft still gets
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
  }));
  // A church-billed event whose registrations are not club registrations (#606: Leadership Weekend, Outdoor
  // School) is reported by the organization each form names. Club events keep exactly the rows above.
  // Only a GENERAL event: a CLUB event (Spring Camporee) keeps club rows only, whatever else is registered on it.
  const event = await getPrisma().event.findUnique({ where: { id: eventId }, select: { billingMode: true, audience: true } });
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
      organization: { select: { id: true, name: true } },
      registration: { select: { confirmationCode: true, status: true, totalAmount: true, location: { select: { name: true } } } },
    },
  });
  return rows.map((row) => ({
    organizationId: row.organization.id,
    organizationName: row.organization.name,
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

async function requireClubEvent(eventId: string): Promise<ClubEvent> {
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
      role: true,
      gender: true,
      sealedBirthDate: true,
      person: { select: { firstName: true, lastName: true } },
    },
  });
}

/** The director edit window (#366) for a registration, on its location's dates when it has one (#413). */
function clubEditWindow(event: ClubEvent, location: (LocationDateSource & { name?: string }) | null, now: Date) {
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

/** Everything the director's page needs for one club event. */
export async function getClubEventWorkspace(organizationId: string, eventId: string, now = new Date()) {
  const event = await requireClubEvent(eventId);
  const eventDate = calendarDateInEventTimeZone(event.startsAt, event.timezone);
  const [form, members, clubRegistration, draft, identity, eventLocations] = await Promise.all([
    publishedClubForm(event.id),
    activeRosterFor(getPrisma(), organizationId, event),
    getPrisma().clubEventRegistration.findUnique({
      where: { eventId_organizationId: { eventId, organizationId } },
      select: {
        createdAt: true,
        registrationId: true,
        registration: {
          select: {
            confirmationCode: true,
            status: true,
            updatedAt: true,
            publicFormSubmission: { select: { pricingSnapshot: true } },
            // The latest amendment's pricing wins over the original submission's (#621).
            operations: { where: { type: "AMENDMENT" }, orderBy: { createdAt: "desc" }, take: 1, select: { afterSnapshot: true } },
            location: { select: clubLocationSelect },
            attendees: { orderBy: { position: "asc" }, select: { id: true, profileSnapshot: true, formResponses: true } },
          },
        },
      },
    }),
    getPrisma().clubRegistrationDraft.findUnique({ where: { eventId_organizationId: { eventId, organizationId } } }),
    clubDirectoryIdentity(getPrisma(), organizationId),
    getPrisma().eventLocation.findMany({
      where: { eventId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { name: "asc" }],
      select: clubLocationSelect,
    }),
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
  const registrationAnswers = clubRegistration
    ? await currentRegistrationAnswers(eventId, clubRegistration.registrationId)
    : null;
  const roster = members
    .map((member) => {
      const person = rosterPerson(member, eventDate);
      return {
        memberId: member.id,
        clientId: clubAttendeeClientId(member.id),
        firstName: person.firstName,
        lastName: person.lastName,
        ageOnEventDate: person.ageOnEventDate,
        attendeeType: member.attendeeType,
        role: member.role,
        ownedResponses: experience ? rosterOwnedResponses(experience.form.definition, person) : {},
        prefillResponses: experience
          ? {
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
    // The directory fields (#482): the club is always the director's own and
    // locked (enforced again server-side by `clubDirectoryOwnedResponses`);
    // the church starts as the club's sponsoring church but stays editable.
    directory: {
      lockedFieldKeys: experience ? lockedClubDirectoryFieldKeys(experience.form.definition) : [],
      prefillResponses: experience ? clubDirectoryPrefillResponses(experience.form.definition, identity) : {},
    },
    roster,
    registration: clubRegistration
      ? {
        confirmationCode: clubRegistration.registration.confirmationCode,
        status: clubRegistration.registration.status,
        submittedAt: clubRegistration.createdAt.toISOString(),
        updatedAt: clubRegistration.registration.updatedAt.toISOString(),
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
          };
          const temporary = snapshot.temporary === true;
          const clubRosterMemberId = snapshot.clubRosterMemberId ?? null;
          return {
            attendeeId: id,
            firstName: snapshot.firstName ?? "",
            lastName: snapshot.lastName ?? "",
            ageOnEventDate: snapshot.ageOnEventDate ?? null,
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
};

/** Never an attendee account credited for a staff action (#442): `userId` for a staff "act as" director. */
export type ClubRegistrationActor = { accountId: string } | { userId: string; actAsId: string };

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
  const data = {
    rosterAges: rosterAges as Prisma.InputJsonValue,
    honorSelections: honorSelections as Prisma.InputJsonValue,
    selectedMemberIds: input.selectedMemberIds,
    guests: input.guests as Prisma.InputJsonValue,
    responses: input.responses as Prisma.InputJsonValue,
    attendeeResponses: attendeeResponses as Prisma.InputJsonValue,
    ...("accountId" in actor ? { updatedByAccountId: actor.accountId, updatedByUserId: null } : { updatedByUserId: actor.userId, updatedByAccountId: null }),
  };
  const draft = await getPrisma().clubRegistrationDraft.upsert({
    where: { eventId_organizationId: { eventId, organizationId } },
    create: { eventId, organizationId, ...data },
    update: data,
    select: { updatedAt: true },
  });
  return { updatedAt: draft.updatedAt.toISOString() };
}

/**
 * Fixes each attendee to a roster person of this club, inside the submit
 * transaction: names and age are overwritten from the roster, so the client
 * can only choose who, never change who they are.
 */
export function clubAttendeePreparer(organizationId: string): ClubSubmissionContext["prepareAttendees"] {
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
      where: { eventId_organizationId: { eventId: event.id, organizationId } },
      select: { guests: true, rosterAges: true, honorSelections: true },
    });
    const draftRosterAges = rosterAgesFromJson(draft?.rosterAges);
    const draftHonorPicks = recordFromJson(draft?.honorSelections);
    const guestsById = new Map(guestsFromJson(draft?.guests).map((guest) => [guest.id, guest]));
    const eventDate = calendarDateInEventTimeZone(event.startsAt, event.timezone);
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
        resolved.set(attendee.clientId, {
          personId: null,
          rosterMemberId: null,
          ageOnEventDate: guest.age,
          guest: { email: guest.email, attendeeType: guestIsAdult(guest) ? "ADULT" : "YOUTH", guestId: guest.id },
        });
        const person = { firstName: guest.firstName, lastName: guest.lastName, ageOnEventDate: guest.age, gender: null };
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
      const rosterOnly = rosterPerson(member, eventDate);
      // A roster person with no birth date takes the age typed in for this
      // registration (#639); a birth date on file always wins.
      const typedAge = rosterOnly.ageOnEventDate === null ? draftRosterAges[member.id] : undefined;
      if (rosterOnly.ageOnEventDate === null && typedAge === undefined) {
        const picks = draftHonorPicks[attendee.clientId];
        const needsAge = attendeeAgeKey(definition as RegistrationFormDefinition) !== null || (Array.isArray(picks) && picks.length > 0);
        if (needsAge) {
          throw new PublicRegistrationError(
            "CLUB_ATTENDEES_INVALID",
            `Enter ${`${rosterOnly.firstName} ${rosterOnly.lastName}`.trim() || "everyone going"}'s age on the event date. Go back to Who's going and add it.`,
          );
        }
      }
      const person = typedAge === undefined ? rosterOnly : { ...rosterOnly, ageOnEventDate: typedAge };
      resolved.set(attendee.clientId, { personId: member.personId, rosterMemberId: member.id, ageOnEventDate: person.ageOnEventDate });
      return { ...attendee, responses: { ...attendee.responses, ...rosterOwnedResponses(definition as RegistrationFormDefinition, person) } };
    });
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
  options: { locationId?: string | null; report?: ClubSubmissionContext["report"] } = {},
) {
  const event = await requireClubEvent(eventId);
  const form = await publishedClubForm(event.id);
  if (!form) throw new ClubRegistrationError("FORM_UNAVAILABLE", "The event has no published registration form yet.");
  return submitPublicRegistration(event.slug, form.slug, input, now, {
    organizationId,
    ...clubSubmissionAttribution(actor),
    // Picked, locked, and capacity-checked inside the submit transaction (#413).
    locationId: options.locationId ?? null,
    ...(options.report ? { report: options.report } : {}),
    prepareAttendees: clubAttendeePreparer(organizationId),
  });
}

function recordFromJson(value: unknown): Record<string, unknown> {
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
  const clubRegistration = await getPrisma().clubEventRegistration.findUnique({
    where: { eventId_organizationId: { eventId, organizationId } },
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
    return clubEditResult(replay.responseSnapshot);
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
  const definition = form.definition;
  const seminarKeys = definition.sections.flatMap((section) => section.fields)
    .filter(isSeminarPreferenceField)
    .map((field) => field.key);
  const amendmentAttendees: RegistrationAmendmentInput["attendees"] = [];
  const serverOptions = new Map<string, AmendmentAttendeeServerOptions>();

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
    const person = rosterPerson(member, eventDate);
    const clientId = clubAttendeeClientId(memberId);
    const current = currentByMemberId.get(memberId);
    const owned = rosterOwnedResponses(definition, person);
    const responses = {
      ...(current ? keptAnswers(clientId, current) : (input.attendeeResponses[clientId] ?? {})),
      ...owned,
    };
    if (current) assertSeminarPicksUnchanged(current, responses);
    amendmentAttendees.push({ attendeeId: current?.id ?? null, clientId, responses });
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
    serverOptions.set(clientId, {
      email: guest.email,
      profileMetadata: {
        clubOrganizationId: organizationId,
        ageOnEventDate: guest.age,
        temporary: true,
        temporaryAttendeeType: guestIsAdult(guest) ? "ADULT" : "YOUTH",
        clubGuestId: guest.id,
      },
    });
  }

  if (amendmentAttendees.length === 0) {
    throw new ClubRegistrationError("ATTENDEES_INVALID", "Choose at least one person from your roster.");
  }

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
    return clubEditResult(response);
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
