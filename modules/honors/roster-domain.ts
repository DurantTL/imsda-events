import { toCsv } from "@/modules/reporting/csv";

/**
 * Honors Weekend rosters (#360): per class, per site, and per club. Pure
 * layout of records the repository has already loaded. Ages are on the event
 * date; birth dates never reach this module.
 */

export type RosterGroup = "YOUTH" | "STAFF" | "ADULT";

export const rosterGroupLabels: Record<RosterGroup, string> = { YOUTH: "Youth", STAFF: "Staff", ADULT: "Adult" };

/**
 * Anyone not staff or adult is listed with the youth, underage included. This
 * is independent of who takes a class seat (underage attendees don't, #462).
 */
export function rosterGroupOf(attendeeType: string | null | undefined): RosterGroup {
  if (attendeeType === "STAFF") return "STAFF";
  if (attendeeType === "ADULT") return "ADULT";
  return "YOUTH";
}

export type RosterAttendee = {
  id: string;
  firstName: string;
  lastName: string;
  clubId: string;
  clubName: string;
  ageOnEventDate: number | null;
  attendeeType: string | null;
  checkedIn: boolean;
  /** Only filled when the viewer may see sensitive answers. */
  dietary: string | null;
};

export type RosterSession = { id: string; name: string; sortOrder: number };

export type RosterOffering = {
  id: string;
  honorName: string;
  honorCode: string;
  span: "SINGLE_SESSION" | "ALL_SESSIONS";
  sessionId: string | null;
  capacity: number;
  teacherName: string;
  location: string;
  isActive: boolean;
};

export type RosterEnrollment = { offeringId: string; attendeeId: string; consumesSeat: boolean };

function byName(a: { lastName: string; firstName: string }, b: { lastName: string; firstName: string }) {
  return a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);
}

export function sessionLabel(offering: RosterOffering, sessions: readonly RosterSession[]) {
  if (offering.span === "ALL_SESSIONS") return "All sessions";
  return sessions.find((session) => session.id === offering.sessionId)?.name ?? "Session";
}

export function buildClassRosters(
  sessions: readonly RosterSession[],
  offerings: readonly RosterOffering[],
  enrollments: readonly RosterEnrollment[],
  attendees: readonly RosterAttendee[],
) {
  const attendeesById = new Map(attendees.map((attendee) => [attendee.id, attendee]));
  const order = new Map(sessions.map((session) => [session.id, session.sortOrder]));
  const sortKey = (offering: RosterOffering) => (offering.span === "ALL_SESSIONS" ? -1 : order.get(offering.sessionId ?? "") ?? 999);
  return [...offerings]
    .sort((a, b) => sortKey(a) - sortKey(b) || a.honorName.localeCompare(b.honorName))
    .map((offering) => {
      const rows = enrollments.filter((enrollment) => enrollment.offeringId === offering.id);
      const people = rows
        .map((row) => attendeesById.get(row.attendeeId))
        .filter((attendee): attendee is RosterAttendee => Boolean(attendee))
        .sort(byName);
      return {
        offering,
        session: sessionLabel(offering, sessions),
        people,
        // Counted from the enrollment rows, exactly as H5 counts taken seats.
        youthSeats: rows.filter((row) => row.consumesSeat).length,
      };
    });
}

export type ClassRoster = ReturnType<typeof buildClassRosters>[number];

export function buildSiteRoster(attendees: readonly RosterAttendee[]) {
  const people = [...attendees].sort((a, b) => a.clubName.localeCompare(b.clubName) || byName(a, b));
  const totals = { YOUTH: 0, STAFF: 0, ADULT: 0 } satisfies Record<RosterGroup, number>;
  const clubs = new Map<string, { clubName: string; YOUTH: number; STAFF: number; ADULT: number }>();
  for (const person of people) {
    const group = rosterGroupOf(person.attendeeType);
    totals[group] += 1;
    const club = clubs.get(person.clubId) ?? { clubName: person.clubName, YOUTH: 0, STAFF: 0, ADULT: 0 };
    club[group] += 1;
    clubs.set(person.clubId, club);
  }
  return { people, totals: { ...totals, total: people.length }, clubs: [...clubs.values()] };
}

export function buildClubSchedule(
  clubId: string,
  sessions: readonly RosterSession[],
  offerings: readonly RosterOffering[],
  enrollments: readonly RosterEnrollment[],
  attendees: readonly RosterAttendee[],
) {
  const offeringsById = new Map(offerings.map((offering) => [offering.id, offering]));
  const orderedSessions = [...sessions].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const people = attendees.filter((attendee) => attendee.clubId === clubId).sort(byName);
  return {
    sessions: orderedSessions,
    people: people.map((person) => {
      const classes = enrollments
        .filter((enrollment) => enrollment.attendeeId === person.id)
        .map((enrollment) => offeringsById.get(enrollment.offeringId))
        .filter((offering): offering is RosterOffering => Boolean(offering));
      const allSessions = classes.find((offering) => offering.span === "ALL_SESSIONS") ?? null;
      const bySession: Record<string, RosterOffering | null> = {};
      for (const session of orderedSessions) {
        bySession[session.id] = allSessions ?? classes.find((offering) => offering.sessionId === session.id) ?? null;
      }
      return { person, bySession, classCount: classes.length };
    }),
  };
}

export type ClubSchedule = ReturnType<typeof buildClubSchedule>;

const age = (value: number | null) => (value === null ? "" : value);

function classPlace(offering: RosterOffering) {
  return [offering.location, offering.teacherName].filter(Boolean).join(" · ");
}

export function classRostersCsv(rosters: readonly ClassRoster[]) {
  const rows: Array<Array<string | number>> = [[
    "Session", "Honor code", "Honor", "Location", "Teacher", "Youth seats", "Capacity",
    "Last name", "First name", "Club", "Age at event", "Type",
  ]];
  for (const roster of rosters) {
    const head = [roster.session, roster.offering.honorCode, roster.offering.honorName, roster.offering.location, roster.offering.teacherName, roster.youthSeats, roster.offering.capacity];
    if (roster.people.length === 0) rows.push([...head, "", "", "", "", ""]);
    for (const person of roster.people) {
      rows.push([...head, person.lastName, person.firstName, person.clubName, age(person.ageOnEventDate), rosterGroupLabels[rosterGroupOf(person.attendeeType)]]);
    }
  }
  return toCsv(rows);
}

export function siteRosterCsv(site: ReturnType<typeof buildSiteRoster>, includeDietary: boolean) {
  const rows: Array<Array<string | number>> = [[
    "Club", "Last name", "First name", "Age at event", "Type", "Checked in",
    ...(includeDietary ? ["Dietary notes"] : []),
  ]];
  for (const person of site.people) {
    rows.push([
      person.clubName, person.lastName, person.firstName, age(person.ageOnEventDate),
      rosterGroupLabels[rosterGroupOf(person.attendeeType)], person.checkedIn ? "Yes" : "",
      ...(includeDietary ? [person.dietary ?? ""] : []),
    ]);
  }
  return toCsv(rows);
}

export function clubScheduleCsv(schedule: ClubSchedule) {
  const rows: Array<Array<string | number>> = [[
    "Last name", "First name", "Age at event", "Type", ...schedule.sessions.map((session) => session.name),
  ]];
  for (const row of schedule.people) {
    rows.push([
      row.person.lastName, row.person.firstName, age(row.person.ageOnEventDate),
      rosterGroupLabels[rosterGroupOf(row.person.attendeeType)],
      ...schedule.sessions.map((session) => {
        const offering = row.bySession[session.id];
        return offering ? [offering.honorName, classPlace(offering)].filter(Boolean).join(" — ") : "";
      }),
    ]);
  }
  return toCsv(rows);
}

/** A dietary answer is any attendee field about food or allergies; the text is kept short for print. */
export const dietaryFieldPattern = /\b(?:diet\w*|food|allerg\w*|vegan|vegetarian|gluten)\b/i;
