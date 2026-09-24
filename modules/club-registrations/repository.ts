import "server-only";

import { Prisma, RegistrationFormStatus } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { openBirthDate } from "@/modules/club-rosters/birth-dates";
import { ageOn, clubYearFor } from "@/modules/club-rosters/domain";
import {
  clubAttendeeClientId,
  clubExistingAttendeeClientId,
  clubFormProblem,
  clubGuestClientId,
  clubRegistrationEditWindow,
  type ClubRegistrationEditInput,
  guestIdFromClientId,
  guestIsAdult,
  guestsFromJson,
  type ClubGuest,
  lockedAttendeeFieldKeys,
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
  evaluateEventRegistrationPhase,
} from "@/modules/events/lifecycle";
import { isSeminarPreferenceField } from "@/modules/attendee-accounts/registration-answer-policy";
import {
  amendRegistration,
  currentRegistrationAnswers,
  previewRegistrationAmendment,
  RegistrationAmendmentError,
  type AmendmentAttendeeServerOptions,
} from "@/modules/registrations/amendments-repository";
import { registrationOperationFingerprint } from "@/modules/registrations/operations-domain";
import type { RegistrationAmendmentInput } from "@/modules/registrations/schemas";
import { moneyToCents } from "@/modules/payments/square-domain";
import {
  churchOwedCents,
  isChurchBilledStatus,
  sortChurchAmountsOwed,
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

async function publishedClubForm(eventId: string) {
  const form = await getPrisma().registrationForm.findFirst({
    where: {
      eventId,
      status: RegistrationFormStatus.PUBLISHED,
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

/** Events a club can register for: published, billed to the church, with a usable published form. */
export async function listClubEvents(organizationId: string, now = new Date()) {
  const events = await getPrisma().event.findMany({
    where: { isPublished: true, billingMode: "DEFERRED_ORGANIZATION_INVOICE", endsAt: { gte: now } },
    orderBy: { startsAt: "asc" },
    select: {
      ...clubEventSelect,
      clubRegistrations: {
        where: { organizationId },
        select: {
          registration: {
            select: { confirmationCode: true, status: true, totalAmount: true, _count: { select: { attendees: true } } },
          },
        },
      },
      clubRegistrationDrafts: { where: { organizationId }, select: { updatedAt: true, selectedMemberIds: true } },
    },
  });
  const results = [];
  for (const event of events) {
    const form = await publishedClubForm(event.id);
    const problem = form ? clubFormProblem(form.definition) : "The event has no published registration form yet.";
    const registration = event.clubRegistrations[0]?.registration ?? null;
    const draft = event.clubRegistrationDrafts[0] ?? null;
    results.push({
      id: event.id,
      name: event.name,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      timezone: event.timezone,
      location: event.location,
      phase: evaluateEventRegistrationPhase(event, now),
      registrationClosesOn: event.registrationClosesOn,
      available: !problem,
      problem,
      registration: registration
        ? {
          confirmationCode: registration.confirmationCode,
          status: registration.status,
          attendeeCount: registration._count.attendees,
          amountOwedCents: churchOwedCents(registration.status, moneyToCents(registration.totalAmount)),
        }
        : null,
      draft: draft ? { updatedAt: draft.updatedAt.toISOString(), selectedCount: draft.selectedMemberIds.length } : null,
    });
  }
  return results;
}

export type ClubEventSummary = Awaited<ReturnType<typeof listClubEvents>>[number];

/**
 * What each club's church owes for an event billed to the church (#409):
 * read-only, for staff finance screens. This is never an attendee or director
 * balance and never a card payment — the amount is the estimate the pricing
 * engine already recorded on the club's registration
 * (`Registration.totalAmount`), and only a submitted or confirmed
 * registration is billed. Waitlisted and cancelled clubs stay listed, owing $0.
 */
export async function listChurchAmountsOwed(eventId: string): Promise<ChurchAmountOwedRow[]> {
  const rows = await getPrisma().clubEventRegistration.findMany({
    where: { eventId },
    select: {
      organization: {
        select: { id: true, name: true, parentOrganization: { select: { id: true, name: true } } },
      },
      registration: {
        select: {
          confirmationCode: true,
          status: true,
          totalAmount: true,
          _count: { select: { attendees: true } },
        },
      },
    },
  });
  return sortChurchAmountsOwed(rows.map((row) => ({
    organizationId: row.organization.id,
    organizationName: row.organization.name,
    churchId: row.organization.parentOrganization?.id ?? null,
    churchName: row.organization.parentOrganization?.name ?? null,
    confirmationCode: row.registration.confirmationCode,
    status: row.registration.status,
    attendeeCount: row.registration._count.attendees,
    isBilled: isChurchBilledStatus(row.registration.status),
    amountOwedCents: churchOwedCents(row.registration.status, moneyToCents(row.registration.totalAmount)),
  })));
}

export type ChurchAmountOwed = ChurchAmountOwedRow;

export type ClubCheckInInfo = {
  organizationId: string;
  organizationName: string;
  confirmationCode: string;
  /** Read-only estimate billed to the church (#409); never an attendee balance or a door payment. */
  amountOwedCents: number;
};

/**
 * Clubs eligible for check-in at this event (#412): one row per active
 * (submitted or confirmed) club registration, the same eligibility rule
 * single-attendee check-in already enforces. Lets check-in staff find a
 * whole club by confirmation code or club name and see what its church owes,
 * without exposing an attendee balance or a payment action.
 */
export async function listClubCheckInInfo(eventId: string): Promise<ClubCheckInInfo[]> {
  const rows = await getPrisma().clubEventRegistration.findMany({
    where: { eventId, registration: { status: { in: [...activeRegistrationStatuses] } } },
    select: {
      organization: { select: { id: true, name: true } },
      registration: { select: { confirmationCode: true, status: true, totalAmount: true } },
    },
  });
  return rows.map((row) => ({
    organizationId: row.organization.id,
    organizationName: row.organization.name,
    confirmationCode: row.registration.confirmationCode,
    amountOwedCents: churchOwedCents(row.registration.status, moneyToCents(row.registration.totalAmount)),
  }));
}

async function requireClubEvent(eventId: string): Promise<ClubEvent> {
  const event = await getPrisma().event.findFirst({
    where: { id: eventId, isPublished: true, billingMode: "DEFERRED_ORGANIZATION_INVOICE" },
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

function clubEditWindow(event: ClubEvent, now: Date) {
  return clubRegistrationEditWindow({
    phase: evaluateEventRegistrationPhase(event, now),
    registrationClosesOn: event.registrationClosesOn,
    today: calendarDateInEventTimeZone(now, event.timezone),
    eventDate: calendarDateInEventTimeZone(event.startsAt, event.timezone),
  });
}

/** Everything the director's page needs for one club event. */
export async function getClubEventWorkspace(organizationId: string, eventId: string, now = new Date()) {
  const event = await requireClubEvent(eventId);
  const eventDate = calendarDateInEventTimeZone(event.startsAt, event.timezone);
  const [form, members, clubRegistration, draft] = await Promise.all([
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
            totalAmount: true,
            attendees: { orderBy: { position: "asc" }, select: { id: true, profileSnapshot: true, formResponses: true } },
          },
        },
      },
    }),
    getPrisma().clubRegistrationDraft.findUnique({ where: { eventId_organizationId: { eventId, organizationId } } }),
  ]);
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
      };
    })
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
  return {
    event: {
      id: event.id,
      name: event.name,
      startsAt: event.startsAt.toISOString(),
      timezone: event.timezone,
      eventDate,
      phase: evaluateEventRegistrationPhase(event, now),
      registrationClosesOn: event.registrationClosesOn,
      // Whether a submitted registration may still be reopened (H3b, #366).
      edit: clubEditWindow(event, now),
    },
    problem,
    experience,
    lockedAttendeeFieldKeys: experience ? lockedAttendeeFieldKeys(experience.form.definition) : [],
    roster,
    registration: clubRegistration
      ? {
        confirmationCode: clubRegistration.registration.confirmationCode,
        status: clubRegistration.registration.status,
        submittedAt: clubRegistration.createdAt.toISOString(),
        updatedAt: clubRegistration.registration.updatedAt.toISOString(),
        // What the church owes for this registration (#409): priced by the
        // same engine as any other registration, never an attendee balance
        // or a card payment — this event bills the church directly.
        amountOwedCents: churchOwedCents(
          clubRegistration.registration.status,
          moneyToCents(clubRegistration.registration.totalAmount),
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
        responses: draft.responses as Record<string, unknown>,
        attendeeResponses: draft.attendeeResponses as Record<string, Record<string, unknown>>,
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
};

/** Saves the director's work in progress. People are roster IDs from this club only. */
export async function saveClubRegistrationDraft(
  organizationId: string,
  eventId: string,
  accountId: string,
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
  const data = {
    selectedMemberIds: input.selectedMemberIds,
    guests: input.guests as Prisma.InputJsonValue,
    responses: input.responses as Prisma.InputJsonValue,
    attendeeResponses: attendeeResponses as Prisma.InputJsonValue,
    updatedByAccountId: accountId,
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
      select: { guests: true },
    });
    const guestsById = new Map(guestsFromJson(draft?.guests).map((guest) => [guest.id, guest]));
    const eventDate = calendarDateInEventTimeZone(event.startsAt, event.timezone);
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
      const person = rosterPerson(member, eventDate);
      resolved.set(attendee.clientId, { personId: member.personId, rosterMemberId: member.id, ageOnEventDate: person.ageOnEventDate });
      return { ...attendee, responses: { ...attendee.responses, ...rosterOwnedResponses(definition as RegistrationFormDefinition, person) } };
    });
    return { input: { ...input, attendees: rewritten } satisfies PublicRegistrationInput, attendees: resolved };
  };
}

export async function submitClubRegistration(
  organizationId: string,
  eventId: string,
  accountId: string,
  input: PublicRegistrationInput,
  now = new Date(),
) {
  const event = await requireClubEvent(eventId);
  const form = await publishedClubForm(event.id);
  if (!form) throw new ClubRegistrationError("FORM_UNAVAILABLE", "The event has no published registration form yet.");
  return submitPublicRegistration(event.slug, form.slug, input, now, {
    organizationId,
    submittedByAccountId: accountId,
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
  accountId: string,
  input: ClubRegistrationEditInput,
  now = new Date(),
) {
  const event = await requireClubEvent(eventId);
  const window = clubEditWindow(event, now);
  if (!window.open) throw new ClubRegistrationError("REGISTRATION_CLOSED", window.message);
  const form = await publishedClubForm(event.id);
  if (!form) throw new ClubRegistrationError("FORM_UNAVAILABLE", "The event has no published registration form yet.");
  const problem = clubFormProblem(form.definition);
  if (problem) throw new ClubRegistrationError("FORM_UNAVAILABLE", problem);

  const clubRegistration = await getPrisma().clubEventRegistration.findUnique({
    where: { eventId_organizationId: { eventId, organizationId } },
    select: { registrationId: true },
  });
  if (!clubRegistration) {
    throw new ClubRegistrationError("REGISTRATION_NOT_FOUND", "Your club hasn't registered for this event yet.");
  }
  const registrationId = clubRegistration.registrationId;

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
    getPrisma().attendeeAccount.findUnique({ where: { id: accountId }, select: { displayName: true } }),
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
  try {
    const preview = await previewRegistrationAmendment(eventId, registrationId, amendmentInput, { attendees: serverOptions, requestFingerprint });
    const response = await amendRegistration(
      eventId,
      registrationId,
      { ...amendmentInput, previewOnly: false, quoteFingerprint: preview.quoteFingerprint },
      { kind: "CLUB_DIRECTOR", attendeeAccountId: accountId, displayName: account?.displayName ?? "Club director" },
      now,
      { attendees: serverOptions, requestFingerprint },
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
