import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { listActiveEventPermissionsForUser } from "@/modules/access/membership-repository";
import { eventPermissions } from "@/modules/access/permissions";
import { findSwitchableAttendeeAccountForStaff } from "@/modules/attendee-accounts/current-attendee";
import { resolveEventContext } from "@/modules/events/selection";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { events, user } = await resolveEventContext();
  const permissionsByEvent = user.globalRole === "SYSTEM_ADMIN"
    ? new Map(events.map((event) => [event.id, [...eventPermissions]]))
    : await listActiveEventPermissionsForUser(user.id, events.map((event) => event.id));
  const shellEvents = events.map((event) => ({
    id: event.id,
    slug: event.slug,
    name: event.name,
    permissions: permissionsByEvent.get(event.id) ?? [],
  }));
  const attendeeAccountAvailable = Boolean(
    await findSwitchableAttendeeAccountForStaff(user.email),
  );

  return (
    <Suspense fallback={<div className="shell-loading">Loading IMSDA Events…</div>}>
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
