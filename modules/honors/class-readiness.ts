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

export type PersonClassReadiness = {
  attendeeId: string;
  name: string;
  missing: MissingClassChoice[];
  complete: boolean;
};

export type ClassReadiness = {
  people: PersonClassReadiness[];
  /** How many people still have a session without a choice. */
  incompleteCount: number;
  complete: boolean;
};

export function classChoiceReadiness(input: {
  attendees: readonly ReadinessAttendee[];
  sessions: ReadonlyArray<{ id: string; name: string }>;
  offerings: readonly ReadinessOffering[];
  /** Offering ids chosen, by attendee id. Pass the picker's unsaved choices to show them live. */
  selections: Readonly<Record<string, readonly string[]>>;
}): ClassReadiness {
  const byId = new Map(input.offerings.map((offering) => [offering.id, offering]));
  const people = input.attendees.map((attendee): PersonClassReadiness => {
    const chosen = (input.selections[attendee.id] ?? []).flatMap((id) => {
      const offering = byId.get(id);
      return offering ? [offering] : [];
    });
    const name = `${attendee.firstName} ${attendee.lastName}`.trim();
    // One class that fills every session finishes the whole weekend.
    if (chosen.some((offering) => offering.span === "ALL_SESSIONS")) {
      return { attendeeId: attendee.id, name, missing: [], complete: true };
    }
    const chosenSessions = new Set(chosen.map((offering) => offering.sessionId));
    const missing: MissingClassChoice[] = [];
    for (const session of input.sessions) {
      if (chosenSessions.has(session.id)) continue;
      // Only a session with a class this person could actually take is a choice they owe.
      const takeable = input.offerings.some((offering) => (
        offering.span === "SINGLE_SESSION"
        && offering.sessionId === session.id
        && unavailableReason(offering, false, attendee) === null
      ));
      if (takeable) missing.push({ sessionId: session.id, sessionName: session.name });
    }
    return { attendeeId: attendee.id, name, missing, complete: missing.length === 0 };
  });
  const incompleteCount = people.filter((person) => !person.complete).length;
  return { people, incompleteCount, complete: incompleteCount === 0 };
}

/** What is missing for one person, in words: "Still needs a class for Session 1 and Session 2." */
export function missingChoicesText(person: Pick<PersonClassReadiness, "missing">) {
  const names = person.missing.map((entry) => entry.sessionName);
  if (names.length === 0) return "";
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Still needs a class for ${list}.`;
}

/** The one-line summary for the registered club: "2 of 5 people still need class choices." */
export function readinessSummaryText(readiness: Pick<ClassReadiness, "incompleteCount" | "people">) {
  if (readiness.incompleteCount === 0) return "Everyone has their class choices.";
  const total = readiness.people.length;
  return `${readiness.incompleteCount} of ${total} ${total === 1 ? "person" : "people"} still ${readiness.incompleteCount === 1 ? "needs" : "need"} class choices.`;
}
