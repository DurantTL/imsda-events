/**
 * Club director grants (#354): the rules, kept pure so every screen and every
 * later club slice (roster, registration, class selection) decides "does this
 * person direct this club right now?" the same way.
 */

export const clubDirectorRoleLabels = {
  DIRECTOR: "Director",
  DEPUTY: "Deputy",
} as const;

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
