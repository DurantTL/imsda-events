/**
 * Club director grants (#354): the rules, kept pure so every screen and every
 * later club slice (roster, registration, class selection) decides "does this
 * person direct this club right now?" the same way.
 */

export const clubDirectorRoleLabels = {
  DIRECTOR: "Director",
  DEPUTY: "Deputy",
  REGISTRAR: "Registrar",
  REPORTER: "Reporter",
} as const;

export type ClubRole = keyof typeof clubDirectorRoleLabels;

export const clubRoleDescriptions: Record<ClubRole, string> = {
  DIRECTOR: "Runs the club: roster, events, team, and club profile.",
  DEPUTY: "Same access as the director.",
  REGISTRAR: "Keeps the roster and registers the club for events. Sees ages, not full birth dates.",
  REPORTER: "Submits the club's monthly reports. No roster access.",
};

/**
 * What each club role may do (#375). One table so every page and route asks
 * the same question. Full birth dates stay with directors and deputies
 * (ADR 0005 Addendum A); a registrar can type one in but sees ages only.
 */
export type ClubCapabilities = {
  roster: boolean;
  registerForEvents: boolean;
  seeBirthDates: boolean;
  manageTeam: boolean;
  editProfile: boolean;
  submitReports: boolean;
};

const leader: ClubCapabilities = {
  roster: true, registerForEvents: true, seeBirthDates: true, manageTeam: true, editProfile: true, submitReports: true,
};

const capabilitiesByRole: Record<ClubRole, ClubCapabilities> = {
  DIRECTOR: leader,
  DEPUTY: leader,
  REGISTRAR: {
    roster: true, registerForEvents: true, seeBirthDates: false, manageTeam: false, editProfile: false, submitReports: false,
  },
  REPORTER: {
    roster: false, registerForEvents: false, seeBirthDates: false, manageTeam: false, editProfile: false, submitReports: true,
  },
};

export function clubCapabilities(role: ClubRole): ClubCapabilities {
  return capabilitiesByRole[role];
}

/** Roles a club's own director or deputy may give or take away. Conference staff may give any role. */
export const clubAssignableRoles = ["REGISTRAR", "REPORTER"] as const satisfies readonly ClubRole[];

export function clubRoleIsAssignableByClub(role: ClubRole) {
  return (clubAssignableRoles as readonly ClubRole[]).includes(role);
}

export type DirectorGrantStatus = "SCHEDULED" | "ACTIVE" | "ENDED" | "REVOKED";

export const directorGrantStatusLabels: Record<DirectorGrantStatus, string> = {
  SCHEDULED: "Starts later",
  ACTIVE: "Active",
  ENDED: "Ended",
  REVOKED: "Revoked",
};

export type DirectorGrantWindow = {
  effectiveFrom: Date;
  effectiveTo: Date | null;
  revokedAt: Date | null;
};

/** Revocation wins over dates; the window is [effectiveFrom, effectiveTo). */
export function directorGrantStatus(grant: DirectorGrantWindow, now: Date): DirectorGrantStatus {
  if (grant.revokedAt) return "REVOKED";
  if (grant.effectiveFrom > now) return "SCHEDULED";
  if (grant.effectiveTo && grant.effectiveTo <= now) return "ENDED";
  return "ACTIVE";
}

export function directorGrantIsActive(grant: DirectorGrantWindow, now: Date) {
  return directorGrantStatus(grant, now) === "ACTIVE";
}

/**
 * Two unrevoked grants for the same person and club may not overlap: one
 * person, one club, one authority at a time. A missing end is open-ended.
 */
export function directorGrantWindowsOverlap(
  a: Pick<DirectorGrantWindow, "effectiveFrom" | "effectiveTo">,
  b: Pick<DirectorGrantWindow, "effectiveFrom" | "effectiveTo">,
) {
  const aEndsAfterBStarts = a.effectiveTo === null || a.effectiveTo > b.effectiveFrom;
  const bEndsAfterAStarts = b.effectiveTo === null || b.effectiveTo > a.effectiveFrom;
  return aEndsAfterBStarts && bEndsAfterAStarts;
}
