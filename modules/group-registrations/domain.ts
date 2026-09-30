import { z } from "zod";
import type { RegistrationFormDefinition, RegistrationFormField } from "@/modules/forms/definition";
import { attendeeAgeKey, attendeeNameKeys, clubFormProblem, guestIsAdult } from "@/modules/club-registrations/domain";
import { consumesClassSeat } from "@/modules/honors/enrollment-domain";
import type { PickingAttendee } from "@/modules/honors/registration-picks";

/**
 * "Group" registration on a club event (#650): people who are not in a club
 * (homeschoolers, unaffiliated adults) register through one contact. Pure
 * rules, shared by the server and the page, so both agree on what a group is
 * shown and asked. The registration itself runs through the ordinary public
 * submit transaction (`submitPublicRegistration`), so pricing, capacity, ages
 * and seat limits are the same server-owned rules clubs use.
 *
 * A group is never a club: it names no club or church, has no roster, and is
 * billed to its contact after the event.
 */

/** The only public word for these registrants. Never "homeschool group" or similar. */
export const GROUP_LABEL = "Group";

export const GROUP_BILLING_NOTICE = "You'll be billed after the event.";

/** One contact can register this many people in one go (the most an event form's attendee list allows). */
export const MAX_GROUP_ATTENDEES = 50;

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Whether a client-made attendee id is safe to keep on the registration and to key class picks by. */
export function isValidGroupAttendeeClientId(clientId: string) {
  return CLIENT_ID_PATTERN.test(clientId);
}

const CLUB_TEXT_KEYS = new Set(["club_name", "club"]);
const CHURCH_TEXT_KEYS = new Set(["church", "church_name"]);
const CLUB_TEXT_LABEL = /^(pathfinder\s+)?club(\s+name)?$/i;
const CHURCH_TEXT_LABEL = /^(sponsoring\s+)?(home\s+)?church(\s+name)?$/i;

/** Whether a registration-level field asks which club or church the registrant belongs to. */
function asksForClubOrChurch(field: RegistrationFormField) {
  if (field.scope !== "REGISTRATION") return false;
  if (field.optionSource === "CLUBS_DIRECTORY" || field.optionSource === "CHURCHES_DIRECTORY") return true;
  if (field.type !== "TEXT" || field.conditional) return false;
  const label = field.label.trim();
  return CLUB_TEXT_KEYS.has(field.key) || CHURCH_TEXT_KEYS.has(field.key) || CLUB_TEXT_LABEL.test(label) || CHURCH_TEXT_LABEL.test(label);
}

/**
 * The event form as a group sees it: the same questions, minus everything that
 * would tie the registration to a club or church (#650). The club and church
 * directory fields are removed, with their "Not listed" companions and anything
 * else that only shows for their answers, and "Club director" reads "Contact".
 * Names, ages, honors, pricing and the rest are untouched, so the server prices
 * and validates a group exactly as it does a club.
 */
export function groupFormDefinition(definition: RegistrationFormDefinition): RegistrationFormDefinition {
  const fields = definition.sections.flatMap((section) => section.fields);
  const removed = new Set(fields.filter(asksForClubOrChurch).map((field) => field.key));
  // A field that only shows for a removed field's answer goes too, however deep the chain.
  for (let changed = true; changed;) {
    changed = false;
    for (const field of fields) {
      if (removed.has(field.key) || !field.conditional) continue;
      if (removed.has(field.conditional.fieldKey)) {
        removed.add(field.key);
        changed = true;
      }
    }
  }
  return {
    ...definition,
    sections: definition.sections
      .map((section) => ({
        ...section,
        fields: section.fields
          .filter((field) => !removed.has(field.key))
          .map((field) => (field.scope === "REGISTRATION" && field.key === "director_name"
            ? { ...field, label: "Contact name" }
            : field)),
      }))
      .filter((section) => section.fields.length > 0),
  };
}

/**
 * Why a published form can't take group registrations, or null. The club
 * rules apply (an attendee roster, name fields, no birth dates, no free-text
 * medical questions), and an age question is required because class minimum
 * ages and the seat rules need every person's age on the event date.
 */
export function groupFormProblem(definition: RegistrationFormDefinition) {
  const problem = clubFormProblem(definition);
  if (problem) return problem;
  const ageKey = attendeeAgeKey(definition);
  if (!ageKey) return "The event's form has no attendee age question, which group registration needs for class ages.";
  const ageField = definition.sections.flatMap((section) => section.fields).find((field) => field.scope === "ATTENDEE" && field.key === ageKey);
  if (!ageField?.required || ageField.conditional) return "The event's attendee age question must be required and always shown, so every group member has an age for class rules.";
  return null;
}

export type GroupSeatType = "YOUTH" | "ADULT";

/**
 * Whether a group person uses a class seat: anyone under 18 does, adults join
 * freely. Same rule the club gives people who aren't on its roster (#388); the
 * age is what the server read from the form, never a type the browser chose.
 */
export function groupSeatType(age: number): GroupSeatType {
  return guestIsAdult({ age }) ? "ADULT" : "YOUTH";
}

/**
 * A person on the group's form, as the class picker sees them: their name and age from the answers they
 * typed, and the seat rule the server will apply to that age. Without an age there is no type yet, so
 * nothing about classes can be decided; the picker asks for the age first.
 */
export function groupPickingAttendee(
  definition: RegistrationFormDefinition,
  person: { clientId: string; responses: Record<string, unknown> },
): PickingAttendee {
  const names = attendeeNameKeys(definition);
  const text = (key: string) => (typeof person.responses[key] === "string" ? String(person.responses[key]).trim() : "");
  let firstName = "";
  let lastName = "";
  if (names?.kind === "split") {
    firstName = text(names.first);
    lastName = text(names.last);
  } else if (names) {
    const [first = "", ...rest] = text(names.key).split(/\s+/);
    firstName = first;
    lastName = rest.join(" ");
  }
  const ageKey = attendeeAgeKey(definition);
  const age = ageKey ? parseGroupAge(person.responses[ageKey]) : null;
  const attendeeType = age === null ? null : groupSeatType(age);
  return { clientId: person.clientId, firstName, lastName, ageOnEventDate: age, attendeeType, consumesSeat: consumesClassSeat(attendeeType) };
}

/** Reads the age answer as a whole number of years from 0 to 120, or null. */
export function parseGroupAge(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\s*\d{1,3}\s*$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(number) && number >= 0 && number <= 120 ? number : null;
}

export type GroupEstimate = {
  /** Sum of every line item, in cents: an estimate until staff invoice after the event. */
  totalCents: number;
  peopleCount: number;
  /** The shared per-person price when everyone pays the same, else null. */
  perPersonCents: number | null;
};

/**
 * The estimated total a group is shown (#650): the price lines the server
 * stored, summed. Unlike a church-billed club (#621) a group is shown its
 * total, because the contact pays it. The server's pricing snapshot is the
 * only source; nothing is priced here.
 */
export function estimateFromPricing(input: {
  lineItems: ReadonlyArray<{ amountCents: number; attendeeIndex?: number }>;
  attendeeCount: number;
}): GroupEstimate {
  const totalCents = input.lineItems.reduce((sum, item) => sum + item.amountCents, 0);
  const perPerson = Array.from({ length: input.attendeeCount }, () => 0);
  let registrationLevel = 0;
  for (const item of input.lineItems) {
    if (item.attendeeIndex === undefined || item.attendeeIndex >= perPerson.length) registrationLevel += item.amountCents;
    else perPerson[item.attendeeIndex] += item.amountCents;
  }
  const first = perPerson[0];
  const uniform = perPerson.length > 0 && registrationLevel === 0 && perPerson.every((amount) => amount === first);
  return { totalCents, peopleCount: input.attendeeCount, perPersonCents: uniform ? first : null };
}

/**
 * The contact reopening a group registration (#650): the people as they should
 * stand now, each a kept person (`attendeeId`) or a new one (`clientId`), with
 * their answers, and optionally a new location. Ages and seat types are read
 * from the answers on the server; names of kept people cannot change here.
 */
export const groupRegistrationEditInputSchema = z.object({
  clientRequestId: z.uuid(),
  expectedUpdatedAt: z.iso.datetime(),
  attendees: z.array(z.object({
    attendeeId: z.string().trim().min(1).max(100).nullable(),
    clientId: z.string().regex(CLIENT_ID_PATTERN).optional(),
    responses: z.record(z.string(), z.unknown()),
  }).strict()).min(1).max(MAX_GROUP_ATTENDEES),
  /** Move the registration to another location of the event; omitted leaves it where it is. */
  locationId: z.string().trim().min(1).max(100).optional(),
}).strict();

export type GroupRegistrationEditInput = z.infer<typeof groupRegistrationEditInputSchema>;
