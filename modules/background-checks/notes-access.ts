/**
 * Who may see the background-check list's issues text on screen (#427,
 * #544): system administrators only. Event workspace roles (event
 * administrators, finance, registration managers) keep the status view
 * without the text, and clubs never see it. Callers pass the result as
 * `includeNotes` to the loaders that can return it.
 */
export function canSeeIssuesText(user: { globalRole?: string | null } | null | undefined) {
  return user?.globalRole === "SYSTEM_ADMIN";
}
