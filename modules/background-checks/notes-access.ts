/**
 * Who may see the Sterling Volunteers list's issues text (the "note") on
 * screen (#427, #544, #443). The note is personal data, so every screen
 * decides from who is asking and passes the result as `includeNotes` to the
 * loaders that can return it:
 *
 * - system administrators, on any page (`canSeeIssuesText`);
 * - an Area Coordinator, for a club in their scope only
 *   (`canSeeIssuesTextForAreaClub`, the same scope as their other club views:
 *   an active club);
 * - nobody else. Event workspace roles (event administrators, finance,
 *   registration managers) keep the status view without the text, and a club
 *   director or deputy never sees it.
 */
export function canSeeIssuesText(user: { globalRole?: string | null } | null | undefined) {
  return user?.globalRole === "SYSTEM_ADMIN";
}

/**
 * An Area Coordinator's scope is every active club (`listClubsForArea`); the
 * Area Coordinator club pages 404 on anything else.
 */
export function clubInAreaCoordinatorScope(club: { type?: string | null; isActive?: boolean | null } | null | undefined) {
  return Boolean(club && club.type === "CLUB" && club.isActive === true);
}

/**
 * The full note for one club's adults, for an Area Coordinator (#443).
 * `areaCoordinatorActive` must come from the server-side viewer check
 * (`currentAreaCoordinatorViewerActive`), never from the request.
 */
export function canSeeIssuesTextForAreaClub(
  viewer: { areaCoordinatorActive: boolean } | null | undefined,
  club: { type?: string | null; isActive?: boolean | null } | null | undefined,
) {
  return viewer?.areaCoordinatorActive === true && clubInAreaCoordinatorScope(club);
}
