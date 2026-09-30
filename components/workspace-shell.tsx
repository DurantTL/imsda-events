import { Suspense } from "react";
import { ActAsBanner } from "@/components/act-as-banner";
import { AppShell } from "@/components/app-shell";
import { listActiveEventPermissionsForUser, listActiveEventRolesForUser } from "@/modules/access/membership-repository";
import { eventPermissions } from "@/modules/access/permissions";
import { findSwitchableAttendeeAccountForStaff } from "@/modules/attendee-accounts/current-attendee";
import { loadWorkspaceEventContext } from "@/modules/events/selection";
import { currentStaffActingContext } from "@/modules/organizations/staff-act-as";

/**
 * The staff workspace chrome (sidebar, header, act-as banner), shared by the
 * `(workspace)` layout and the staff-only `/profile` page (#623). `/profile`
 * passes `anyStaffWithoutEvents` so staff with no events still reach their profile
 * instead of being sent to /no-access.
 */
export async function WorkspaceShell({ anyStaffWithoutEvents = false, children }: { anyStaffWithoutEvents?: boolean; children: React.ReactNode }) {
  // Never redirects for event selection (#465): pages resolve their own
  // `?event=`; the layout only needs the default so the shell agrees with them.
  const { autoSelected, defaultEventId, events, user } = await loadWorkspaceEventContext({ anyStaffWithoutEvents });
  const isSystemAdmin = user.globalRole === "SYSTEM_ADMIN";
  const permissionsByEvent = isSystemAdmin
    ? new Map(events.map((event) => [event.id, [...eventPermissions]]))
    : await listActiveEventPermissionsForUser(user.id, events.map((event) => event.id));
  // Club oversight (#387, #428, #481): the same rule as resolveClubOversight —
  // an explicit CLUB-audience event, for its system admins or EVENT_ADMINs.
  // Audience, not billing mode, so an attendee-paid CLUB event still shows
  // club features, and a GENERAL event never does — even for a system admin.
  const rolesByEvent = isSystemAdmin ? new Map() : await listActiveEventRolesForUser(user.id, events.map((event) => event.id));
  const shellEvents = events.map((event) => ({
    id: event.id,
    slug: event.slug,
    name: event.name,
    permissions: permissionsByEvent.get(event.id) ?? [],
    clubOversight: event.audience === "CLUB"
      && (isSystemAdmin || rolesByEvent.get(event.id) === "EVENT_ADMIN"),
  }));
  const attendeeAccountAvailable = Boolean(
    await findSwitchableAttendeeAccountForStaff(user.email),
  );
  const acting = await currentStaffActingContext();

  return (
    <Suspense fallback={<div className="shell-loading">Loading IMSDA Events…</div>}>
      <ActAsBanner acting={acting} />
      <AppShell
        attendeeAccountAvailable={attendeeAccountAvailable}
        autoSelected={autoSelected}
        defaultEventId={defaultEventId}
        events={shellEvents}
        user={user}
      >
        {children}
      </AppShell>
    </Suspense>
  );
}
