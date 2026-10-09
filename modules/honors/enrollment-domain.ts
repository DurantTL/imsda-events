/**
 * Honors Weekend class selection (#359). Pure rules the server enforces
 * inside the enrollment transaction; the director's screen only mirrors them.
 */

import { clubClassLevelLabels, clubClassLevels, type ClubClassLevel } from "@/modules/club-rosters/domain";

export type SelectableOffering = {
  id: string;
  honorName: string;
  span: "SINGLE_SESSION" | "ALL_SESSIONS";
  sessionId: string | null;
  minimumAge: number | null;
  /** The lowest class level a youth may take this class at (#832); null or absent: none. */
  minimumClassLevel?: ClubClassLevel | null;
  /** Honors a youth must have completed first (#832); every one is required. */
  prerequisiteHonors?: ReadonlyArray<{ id: string; name: string }>;
  isActive: boolean;
};

export type SelectingAttendee = {
  ageOnEventDate: number | null;
  /** Staff, adults and underage children take no seat and have no class level or honor prerequisites (#832). Absent means a youth. */
  consumesSeat?: boolean;
  /** The member's current class level on the club roster (#832); null when none is set or the person isn't on a roster. */
  classLevel?: ClubClassLevel | null;
  /** Prerequisite honors the member's honor record shows completed (#832). */
  completedHonorIds?: readonly string[];
};

/**
 * How the person is allowed past a class's level or prerequisite honors (#832),
 * for one class. `confirmed`: the director ticked "they meet it" (only for a
 * level that is missing, or a prerequisite honor with no completed record).
 * `overrides`: staff placed them anyway, with a reason (also for a level known
 * to be too low). Keyed by class id.
 */
export type RequirementWaivers = {
  confirmed?: ReadonlySet<string>;
  overrides?: ReadonlyMap<string, string>;
};

export type RequirementGap = {
  kind: "LEVEL_BELOW" | "LEVEL_MISSING" | "HONORS_MISSING";
  /** What the class asks for, in words: "class level Guide or higher" / "Birds completed". */
  requirement: string;
  /** Whether a director can confirm it; a level known to be too low can only be overridden by staff. */
  confirmable: boolean;
  /** The full sentence the server refuses with, naming the class. */
  message: string;
  /** The short reason shown beside a class in the picker. */
  shortReason: string;
};

function levelIndex(level: ClubClassLevel) {
  return clubClassLevels.indexOf(level);
}

/** Whether a class has any level or prerequisite requirement (#832). */
export function hasClassRequirements(offering: Pick<SelectableOffering, "minimumClassLevel" | "prerequisiteHonors">) {
  return (offering.minimumClassLevel ?? null) !== null || (offering.prerequisiteHonors?.length ?? 0) > 0;
}

/**
 * The level and prerequisite-honor rules this person doesn't clearly meet for
 * this class (#832): none for staff, adults and underage children, who take no
 * seat. The source of truth is the director-set class level on the club roster
 * and the member's honor record. A level that is missing, or a prerequisite
 * honor with no completed record, can be confirmed by the director; a level
 * known to be below the minimum can only be overridden by staff.
 */
export function requirementGaps(
  attendee: Pick<SelectingAttendee, "consumesSeat" | "classLevel" | "completedHonorIds">,
  offering: Pick<SelectableOffering, "honorName" | "minimumClassLevel" | "prerequisiteHonors">,
): RequirementGap[] {
  if (attendee.consumesSeat === false) return [];
  const gaps: RequirementGap[] = [];
  const minimum = offering.minimumClassLevel ?? null;
  if (minimum !== null) {
    const label = clubClassLevelLabels[minimum];
    const requirement = `class level ${label} or higher`;
    const level = attendee.classLevel ?? null;
    if (level === null) {
      gaps.push({
        kind: "LEVEL_MISSING",
        requirement,
        confirmable: true,
        message: `${offering.honorName} is for ${requirement}, and this person's class level isn't on the roster. Set it on the roster, or confirm they meet it.`,
        shortReason: `${label}+ (level not on roster)`,
      });
    } else if (levelIndex(level) < levelIndex(minimum)) {
      gaps.push({
        kind: "LEVEL_BELOW",
        requirement,
        confirmable: false,
        message: `${offering.honorName} is for ${requirement}, and this person is ${clubClassLevelLabels[level]}.`,
        shortReason: `${label}+ (this person is ${clubClassLevelLabels[level]})`,
      });
    }
  }
  const done = new Set(attendee.completedHonorIds ?? []);
  const missing = (offering.prerequisiteHonors ?? []).filter((honor) => !done.has(honor.id));
  if (missing.length > 0) {
    const names = missing.map((honor) => honor.name).join(", ");
    gaps.push({
      kind: "HONORS_MISSING",
      requirement: `${names} completed`,
      confirmable: true,
      message: `${offering.honorName} needs ${names} completed first, and no completed record was found. Confirm they have completed ${missing.length === 1 ? "it" : "them"}, or add the honor record.`,
      shortReason: `needs ${names} first`,
    });
  }
  return gaps;
}

/**
 * The outcome of the requirement rules for one person in one class (#832):
 * `problem` is the first rule not met and not waived; the other fields say how
 * the rest were waived, which is what gets recorded on the enrollment.
 */
export function requirementResolution(
  attendee: Pick<SelectingAttendee, "consumesSeat" | "classLevel" | "completedHonorIds">,
  offering: Pick<SelectableOffering, "id" | "honorName" | "minimumClassLevel" | "prerequisiteHonors">,
  waivers: RequirementWaivers = {},
) {
  const overrideReason = waivers.overrides?.get(offering.id)?.trim() || null;
  const confirmed = waivers.confirmed?.has(offering.id) ?? false;
  let problem: string | null = null;
  let levelConfirmed = false;
  let prerequisitesConfirmed = false;
  let overridden = false;
  for (const gap of requirementGaps(attendee, offering)) {
    if (gap.confirmable && confirmed) {
      if (gap.kind === "HONORS_MISSING") prerequisitesConfirmed = true;
      else levelConfirmed = true;
    } else if (overrideReason) {
      overridden = true;
    } else if (!problem) {
      problem = gap.message;
    }
  }
  return { problem, levelConfirmed, prerequisitesConfirmed, overrideReason: overridden ? overrideReason : null };
}

/**
 * Only youth use a class seat or count toward a club's limit. Staff, adults,
 * and underage attendees join freely (underage: decision 2026-09-26, #462,
 * matching 2026 practice). Saved on each enrollment when it's made.
 */
export function consumesClassSeat(attendeeType: string | null | undefined) {
  return attendeeType !== "STAFF" && attendeeType !== "ADULT" && attendeeType !== "UNDERAGE";
}

/**
 * Why this set of classes isn't allowed for this person, or null. At most one
 * class per session; an all-sessions class must be the only one; the person
 * must be old enough on the event date, and meet the class's minimum class level and prerequisite honors (#832) unless the director confirmed it or staff overrode it. `alreadyEnrolled` lets someone keep a
 * class staff have since deactivated, but never join one.
 */
export function selectionProblem(
  attendee: SelectingAttendee,
  offeringIds: readonly string[],
  offerings: ReadonlyMap<string, SelectableOffering>,
  alreadyEnrolled: ReadonlySet<string> = new Set(),
  waivers: RequirementWaivers = {},
) {
  if (new Set(offeringIds).size !== offeringIds.length) return "The same class was chosen twice.";
  const chosen: SelectableOffering[] = [];
  for (const id of offeringIds) {
    const offering = offerings.get(id);
    if (!offering) return "One of the chosen classes isn't offered at this site.";
    if (!offering.isActive && !alreadyEnrolled.has(id)) return `${offering.honorName} is no longer offered.`;
    chosen.push(offering);
  }
  const allSessions = chosen.filter((offering) => offering.span === "ALL_SESSIONS");
  if (allSessions.length > 0 && chosen.length > 1) {
    return `${allSessions[0].honorName} fills every session, so it has to be the only class.`;
  }
  const sessions = new Set<string>();
  for (const offering of chosen) {
    if (offering.span !== "SINGLE_SESSION" || !offering.sessionId) continue;
    if (sessions.has(offering.sessionId)) return "Choose at most one class per session.";
    sessions.add(offering.sessionId);
  }
  for (const offering of chosen) {
    if (offering.minimumAge === null || alreadyEnrolled.has(offering.id)) continue;
    if (attendee.ageOnEventDate === null) return `${offering.honorName} has a minimum age, and this person's age isn't on the roster.`;
    if (attendee.ageOnEventDate < offering.minimumAge) {
      return `${offering.honorName} is for ages ${offering.minimumAge} and up.`;
    }
  }
  // A class the person already holds is never re-checked, like the minimum age above (#832).
  for (const offering of chosen) {
    if (alreadyEnrolled.has(offering.id)) continue;
    const { problem } = requirementResolution(attendee, offering, waivers);
    if (problem) return problem;
  }
  return null;
}
