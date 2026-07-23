import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { StaffWorkspace } from "@/components/staff-workspace";
import { listStaffMemberships } from "@/modules/access/membership-repository";
import { resolveEventContext } from "@/modules/events/selection";

export const metadata: Metadata = { title: "Staff access" };

export default async function StaffPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions, user } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_STAFF")) {
    return <AccessRestricted title="Staff access is restricted" detail="Your event role can use its assigned operational tools, but only event administrators can manage staff assignments." />;
  }
  return <StaffWorkspace key={event.id} eventId={event.id} eventName={event.name} initialMemberships={await listStaffMemberships(event.id)} currentUserId={user.id} />;
}
