import { Suspense } from "react";
import { ActAsBanner } from "@/components/act-as-banner";
import { AppShell } from "@/components/app-shell";
import { listActiveEventPermissionsForUser, listActiveEventRolesForUser } from "@/modules/access/membership-repository";
import { eventPermissions } from "@/modules/access/permissions";
import { findSwitchableAttendeeAccountForStaff } from "@/modules/attendee-accounts/current-attendee";
import { resolveEventContext } from "@/modules/events/selection";
import { currentStaffActingContext } from "@/modules/organizations/staff-act-as";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { events, user } = await resolveEventContext();
  const isSystemAdmin = user.globalRole === "SYSTEM_ADMIN";
  const permissionsByEvent = isSystemAdmin
    ? new Map(events.map((event) => [event.id, [...eventPermissions]]))
    : await listActiveEventPermissionsForUser(user.id, events.map((event) => event.id));
  // Club oversight (#387, #428): the same rule as resolveClubOversight — a
  // Pathfinder event billed to clubs, for its system admins or EVENT_ADMINs.
  const rolesByEvent = isSystemAdmin ? new Map() : await listActiveEventRolesForUser(user.id, events.map((event) => event.id));
  const shellEvents = events.map((event) => ({
    id: event.id,
    slug: event.slug,
    name: event.name,
    permissions: permissionsByEvent.get(event.id) ?? [],
    clubOversight: event.billingMode === "DEFERRED_ORGANIZATION_INVOICE"
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
        events={shellEvents}
        user={user}
      >
        {children}
      </AppShell>
    </Suspense>
  );
}
