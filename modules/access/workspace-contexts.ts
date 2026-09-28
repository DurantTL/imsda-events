/**
 * The multi-context workspace switcher (#108): a signed-in identity may hold
 * more than one context — a staff `User` account (with event memberships and,
 * for system administrators, the whole system) and, separately, an
 * `AttendeeAccount` reached by the existing staff-to-attendee handoff
 * (`modules/attendee-accounts/current-attendee.ts`). The two session models
 * stay separate (ADR 0003); this only decides which *other* workspaces the
 * identity currently in front of us is allowed to switch into, so the UI can
 * list permitted options only and never ask anyone to choose a role they do
 * not hold.
 *
 * Pure and side-effect-free on purpose, like `login-routing.ts`: callers
 * gather what already exists elsewhere (`findSwitchableAttendeeAccountForStaff`,
 * the signed-in staff session, `currentStaffActingContext`) and pass in
 * booleans/ids; the decision of what to show is unit-testable without a
 * database, cookies, or React.
 */

export type WorkspaceContext = {
  /** Stable, machine-readable kind — never rendered directly. */
  kind: "system_admin" | "attendee" | "staff_workspace";
  href: string;
  label: string;
};

const SYSTEM_ADMIN_CONTEXT: WorkspaceContext = {
  kind: "system_admin",
  href: "/admin",
  label: "System management",
};

const ATTENDEE_CONTEXT: WorkspaceContext = {
  kind: "attendee",
  href: "/account",
  label: "My registrations",
};

const STAFF_WORKSPACE_CONTEXT: WorkspaceContext = {
  kind: "staff_workspace",
  href: "/overview",
  label: "Staff workspace",
};

/**
 * The other workspaces a signed-in **staff** identity may switch into: system
 * management, when the account is a system administrator, and the matching
 * attendee account, when one exists for the staff email (the existing
 * staff-to-attendee handoff). Neither is offered unless the account actually
 * has it — a staff member with no matching attendee account never sees an
 * attendee option, and a non-admin never sees system management.
 *
 * The account's own event workspaces are deliberately not repeated here: the
 * sidebar's event picker (`components/app-shell.tsx`) already lists exactly
 * the account's own active events, sourced the same way `resolveLoginDestination`
 * is (`modules/events/repository.ts`), so this only adds the contexts that
 * picker does not cover.
 */
export function otherWorkspaceContextsForStaff(input: {
  isSystemAdmin: boolean;
  attendeeAccountAvailable: boolean;
}): WorkspaceContext[] {
  const contexts: WorkspaceContext[] = [];
  if (input.isSystemAdmin) contexts.push(SYSTEM_ADMIN_CONTEXT);
  if (input.attendeeAccountAvailable) contexts.push(ATTENDEE_CONTEXT);
  return contexts;
}

/**
 * The other workspace a signed-in **attendee** identity may switch into: the
 * staff workspace, only when this browser also carries a live staff session
 * (the reverse of the handoff above). An attendee with no staff session never
 * sees a staff option — there is nothing to ask a role for, only what is
 * already true of the two sessions on this browser.
 */
export function otherWorkspaceContextsForAttendee(input: {
  hasStaffSession: boolean;
}): WorkspaceContext[] {
  return input.hasStaffSession ? [STAFF_WORKSPACE_CONTEXT] : [];
}
