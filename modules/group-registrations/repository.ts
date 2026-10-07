import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { attendeeAgeKey } from "@/modules/club-registrations/domain";
import {
  ClubRegistrationError,
  clubEditWindow,
  clubLocationSelect,
  clubLocationView,
  clubPhase,
  locationSeatCounts,
  publishedClubForm,
  recordFromJson,
  requireClubEvent,
  type ClubEvent,
} from "@/modules/club-registrations/repository";
import { currentPricingSnapshot, lineItemsFromPricingSnapshot } from "@/modules/club-registrations/per-person-price";
import { calendarDateInEventTimeZone } from "@/modules/events/lifecycle";
import { effectiveLocationDates, hasLocationEnded } from "@/modules/event-locations/domain";
import { EventLocationError } from "@/modules/event-locations/errors";
import { locationOpenProblem } from "@/modules/event-locations/admission";
import type { PublicRegistrationInput } from "@/modules/forms/public-domain";
import {
  getPublicRegistrationExperience,
  PublicRegistrationError,
  submitPublicRegistration,
  type GroupSubmissionContext,
} from "@/modules/forms/public-repository";
import {
  estimateFromPricing,
  groupFormDefinition,
  groupFormProblem,
  groupPickingAttendee,
  groupSeatType,
  GROUP_BILLING_NOTICE,
  isValidGroupAttendeeClientId,
  MAX_GROUP_ATTENDEES,
  parseGroupAge,
  type GroupRegistrationEditInput,
} from "@/modules/group-registrations/domain";
import {
  ClassSelectionError,
  getGroupClassSelectionWorkspace,
  getRegistrationHonorsCatalog,
  setGroupClassSelections,
} from "@/modules/honors/enrollment-repository";
import { consumesClassSeat } from "@/modules/honors/enrollment-domain";
import { picksByAttendeeId } from "@/modules/honors/registration-picks";
import { toPublicSeatView } from "@/modules/honors/class-picker-view";
import {
  amendRegistration,
  currentRegistrationAnswers,
  previewRegistrationAmendment,
  RegistrationAmendmentError,
  type AmendmentAttendeeServerOptions,
  type AmendmentServerOptions,
} from "@/modules/registrations/amendments-repository";
import { registrationOperationFingerprint } from "@/modules/registrations/operations-domain";
import type { RegistrationAmendmentInput } from "@/modules/registrations/schemas";
import { authorizeRegistrationAccessToken } from "@/modules/public-access/repository";

/**
 * "Group" registration on a club event (#650). The same per-person flow clubs
 * use, for people who are not in a club: one contact registers 1..N people,
 * each with a location-dependent set of classes, priced and validated by the
 * server. Never attributable to a club or church, and it creates no roster
 * members. The contact is the billing party and can reopen the registration
 * from its private manage link until registration closes.
 */

export class GroupRegistrationError extends Error {
  constructor(
    public readonly code:
      | "EVENT_NOT_FOUND"
      | "FORM_UNAVAILABLE"
      | "REGISTRATION_NOT_FOUND"
      | "REGISTRATION_CLOSED"
      | "ATTENDEES_INVALID"
      | "CLASS_PICKS_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "GroupRegistrationError";
  }
}

/**
 * Turns the people typed into the form into group attendees, inside the submit
 * transaction. Everyone needs an age on the event date: class minimum ages and
 * the seat rule read it, and the server reads it from the answers, never from a
 * type the browser claims. Nobody is looked up on, or added to, any roster.
 */
export function groupAttendeePreparer(): GroupSubmissionContext["prepareAttendees"] {
  return async (_tx, { definition, input }) => {
    const problem = groupFormProblem(definition);
    if (problem) throw new PublicRegistrationError("GROUP_REGISTRATION_UNAVAILABLE", problem);
    const attendees = input.attendees ?? [];
    if (attendees.length === 0) throw new PublicRegistrationError("GROUP_ATTENDEES_INVALID", "Add at least one person.");
    if (attendees.length > MAX_GROUP_ATTENDEES) {
      throw new PublicRegistrationError("GROUP_ATTENDEES_INVALID", `Add up to ${MAX_GROUP_ATTENDEES} people in one registration.`);
    }
    const ageKey = attendeeAgeKey(definition)!;
    const resolved: Awaited<ReturnType<GroupSubmissionContext["prepareAttendees"]>>["attendees"] = new Map();
    for (const [index, attendee] of attendees.entries()) {
      if (!isValidGroupAttendeeClientId(attendee.clientId) || resolved.has(attendee.clientId)) {
        throw new PublicRegistrationError("GROUP_ATTENDEES_INVALID", "Refresh the page and add the people again.");
      }
      const raw = attendee.responses[ageKey];
      const age = parseGroupAge(raw);
      const blank = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
      // A blank age is left to the form's own required-field check, which points at the field;
      // anything else that isn't a whole number from 0 to 120 is refused here.
      if (age === null && !blank) {
        throw new PublicRegistrationError("GROUP_ATTENDEES_INVALID", `Enter person ${index + 1}'s age on the event date, from 0 to 120.`);
      }
      resolved.set(attendee.clientId, {
        personId: null,
        rosterMemberId: null,
        ageOnEventDate: age,
        // The seat rule follows the age the server read (under 18 uses a class seat).
        guest: { email: null, attendeeType: groupSeatType(age ?? 0), guestId: attendee.clientId },
      });
    }
    return { input, attendees: resolved };
  };
}

async function groupEventBySlug(eventSlug: string) {
  const event = await getPrisma().event.findFirst({
    // An event with team rules (#809) takes club teams only: a group would skip every team rule.
    where: { slug: eventSlug, isPublished: true, audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", teamSettings: { is: null } },
    select: { id: true },
  });
  if (!event) throw new GroupRegistrationError("EVENT_NOT_FOUND", "That event isn't taking group registrations.");
  return requireClubEvent(event.id).catch((error: unknown) => {
    if (error instanceof ClubRegistrationError) throw new GroupRegistrationError("EVENT_NOT_FOUND", "That event isn't taking group registrations.");
    throw error;
  });
}

/** The location fields a public visitor needs: where and when, and whether it can still be picked. No seat counts. */
function publicLocation(location: ReturnType<typeof clubLocationView>) {
  return {
    id: location.id,
    name: location.name,
    address: location.address,
    firstDay: location.firstDay,
    lastDay: location.lastDay,
    registrationClosesOn: location.registrationClosesOn,
    ownClosingDate: location.ownClosingDate,
    full: location.full,
    waitlistOnFull: location.waitlistOnFull,
    phase: location.phase,
    open: location.open,
    isActive: location.isActive,
  };
}

/**
 * What the public "Group" page needs (#650): the event form as a group sees it
 * (no club or church questions), the event's locations and classes with live
 * seats, and the billing words. Null when the event isn't taking groups.
 */
export async function getGroupRegistrationExperience(eventSlug: string, now = new Date()) {
  const event = await groupEventBySlug(eventSlug);
  const form = await publishedClubForm(event.id);
  if (!form) return { event: null, problem: "The event has no published registration form yet." as string | null, experience: null, locations: [], honorsCatalog: null };
  const definition = groupFormDefinition(form.definition);
  const problem = groupFormProblem(definition);
  const experience = problem ? null : await getPublicRegistrationExperience(event.slug, form.slug);
  const locations = await getPrisma().eventLocation.findMany({
    where: { eventId: event.id, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { name: "asc" }],
    select: clubLocationSelect,
  });
  const seats = locations.length > 0 ? await locationSeatCounts(getPrisma(), event.id) : new Map<string, number>();
  const honorsCatalog = problem ? null : await getRegistrationHonorsCatalog(null, event.id);
  return {
    event: {
      id: event.id,
      name: event.name,
      slug: event.slug,
      eventDate: calendarDateInEventTimeZone(event.startsAt, event.timezone),
      phase: clubPhase(event, locations, null, now),
    },
    problem,
    experience: experience ? { ...experience, form: { ...experience.form, definition } } : null,
    locations: locations.map((location) => publicLocation(clubLocationView(event, location, seats.get(location.id) ?? 0, now))),
    // Public and unauthenticated: classes carry only an availability status, never capacity or seats taken (#650 review).
    honorsCatalog: honorsCatalog && honorsCatalog.offerings.length > 0
      ? { ...honorsCatalog, offerings: honorsCatalog.offerings.map(toPublicSeatView) }
      : null,
    billingNotice: GROUP_BILLING_NOTICE,
  };
}

export type GroupRegistrationExperience = Awaited<ReturnType<typeof getGroupRegistrationExperience>>;

/**
 * Saves the classes picked while registering, right after the registration
 * commits, through the same enrollment rules as every other pick: seats, the
 * group's own per-club limit, site, age and one-per-session (#650).
 */
export async function saveGroupHonorPicks(
  registrationId: string,
  eventId: string,
  picks: Record<string, string[]>,
  now = new Date(),
) {
  if (Object.values(picks).every((ids) => ids.length === 0)) return { saved: 0 };
  const registration = await getPrisma().groupEventRegistration.findFirst({
    where: { registrationId, eventId },
    select: {
      billingPersonId: true,
      registration: { select: { attendees: { orderBy: { position: "asc" }, select: { id: true, profileSnapshot: true } } } },
    },
  });
  if (!registration) throw new ClassSelectionError("NOT_REGISTERED", "Register your group for this event before choosing classes.");
  const { mapped, unknown } = picksByAttendeeId(
    picks,
    registration.registration.attendees.map((attendee) => ({
      id: attendee.id,
      groupAttendeeId: typeof recordFromJson(attendee.profileSnapshot).groupAttendeeId === "string"
        ? String(recordFromJson(attendee.profileSnapshot).groupAttendeeId)
        : null,
    })),
  );
  if (unknown.length > 0) throw new ClassSelectionError("ATTENDEE_NOT_FOUND", "That person isn't on your group's registration.");
  await setGroupClassSelections(registrationId, eventId, { groupContactPersonId: registration.billingPersonId }, mapped, now);
  return { saved: Object.values(mapped).reduce((total, ids) => total + ids.length, 0) };
}

const waitlistedHonorsMessage = "This group is waitlisted, so classes weren't saved. Pick classes after you're confirmed.";

/**
 * Submits a group registration. The contact, each person's answers, the price,
 * and the location all go through the ordinary public submit transaction, so
 * the server owns pricing, capacity, and validation. Picked classes are then
 * saved by the enrollment domain; if a class filled meanwhile the registration
 * still stands and the result says so.
 */
export async function submitGroupRegistration(
  eventSlug: string,
  input: PublicRegistrationInput,
  options: { locationId?: string | null; honorSelections?: Record<string, string[]> } = {},
  now = new Date(),
) {
  const event = await groupEventBySlug(eventSlug);
  const form = await publishedClubForm(event.id);
  if (!form) throw new GroupRegistrationError("FORM_UNAVAILABLE", "The event has no published registration form yet.");
  let outcome: { replayed: boolean; waitlisted: boolean } | null = null;
  let registrationId: string | null = null;
  const confirmation = await submitPublicRegistration(event.slug, form.slug, input, now, {
    group: true,
    locationId: options.locationId ?? null,
    report: (reported) => { outcome = reported; },
    registered: (id) => { registrationId = id; },
    prepareAttendees: groupAttendeePreparer(),
  });
  let honors: { saved: number } | { error: string } | null = null;
  const picks = options.honorSelections ?? {};
  const settled = outcome as { replayed: boolean; waitlisted: boolean } | null;
  const createdId = registrationId as string | null;
  // A replay never re-applies picks, and a waitlisted group holds no seats yet.
  if (settled && createdId && !settled.replayed && Object.values(picks).some((ids) => ids.length > 0)) {
    if (settled.waitlisted) {
      honors = { error: waitlistedHonorsMessage };
    } else {
      try {
        honors = await saveGroupHonorPicks(createdId, event.id, picks, now);
      } catch (error) {
        honors = {
          error: error instanceof ClassSelectionError && error.code !== "NOT_REGISTERED"
            ? error.message
            : "Your registration is saved, but the classes were not. Choose them from your registration page.",
        };
      }
    }
  }
  return { confirmation, honors };
}

/** The registration behind a private manage link, only when it is a group's. */
async function loadGroupByToken(token: string, now: Date) {
  const access = await authorizeRegistrationAccessToken(token, { now });
  if (!access) return null;
  const group = await getPrisma().groupEventRegistration.findUnique({
    where: { registrationId: access.registrationId },
    select: {
      billingPersonId: true,
      registration: {
        select: {
          id: true,
          eventId: true,
          status: true,
          confirmationCode: true,
          updatedAt: true,
          accountHolderPersonId: true,
          contactSnapshot: true,
          location: { select: clubLocationSelect },
          publicFormSubmission: { select: { pricingSnapshot: true } },
          operations: { where: { type: "AMENDMENT" }, orderBy: { createdAt: "desc" }, take: 1, select: { afterSnapshot: true } },
          attendees: { orderBy: { position: "asc" }, select: { id: true, personId: true, profileSnapshot: true, formResponses: true } },
        },
      },
    },
  });
  return group ? { access, ...group } : null;
}

function snapshotAge(snapshot: Record<string, unknown>) {
  return typeof snapshot.ageOnEventDate === "number" ? snapshot.ageOnEventDate : null;
}

function attendeeGroupId(attendee: { id: string; profileSnapshot: unknown }) {
  const snapshot = recordFromJson(attendee.profileSnapshot);
  return typeof snapshot.groupAttendeeId === "string" ? snapshot.groupAttendeeId : `attendee:${attendee.id}`;
}

/**
 * Everything the group contact's "my registration" page needs (#650): who is
 * registered with their answers and classes, where, the estimated total (the
 * contact pays it, unlike a church-billed club), and whether it can still be
 * changed. Null for a link that isn't a group registration's.
 */
export async function getGroupRegistrationWorkspace(token: string, now = new Date()) {
  const loaded = await loadGroupByToken(token, now);
  if (!loaded) return null;
  const { registration } = loaded;
  const event = await requireClubEvent(registration.eventId).catch(() => null);
  if (!event) return null;
  const form = await publishedClubForm(event.id);
  const locations = await getPrisma().eventLocation.findMany({
    where: { eventId: event.id, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { name: "asc" }],
    select: clubLocationSelect,
  });
  const seats = locations.length > 0 ? await locationSeatCounts(getPrisma(), event.id, registration.id) : new Map<string, number>();
  const registeredLocation = registration.location;
  const answers = await currentRegistrationAnswers(event.id, registration.id);
  const snapshot = currentPricingSnapshot(registration);
  const estimate = estimateFromPricing({
    lineItems: lineItemsFromPricingSnapshot(snapshot),
    attendeeCount: registration.attendees.length,
  });
  const classes = await getGroupClassSelectionWorkspace(registration.id, event.id, now).catch((error: unknown) => {
    if (error instanceof ClassSelectionError && error.code === "NOT_REGISTERED") return null;
    throw error;
  });
  const definition = form ? groupFormDefinition(form.definition) : null;
  const experience = form && definition && groupFormProblem(definition) === null
    ? await getPublicRegistrationExperience(event.slug, form.slug)
    : null;
  return {
    event: {
      id: event.id,
      name: event.name,
      slug: event.slug,
      eventDate: calendarDateInEventTimeZone(event.startsAt, event.timezone),
      ended: hasLocationEnded(event, registeredLocation, now),
      registrationClosesOn: effectiveLocationDates(event, registeredLocation).registrationClosesOn,
      edit: clubEditWindow(event, registeredLocation, now),
    },
    registration: {
      confirmationCode: registration.confirmationCode,
      status: registration.status,
      updatedAt: registration.updatedAt.toISOString(),
      contact: recordFromJson(registration.contactSnapshot),
      location: registeredLocation ? publicLocation(clubLocationView(event, registeredLocation, seats.get(registeredLocation.id) ?? 0, now)) : null,
      registrationResponses: answers?.responses ?? {},
      attendees: registration.attendees.map((attendee) => {
        const attendeeSnapshot = recordFromJson(attendee.profileSnapshot);
        return {
          attendeeId: attendee.id,
          clientId: attendeeGroupId(attendee),
          firstName: typeof attendeeSnapshot.firstName === "string" ? attendeeSnapshot.firstName : "",
          lastName: typeof attendeeSnapshot.lastName === "string" ? attendeeSnapshot.lastName : "",
          ageOnEventDate: snapshotAge(attendeeSnapshot),
          responses: recordFromJson(attendee.formResponses),
        };
      }),
    },
    billing: {
      notice: GROUP_BILLING_NOTICE,
      estimate,
      lineItems: lineItemsFromPricingSnapshot(snapshot),
    },
    locations: locations.map((location) => publicLocation(clubLocationView(event, location, seats.get(location.id) ?? 0, now))),
    // The event form as a group sees it: what the people's edit form is built from (#650).
    experience: experience && definition ? { ...experience, form: { ...experience.form, definition } } : null,
    // Names are the contact's to correct; nothing on a group person is locked (#650).
    lockedAttendeeFieldKeys: [] as string[],
    attendeeAgeKey: definition ? attendeeAgeKey(definition) : null,
    classes,
  };
}

export type GroupRegistrationWorkspace = NonNullable<Awaited<ReturnType<typeof getGroupRegistrationWorkspace>>>;

function snapshotName(snapshot: Record<string, unknown>) {
  return `${typeof snapshot.firstName === "string" ? snapshot.firstName : ""} ${typeof snapshot.lastName === "string" ? snapshot.lastName : ""}`.trim() || "Someone";
}

/** The class picks' age and seat rules after the people were changed, inside the amendment's own transaction. */
async function assertClassPicksStillValid(tx: Prisma.TransactionClient, registrationId: string) {
  const enrollments = await tx.honorEnrollment.findMany({
    where: { registrationId },
    select: {
      consumesSeat: true,
      offering: { select: { minimumAge: true, honor: { select: { name: true } } } },
      registrationAttendee: { select: { profileSnapshot: true } },
    },
  });
  for (const enrollment of enrollments) {
    const snapshot = recordFromJson(enrollment.registrationAttendee.profileSnapshot);
    const name = snapshotName(snapshot);
    const age = snapshotAge(snapshot);
    const type = snapshot.temporaryAttendeeType === "ADULT" ? "ADULT" : "YOUTH";
    if (enrollment.offering.minimumAge !== null && (age === null || age < enrollment.offering.minimumAge)) {
      throw new GroupRegistrationError(
        "CLASS_PICKS_CONFLICT",
        `${name} is too young for ${enrollment.offering.honor.name} (ages ${enrollment.offering.minimumAge} and up). Remove that class first, then change the age.`,
      );
    }
    // A change that would start or stop using a class seat is decided with the classes, not silently here.
    if (consumesClassSeat(type) !== enrollment.consumesSeat) {
      throw new GroupRegistrationError(
        "CLASS_PICKS_CONFLICT",
        `Changing ${name}'s age changes whether they use a class seat in ${enrollment.offering.honor.name}. Remove their classes first, change the age, then choose classes again.`,
      );
    }
  }
}

/**
 * Reopens a submitted group registration (#650): the contact adds or removes
 * people and changes their details or the location, through the same amendment
 * engine a club director's edit and a staff member's edit go through, so
 * capacity, pricing, audit and notices are the one path. Refused unless
 * registration is still open; ages are re-read from the answers and class
 * picks are re-validated in the same transaction, so a change that would
 * leave someone too young for a class, or change whether they use a seat,
 * is refused and nothing is saved. People are removed with their classes, which
 * frees those seats.
 */
export async function amendGroupRegistration(token: string, input: GroupRegistrationEditInput, now = new Date()) {
  const loaded = await loadGroupByToken(token, now);
  if (!loaded) throw new GroupRegistrationError("REGISTRATION_NOT_FOUND", "This registration link is no longer valid.");
  const { registration } = loaded;
  const event: ClubEvent = await requireClubEvent(registration.eventId);
  const window = clubEditWindow(event, registration.location, now);
  if (!window.open) throw new GroupRegistrationError("REGISTRATION_CLOSED", window.message);
  const form = await publishedClubForm(event.id);
  if (!form) throw new GroupRegistrationError("FORM_UNAVAILABLE", "The event has no published registration form yet.");
  const definition = groupFormDefinition(form.definition);
  const problem = groupFormProblem(definition);
  if (problem) throw new GroupRegistrationError("FORM_UNAVAILABLE", problem);

  if (input.locationId && input.locationId !== registration.location?.id) {
    const target = await getPrisma().eventLocation.findFirst({
      where: { id: input.locationId, eventId: event.id, isActive: true },
      select: clubLocationSelect,
    });
    if (!target) throw new EventLocationError("LOCATION_INVALID", "That location isn't available. Refresh the page and choose again.");
    const closed = locationOpenProblem(event, target, now);
    if (closed) throw new GroupRegistrationError("REGISTRATION_CLOSED", `${closed} Choose another location.`);
  }

  const { clientRequestId, ...editContent } = input;
  const requestFingerprint = registrationOperationFingerprint({
    eventId: event.id,
    registrationId: registration.id,
    operation: "AMENDMENT",
    payload: { groupEdit: editContent },
  });
  const replay = await getPrisma().registrationOperation.findUnique({
    where: { eventId_clientRequestId: { eventId: event.id, clientRequestId } },
    select: { registrationId: true, type: true, requestFingerprint: true, responseSnapshot: true },
  });
  if (replay) {
    if (replay.registrationId !== registration.id || replay.type !== "AMENDMENT" || replay.requestFingerprint !== requestFingerprint) {
      throw new RegistrationAmendmentError(
        "IDEMPOTENCY_KEY_REUSED",
        "That amendment request ID was already used for different changes. Start a new review.",
      );
    }
    return groupEditResult(replay.responseSnapshot);
  }

  const answers = await currentRegistrationAnswers(event.id, registration.id);
  if (!answers) throw new GroupRegistrationError("REGISTRATION_NOT_FOUND", "This registration could not be found.");

  const ageKey = attendeeAgeKey(definition)!;
  const currentById = new Map(registration.attendees.map((attendee) => [attendee.id, attendee]));
  if (input.attendees.length === 0) throw new GroupRegistrationError("ATTENDEES_INVALID", "A group registration needs at least one person.");
  if (input.attendees.length > MAX_GROUP_ATTENDEES) {
    throw new GroupRegistrationError("ATTENDEES_INVALID", `Add up to ${MAX_GROUP_ATTENDEES} people in one registration.`);
  }
  const seen = new Set<string>();
  const amendmentAttendees: RegistrationAmendmentInput["attendees"] = [];
  const serverOptions = new Map<string, AmendmentAttendeeServerOptions>();
  for (const [index, attendee] of input.attendees.entries()) {
    const current = attendee.attendeeId ? currentById.get(attendee.attendeeId) : undefined;
    if (attendee.attendeeId && !current) {
      throw new GroupRegistrationError("ATTENDEES_INVALID", "Someone on this registration changed since you opened it. Refresh the page and try again.");
    }
    const clientId = current ? attendeeGroupId(current) : attendee.clientId ?? "";
    if (!isValidGroupAttendeeClientId(clientId.replace(/^attendee:/, "")) || seen.has(clientId)) {
      throw new GroupRegistrationError("ATTENDEES_INVALID", "Refresh the page and try again.");
    }
    seen.add(clientId);
    const age = parseGroupAge(attendee.responses[ageKey]);
    if (age === null) {
      throw new GroupRegistrationError("ATTENDEES_INVALID", `Enter person ${index + 1}'s age on the event date, from 0 to 120.`);
    }
    // The contact may correct a kept person's name (#650). They stay the same person on the registration,
    // so their class picks and seats are untouched; the amendment engine records the change in its audit
    // (as a count, never the names). The name is read from the answers, never taken from the browser separately.
    const responses: Record<string, unknown> = { ...attendee.responses };
    const name = groupPickingAttendee(definition, { clientId, responses });
    if (!name.firstName || !name.lastName) {
      throw new GroupRegistrationError("ATTENDEES_INVALID", `Enter person ${index + 1}'s first and last name.`);
    }
    amendmentAttendees.push({ attendeeId: current?.id ?? null, clientId, responses });
    serverOptions.set(clientId, {
      ...(current ? { rosterName: { firstName: name.firstName, lastName: name.lastName }, syncPersonName: true } : {}),
      profileMetadata: { ageOnEventDate: age, temporaryAttendeeType: groupSeatType(age), groupAttendeeId: clientId },
    });
  }

  const amendmentInput: RegistrationAmendmentInput = {
    clientRequestId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    reason: "",
    // The contact's own details use their dedicated action; everything else here stays as registered.
    responses: answers.responses,
    attendees: amendmentAttendees,
    previewOnly: true,
  };
  const engineOptions: AmendmentServerOptions = {
    attendees: serverOptions,
    requestFingerprint,
    transformDefinition: groupFormDefinition,
    ...(input.locationId ? { locationId: input.locationId } : {}),
    // After the people were written, before commit: a pick that no longer fits rolls the whole edit back.
    inTransaction: (tx) => assertClassPicksStillValid(tx, registration.id),
  };
  try {
    const preview = await previewRegistrationAmendment(event.id, registration.id, amendmentInput, engineOptions);
    const contact = recordFromJson(registration.contactSnapshot);
    const response = await amendRegistration(
      event.id,
      registration.id,
      { ...amendmentInput, previewOnly: false, quoteFingerprint: preview.quoteFingerprint },
      {
        kind: "GROUP_CONTACT",
        personId: registration.accountHolderPersonId,
        displayName: `${typeof contact.firstName === "string" ? contact.firstName : ""} ${typeof contact.lastName === "string" ? contact.lastName : ""}`.trim() || "Group contact",
      },
      now,
      engineOptions,
    );
    return groupEditResult(response);
  } catch (error) {
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

/**
 * The group options for a staff member's amendment of a group registration
 * (#650), so staff edits run under the same rules as the contact's: the
 * club/church-free form, each person's age and seat type read from the
 * answers, the group attendee ids, and the class picks re-checked in the
 * same transaction. Null when the registration is not a group's, so the
 * ordinary staff amendment runs unchanged.
 */
export async function groupStaffAmendmentOptions(
  eventId: string,
  registrationId: string,
  input: Pick<RegistrationAmendmentInput, "attendees">,
): Promise<AmendmentServerOptions | null> {
  const group = await getPrisma().groupEventRegistration.findUnique({
    where: { registrationId },
    select: { registration: { select: { eventId: true, attendees: { select: { id: true, profileSnapshot: true } } } } },
  });
  if (!group || group.registration.eventId !== eventId) return null;
  const form = await publishedClubForm(eventId);
  const ageKey = form ? attendeeAgeKey(groupFormDefinition(form.definition)) : null;
  const currentById = new Map(group.registration.attendees.map((attendee) => [attendee.id, attendee]));
  const attendees = new Map<string, AmendmentAttendeeServerOptions>();
  for (const [index, attendee] of input.attendees.entries()) {
    const current = attendee.attendeeId ? currentById.get(attendee.attendeeId) : undefined;
    const groupAttendeeId = current
      ? attendeeGroupId(current)
      : isValidGroupAttendeeClientId(attendee.clientId) ? attendee.clientId : `staff-added-${index + 1}`;
    // No readable age: the amendment's own validation reports it; nothing is guessed here.
    const age = ageKey ? parseGroupAge(attendee.responses[ageKey]) : null;
    attendees.set(attendee.clientId, {
      profileMetadata: {
        groupAttendeeId,
        ...(age === null ? {} : { ageOnEventDate: age, temporaryAttendeeType: groupSeatType(age) }),
      },
    });
  }
  return {
    attendees,
    transformDefinition: groupFormDefinition,
    inTransaction: (tx) => assertClassPicksStillValid(tx, registrationId),
  };
}

/** What the contact sees after an edit: enough to confirm it saved, never the staff view of the registration. */
function groupEditResult(response: unknown) {
  const record = recordFromJson(response);
  const registration = recordFromJson(record.registration);
  const amendment = recordFromJson(record.amendment);
  return {
    result: {
      confirmationCode: typeof registration.confirmationCode === "string" ? registration.confirmationCode : null,
      updatedAt: typeof registration.updatedAt === "string" ? registration.updatedAt : null,
      attendeeCount: typeof amendment.attendeeCount === "number" ? amendment.attendeeCount : null,
      totalCents: typeof amendment.totalCents === "number" ? amendment.totalCents : null,
    },
    pendingMessageIds: Array.isArray(record.pendingMessageIds)
      ? record.pendingMessageIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/**
 * The contact changing class picks from the manage link (#650): the same
 * enrollment rules and the group's own per-club limit. Returns the refreshed
 * class workspace.
 */
export async function setGroupClassesByToken(token: string, selections: Record<string, string[]>, now = new Date()) {
  const loaded = await loadGroupByToken(token, now);
  if (!loaded) throw new GroupRegistrationError("REGISTRATION_NOT_FOUND", "This registration link is no longer valid.");
  // The location's own close applies to classes too, as it does to the people (#650 review).
  const event: ClubEvent = await requireClubEvent(loaded.registration.eventId);
  const window = clubEditWindow(event, loaded.registration.location, now);
  if (!window.open) throw new GroupRegistrationError("REGISTRATION_CLOSED", window.message);
  return setGroupClassSelections(
    loaded.registration.id,
    loaded.registration.eventId,
    { groupContactPersonId: loaded.registration.accountHolderPersonId },
    selections,
    now,
  );
}

// Re-exported for routes that only deal with groups.
export { ClassSelectionError, type GroupRegistrationEditInput };
