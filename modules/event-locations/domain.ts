import { z } from "zod";
import {
  calendarDateInEventTimeZone,
  evaluateEventRegistrationPhase,
  hasEventEnded,
  type EventLifecycleSource,
  type EventRegistrationPhase,
} from "@/modules/events/lifecycle";
import { calendarDateSchema } from "@/modules/events/schemas";

/**
 * Locations inside one event (#413). An event with no locations behaves as it
 * always did. With active locations, every new club registration picks one,
 * and that location's own dates and capacity apply to it.
 */

export const maximumLocationsPerEvent = 20;

/** Case-insensitive, whitespace-collapsed identity of a location name. */
export function normalizeLocationName(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

const optionalText = (maximum: number) => z.string()
  .trim()
  .max(maximum)
  .nullish()
  .transform((value) => value || null);

const locationFields = {
  name: z.string().trim().min(1, "Name the location.").max(120, "Keep the name under 120 characters."),
  address: optionalText(500),
  firstDay: calendarDateSchema.nullish().transform((value) => value ?? null),
  lastDay: calendarDateSchema.nullish().transform((value) => value ?? null),
  capacity: z.number().int().min(1, "Capacity must be at least 1, or leave it blank for no limit.").max(100_000).nullish().transform((value) => value ?? null),
  registrationClosesOn: calendarDateSchema.nullish().transform((value) => value ?? null),
  isActive: z.boolean().default(true),
};

type DateRuleValue = { firstDay?: string | null; lastDay?: string | null; registrationClosesOn?: string | null };

export function locationDateProblem(value: DateRuleValue): { path: string; message: string } | null {
  if (value.firstDay && value.lastDay && value.lastDay < value.firstDay) {
    return { path: "lastDay", message: "The last day cannot be before the first day." };
  }
  if (value.registrationClosesOn && value.lastDay && value.registrationClosesOn > value.lastDay) {
    return { path: "registrationClosesOn", message: "Registration cannot close after the last day." };
  }
  return null;
}

function validateLocationDates(value: DateRuleValue, context: z.RefinementCtx) {
  const problem = locationDateProblem(value);
  if (problem) context.addIssue({ code: "custom", path: [problem.path], message: problem.message });
}

export const eventLocationInputSchema = z.object(locationFields).strict().superRefine(validateLocationDates);
export type EventLocationInput = z.infer<typeof eventLocationInputSchema>;

/** A partial edit: only the fields sent change. */
export const eventLocationUpdateSchema = z.object({
  name: locationFields.name.optional(),
  address: z.string().trim().max(500).nullable().transform((value) => value || null).optional(),
  firstDay: calendarDateSchema.nullable().optional(),
  lastDay: calendarDateSchema.nullable().optional(),
  capacity: z.number().int().min(1, "Capacity must be at least 1, or leave it blank for no limit.").max(100_000).nullable().optional(),
  registrationClosesOn: calendarDateSchema.nullable().optional(),
  isActive: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Nothing to change.");
export type EventLocationUpdate = z.infer<typeof eventLocationUpdateSchema>;

export const eventLocationOrderSchema = z.object({
  orderedIds: z.array(z.string().trim().min(1).max(100)).min(1).max(maximumLocationsPerEvent),
}).strict().refine((value) => new Set(value.orderedIds).size === value.orderedIds.length, "Each location can appear once.");

/** The dates that apply to a location; each falls back to the event's own. */
export type LocationDateSource = {
  firstDay: string | null;
  lastDay: string | null;
  registrationClosesOn: string | null;
};

export type EventDateSource = {
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  registrationClosesOn: string | null;
};

export function effectiveLocationDates(event: EventDateSource, location: LocationDateSource | null) {
  return {
    firstDay: location?.firstDay ?? calendarDateInEventTimeZone(event.startsAt, event.timezone),
    lastDay: location?.lastDay ?? calendarDateInEventTimeZone(event.endsAt, event.timezone),
    registrationClosesOn: location?.registrationClosesOn ?? event.registrationClosesOn,
  };
}

/**
 * The lifecycle source for one location (#413): the event's own lifecycle with
 * the location's closing date and last day taking the place of the event's.
 * A location with no dates of its own uses the event's, so #575 (registration
 * closes once the last day has passed) applies to the location's last day.
 */
export function locationLifecycleSource<T extends EventLifecycleSource>(event: T, location: LocationDateSource | null): T {
  if (!location) return event;
  return {
    ...event,
    registrationClosesOn: location.registrationClosesOn ?? event.registrationClosesOn,
    lastDay: location.lastDay ?? event.lastDay ?? null,
  };
}

export function evaluateLocationPhase(
  event: EventLifecycleSource,
  location: LocationDateSource | null,
  now = new Date(),
): EventRegistrationPhase {
  return evaluateEventRegistrationPhase(locationLifecycleSource(event, location), now);
}

export function hasLocationEnded(
  event: Pick<EventLifecycleSource, "timezone" | "endsAt">,
  location: LocationDateSource | null,
  now = new Date(),
) {
  return hasEventEnded({ ...event, lastDay: location?.lastDay ?? null }, now);
}

/** Seats left at a location; `null` means no limit. Counts people, like `Event.capacity`. */
export function remainingLocationSeats(capacity: number | null, occupied: number) {
  return capacity === null ? null : Math.max(0, capacity - occupied);
}

export function locationHasRoom(capacity: number | null, occupied: number, requested: number) {
  return capacity === null || occupied + requested <= capacity;
}

export function locationFullMessage(name: string, remaining: number | null) {
  if (remaining === null || remaining <= 0) return `${name} is full.`;
  return `Only ${remaining} ${remaining === 1 ? "spot remains" : "spots remain"} at ${name}.`;
}

/** "2026-12-05" moved by `days` calendar days, with no time zone in play. */
export function shiftCalendarDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Whole days from one calendar date to another. */
export function calendarDayDifference(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000);
}

export type ShiftableLocation = {
  name: string;
  address: string | null;
  capacity: number | null;
  sortOrder: number;
  firstDay: string | null;
  lastDay: string | null;
  registrationClosesOn: string | null;
};

/**
 * Locations for a cloned event (#157): name, address, capacity and order are
 * copied, and each date moves by the same number of days as the event's start
 * date. The order is renumbered 0..n in the source's display order.
 */
export function shiftLocationsForClone(locations: readonly ShiftableLocation[], days: number): ShiftableLocation[] {
  const shift = (value: string | null) => (value ? shiftCalendarDate(value, days) : null);
  return [...locations]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((location, position) => ({
      name: location.name,
      address: location.address,
      capacity: location.capacity,
      sortOrder: position,
      firstDay: shift(location.firstDay),
      lastDay: shift(location.lastDay),
      registrationClosesOn: shift(location.registrationClosesOn),
    }));
}

/** A location as staff and directors see it, dates always filled from the event's when unset. */
export type LocationSummary = {
  id: string;
  name: string;
  address: string | null;
  firstDay: string;
  lastDay: string;
};
