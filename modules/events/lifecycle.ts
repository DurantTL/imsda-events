export const activeRegistrationStatuses = ["SUBMITTED", "CONFIRMED"] as const;

export type ActiveRegistrationStatus = typeof activeRegistrationStatuses[number];
export type EventRegistrationPhase = "DRAFT" | "UPCOMING" | "OPEN" | "CLOSED";
export type CapacityDecision = "REGISTER" | "WAITLIST" | "FULL";
export type EventRegistrationAdmission = {
  phase: EventRegistrationPhase;
  capacityDecision: CapacityDecision | null;
  remainingSpots: number | null;
};

export type EventLifecycleSource = {
  isPublished: boolean;
  timezone: string;
  registrationOpensOn: string | null;
  registrationClosesOn: string | null;
  waitlistEnabled: boolean;
  /**
   * The event's last instant. When present, public registration also closes
   * once the event's last calendar day (in its own time zone) has passed (#575),
   * regardless of the registration-window settings.
   */
  endsAt?: Date | null;
  /**
   * A last calendar day (`YYYY-MM-DD`, in the event's time zone) that takes
   * the place of `endsAt`. A location of a multi-location event (#413) sets it
   * from its own last day, so that location closes on its own schedule.
   */
  lastDay?: string | null;
};

export type EventAdmissionSource = EventLifecycleSource & {
  capacity: number | null;
};

export function calendarDateInEventTimeZone(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(date);
}

/** True once the event's last calendar day has passed in its own time zone. */
export function hasEventEnded(
  event: Pick<EventLifecycleSource, "timezone" | "endsAt" | "lastDay">,
  now = new Date(),
) {
  if (event.lastDay) return calendarDateInEventTimeZone(now, event.timezone) > event.lastDay;
  if (!event.endsAt) return false;
  return calendarDateInEventTimeZone(now, event.timezone)
    > calendarDateInEventTimeZone(event.endsAt, event.timezone);
}

export const registrationClosedMessage = "Registration for this event has closed.";

export function evaluateEventRegistrationPhase(
  event: EventLifecycleSource,
  now = new Date(),
): EventRegistrationPhase {
  if (!event.isPublished) return "DRAFT";
  if (hasEventEnded(event, now)) return "CLOSED";
  const today = calendarDateInEventTimeZone(now, event.timezone);
  if (event.registrationOpensOn && today < event.registrationOpensOn) return "UPCOMING";
  if (event.registrationClosesOn && today > event.registrationClosesOn) return "CLOSED";
  return "OPEN";
}

export function decideEventCapacity(input: {
  capacity: number | null;
  occupied: number;
  requested: number;
  waitlistEnabled: boolean;
}): CapacityDecision {
  if (input.capacity === null || input.occupied + input.requested <= input.capacity) {
    return "REGISTER";
  }
  return input.waitlistEnabled ? "WAITLIST" : "FULL";
}

export function remainingEventCapacity(capacity: number | null, occupied: number) {
  return capacity === null ? null : Math.max(0, capacity - occupied);
}

export function evaluateEventRegistrationAdmission(
  event: EventAdmissionSource,
  input: { occupied: number; requested: number },
  now = new Date(),
): EventRegistrationAdmission {
  const phase = evaluateEventRegistrationPhase(event, now);
  return {
    phase,
    capacityDecision: phase === "OPEN"
      ? decideEventCapacity({
          capacity: event.capacity,
          occupied: input.occupied,
          requested: input.requested,
          waitlistEnabled: event.waitlistEnabled,
        })
      : null,
    remainingSpots: remainingEventCapacity(event.capacity, input.occupied),
  };
}

export function waitlistStatusLabel(phase: EventRegistrationPhase) {
  if (phase === "DRAFT") return "Not published";
  if (phase === "UPCOMING") return "Opens soon";
  if (phase === "CLOSED") return "Registration closed";
  return "Registration open";
}
