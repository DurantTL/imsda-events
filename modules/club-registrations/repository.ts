import "server-only";

import { Prisma, RegistrationFormStatus } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { openBirthDate } from "@/modules/club-rosters/birth-dates";
import { ageOn, clubYearFor } from "@/modules/club-rosters/domain";
import {
  clubAttendeeClientId,
  clubFormProblem,
  clubGuestClientId,
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
import { calendarDateInEventTimeZone, evaluateEventRegistrationPhase } from "@/modules/events/lifecycle";
import {
  amendRegistration,
  currentRegistrationAnswers,
  previewRegistrationAmendment,
} from "@/modules/registrations/amendments-repository";
import type { RegistrationAmendmentInput } from "@/modules/registrations/schemas";

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
      | "ATTENDEES_INVALID",
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
            select: { confirmationCode: true, status: true, _count: { select: { attendees: true } } },
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
        ? { confirmationCode: registration.confirmationCode, status: registration.status, attendeeCount: registration._count.attendees }
        : null,
      draft: draft ? { updatedAt: draft.updatedAt.toISOString(), selectedCount: draft.selectedMemberIds.length } : null,
    });
  }
  return results;
}

export type ClubEventSummary = Awaited<ReturnType<typeof listClubEvents>>[number];

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
        registration: {
          select: {
            confirmationCode: true,
            status: true,
            updatedAt: true,
            attendees: { orderBy: { position: "asc" }, select: { profileSnapshot: true, formResponses: true } },
          },
        },
      },
    }),
    getPrisma().clubRegistrationDraft.findUnique({ where: { eventId_organizationId: { eventId, organizationId } } }),
  ]);
  const problem = form ? clubFormProblem(form.definition) : "The event has no published registration form yet.";
  const experience = form && !problem ? await getPublicRegistrationExperience(event.slug, form.slug) : null;
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
        attendees: clubRegistration.registration.attendees.map(({ profileSnapshot, formResponses }) => {
          const snapshot = profileSnapshot as {
            firstName?: string;
            lastName?: string;
            ageOnEventDate?: number | null;
            temporary?: boolean;
            clubRosterMemberId?: string;
            clubGuestId?: string;
          };
          return {
            firstName: snapshot.firstName ?? "",
            lastName: snapshot.lastName ?? "",
            ageOnEventDate: snapshot.ageOnEventDate ?? null,
            temporary: snapshot.temporary === true,
            // For seeding a reopened edit (H3b, #366): which roster person
            // or extra person this attendee is, so the edit page can
            // re-tick who's going and re-show extra people. Null for a
            // registration submitted before this feature or otherwise
            // untracked; such an attendee can still be removed in an edit,
            // just not automatically re-selected.
            clubRosterMemberId: snapshot.clubRosterMemberId ?? null,
            guestId: snapshot.temporary === true ? (snapshot.clubGuestId ?? null) : null,
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

type CurrentClubAttendee = { id: string; profileSnapshot: unknown };

/**
 * H3b (#366): a director reopens a submitted club registration and adds or
 * removes roster people or extra people, or changes their answers, through
 * the same staff amendment engine (`amendRegistration`) a staff member's
 * edit goes through — a director actor instead, so capacity, audit, and
 * notices stay the one path. Refused once the event's registration deadline
 * (in the event's own time zone) has passed, or if the published form has
 * since become unusable for club registration (`clubFormProblem`, reused
 * here exactly as the submit path uses it).
 */
export async function amendClubRegistration(
  organizationId: string,
  eventId: string,
  accountId: string,
  input: ClubRegistrationEditInput,
  now = new Date(),
) {
  const event = await requireClubEvent(eventId);
  if (evaluateEventRegistrationPhase(event, now) === "CLOSED") {
    const closing = event.registrationClosesOn ? ` Registration closed after ${event.registrationClosesOn}.` : "";
    throw new ClubRegistrationError("REGISTRATION_CLOSED", `Registration for this event is closed.${closing}`);
  }
  const account = await getPrisma().attendeeAccount.findUnique({ where: { id: accountId }, select: { displayName: true } });
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

  const [answers, currentAttendees, members] = await Promise.all([
    currentRegistrationAnswers(eventId, registrationId),
    getPrisma().registrationAttendee.findMany({
      where: { registrationId },
      select: { id: true, profileSnapshot: true },
    }) as Promise<CurrentClubAttendee[]>,
    activeRosterFor(getPrisma(), organizationId, event),
  ]);
  if (!answers) {
    throw new ClubRegistrationError("REGISTRATION_NOT_FOUND", "Your club's registration for this event could not be found.");
  }

  const allowedMemberIds = new Set(members.map((member) => member.id));
  if (input.selectedMemberIds.some((memberId) => !allowedMemberIds.has(memberId))) {
    throw new ClubRegistrationError("MEMBER_NOT_ON_ROSTER", "Everyone going must be active on your club roster. Refresh the page and try again.");
  }

  const currentByMemberId = new Map<string, CurrentClubAttendee>();
  const currentByGuestId = new Map<string, CurrentClubAttendee>();
  for (const attendee of currentAttendees) {
    const snapshot = recordFromJson(attendee.profileSnapshot);
    const memberId = typeof snapshot.clubRosterMemberId === "string" ? snapshot.clubRosterMemberId : null;
    if (memberId) currentByMemberId.set(memberId, attendee);
    if (snapshot.temporary === true) {
      const guestId = typeof snapshot.clubGuestId === "string" ? snapshot.clubGuestId : attendee.id;
      currentByGuestId.set(guestId, attendee);
    }
  }
  const missingKeptGuest = input.keptGuestIds.find((guestId) => !currentByGuestId.has(guestId));
  if (missingKeptGuest) {
    throw new ClubRegistrationError(
      "GUEST_INVALID",
      "One of the extra people on this registration wasn't found. Refresh the page and try again.",
    );
  }
  const newGuestIds = new Set(input.newGuests.map((guest) => guest.id));
  if (newGuestIds.size !== input.newGuests.length || input.keptGuestIds.some((guestId) => newGuestIds.has(guestId))) {
    throw new ClubRegistrationError("GUEST_INVALID", "Each extra person needs their own entry. Refresh the page and try again.");
  }

  const eventDate = calendarDateInEventTimeZone(event.startsAt, event.timezone);
  const definition = form.definition;
  const amendmentAttendees: RegistrationAmendmentInput["attendees"] = [];

  for (const memberId of input.selectedMemberIds) {
    const member = members.find((candidate) => candidate.id === memberId)!;
    const person = rosterPerson(member, eventDate);
    const clientId = clubAttendeeClientId(memberId);
    const responses = {
      ...(input.attendeeResponses[clientId] ?? {}),
      ...rosterOwnedResponses(definition, person),
    };
    amendmentAttendees.push({
      attendeeId: currentByMemberId.get(memberId)?.id ?? null,
      clientId,
      responses,
      attendeeMetadata: {
        clubOrganizationId: organizationId,
        clubRosterMemberId: memberId,
        ageOnEventDate: person.ageOnEventDate,
      },
    });
  }

  for (const guestId of input.keptGuestIds) {
    const current = currentByGuestId.get(guestId)!;
    const snapshot = recordFromJson(current.profileSnapshot);
    const person: RosterPerson = {
      firstName: typeof snapshot.firstName === "string" ? snapshot.firstName : "",
      lastName: typeof snapshot.lastName === "string" ? snapshot.lastName : "",
      ageOnEventDate: typeof snapshot.ageOnEventDate === "number" ? snapshot.ageOnEventDate : null,
      gender: null,
    };
    const clientId = clubGuestClientId(guestId);
    const responses = {
      ...(input.attendeeResponses[clientId] ?? {}),
      ...rosterOwnedResponses(definition, person),
    };
    amendmentAttendees.push({
      attendeeId: current.id,
      clientId,
      responses,
      attendeeMetadata: {
        clubOrganizationId: organizationId,
        ageOnEventDate: person.ageOnEventDate,
        temporary: true,
        temporaryAttendeeType: typeof snapshot.temporaryAttendeeType === "string" ? snapshot.temporaryAttendeeType : "ADULT",
        clubGuestId: guestId,
      },
    });
  }

  for (const guest of input.newGuests) {
    const person: RosterPerson = { firstName: guest.firstName, lastName: guest.lastName, ageOnEventDate: guest.age, gender: null };
    const clientId = clubGuestClientId(guest.id);
    const responses = {
      ...(input.attendeeResponses[clientId] ?? {}),
      ...rosterOwnedResponses(definition, person),
    };
    amendmentAttendees.push({
      attendeeId: null,
      clientId,
      responses,
      attendeeMetadata: {
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
  const preview = await previewRegistrationAmendment(eventId, registrationId, amendmentInput);
  return amendRegistration(
    eventId,
    registrationId,
    { ...amendmentInput, previewOnly: false, quoteFingerprint: preview.quoteFingerprint },
    { kind: "CLUB_DIRECTOR", attendeeAccountId: accountId, displayName: account?.displayName ?? "Club director" },
    now,
  );
}
