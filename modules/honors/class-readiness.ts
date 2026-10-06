/**
 * Is each person's class choice finished? (#799 G3)
 *
 * A registered club member is not "complete" until every session that has a
 * class they can take has a choice: one class in that session, or one class
 * that fills every session. A session with no class open to them (full,
 * too young, no longer offered) asks nothing of them. Pure and shared by the
 * class picker and the registered-club summary, so both say the same thing.
 * The server's save rules are unchanged; this only reports what is missing.
 */
import { unavailableReason } from "@/modules/honors/class-picker-view";
import { consumesClassSeat } from "@/modules/honors/enrollment-domain";

/** Any offering the class pickers show: the club view with seat counts, or the public view with only availability. */
type ReadinessOffering = Parameters<typeof unavailableReason>[0] & {
  id: string;
  honorName: string;
  span: "SINGLE_SESSION" | "ALL_SESSIONS";
  sessionId: string | null;
};

type ReadinessAttendee = {
  id: string;
  firstName: string;
  lastName: string;
  attendeeType: string | null;
  consumesSeat: boolean;
  ageOnEventDate: number | null;
};

export type MissingClassChoice = { sessionId: string; sessionName: string };

/**
 * Who owes a class choice. One policy in one place. Until the event team
 * decides otherwise, only youth members do: staff, adults and underage
 * children may pick classes but are shown as "Optional", never incomplete.
 */
export function requiresClassChoice(person: { attendeeType: string | null }) {
  return consumesClassSeat(person.attendeeType);
}

export type PersonClassReadiness = {
  attendeeId: string;
  name: string;
  /** Whether this person owes a choice at all (`requiresClassChoice`). */
  required: boolean;
  /** Sessions (or the whole weekend) still without a class they could take. */
  missing: MissingClassChoice[];
  /** Sessions with classes, none of which this person can take, and no pick. */
  noClassAvailable: MissingClassChoice[];
  /** Holds at least one class. */
  hasPicks: boolean;
  /** Nothing is owed: a required person with every choice made, or anyone not required. */
  complete: boolean;
};

export type ClassReadiness = {
  people: PersonClassReadiness[];
  /** How many required people still owe a choice. */
  incompleteCount: number;
  complete: boolean;
};

export const ALL_SESSIONS_MISSING: MissingClassChoice = { sessionId: "all-sessions", sessionName: "the whole weekend" };

export function classChoiceReadiness(input: {
  attendees: readonly ReadinessAttendee[];
  sessions: ReadonlyArray<{ id: string; name: string }>;
  offerings: readonly ReadinessOffering[];
  /** Offering ids chosen, by attendee id. Pass the picker's unsaved choices to show them live. */
  selections: Readonly<Record<string, readonly string[]>>;
  /** Offering ids already saved, so a seat the person holds still counts as open to them. */
  saved?: Readonly<Record<string, readonly string[]>>;
}): ClassReadiness {
  const byId = new Map(input.offerings.map((offering) => [offering.id, offering]));
  const people = input.attendees.map((attendee): PersonClassReadiness => {
    const chosen = (input.selections[attendee.id] ?? []).flatMap((id) => {
      const offering = byId.get(id);
      return offering ? [offering] : [];
    });
    const savedIds = new Set(input.saved?.[attendee.id] ?? []);
    const open = (offering: ReadinessOffering) => unavailableReason(offering, savedIds.has(offering.id), attendee) === null;
    const name = `${attendee.firstName} ${attendee.lastName}`.trim();
    const required = requiresClassChoice(attendee);
    const hasPicks = chosen.length > 0;
    const base = { attendeeId: attendee.id, name, required, hasPicks };
    // One class that fills every session finishes the whole weekend.
    if (chosen.some((offering) => offering.span === "ALL_SESSIONS")) {
      return { ...base, missing: [], noClassAvailable: [], complete: true };
    }
    const chosenSessions = new Set(chosen.map((offering) => offering.sessionId));
    const missing: MissingClassChoice[] = [];
    const noClassAvailable: MissingClassChoice[] = [];
    for (const session of input.sessions) {
      if (chosenSessions.has(session.id)) continue;
      const inSession = input.offerings.filter((offering) => offering.span === "SINGLE_SESSION" && offering.sessionId === session.id);
      if (inSession.length === 0) continue;
      if (inSession.some(open)) missing.push({ sessionId: session.id, sessionName: session.name });
      else noClassAvailable.push({ sessionId: session.id, sessionName: session.name });
    }
    // An event with only all-sessions classes: a person with no pick still owes one.
    if (!hasPicks && missing.length === 0 && input.offerings.some((offering) => offering.span === "ALL_SESSIONS" && open(offering))) {
      missing.push(ALL_SESSIONS_MISSING);
    }
    return { ...base, missing, noClassAvailable, complete: !required || missing.length === 0 };
  });
  const incompleteCount = people.filter((person) => !person.complete).length;
  return { people, incompleteCount, complete: incompleteCount === 0 };
}

function joinNames(names: readonly string[]) {
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What is missing for one person, in words: "Still needs a class for Session 1 and Session 2." */
export function missingChoicesText(person: Pick<PersonClassReadiness, "missing">) {
  if (person.missing.length === 0) return "";
  return `Still needs a class for ${joinNames(person.missing.map((entry) => entry.sessionName))}.`;
}

/** The neutral third state: "No class available for Session 1." Empty when every session has something open. */
export function noClassAvailableText(person: Pick<PersonClassReadiness, "noClassAvailable">) {
  if (person.noClassAvailable.length === 0) return "";
  return `No class available for ${joinNames(person.noClassAvailable.map((entry) => entry.sessionName))}.`;
}

/** The one-line summary for the registered club: "2 of 5 people still need class choices." */
export function readinessSummaryText(readiness: Pick<ClassReadiness, "incompleteCount" | "people">) {
  if (readiness.incompleteCount === 0) return "Everyone has their class choices.";
  const total = readiness.people.length;
  return `${readiness.incompleteCount} of ${total} ${total === 1 ? "person" : "people"} still ${readiness.incompleteCount === 1 ? "needs" : "need"} class choices.`;
}

/** Which badge a person gets (#799 G3): never "done" for someone with a missing choice. */
export type ClassBadge = "needs" | "chosen" | "optional" | "none-available";

export function classBadge(person: PersonClassReadiness): ClassBadge {
  if (person.required && person.missing.length > 0) return "needs";
  if (person.hasPicks && person.missing.length === 0) return "chosen";
  if (!person.required) return "optional";
  return "none-available";
}
