import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { LodgingWorkspace } from "@/components/lodging-workspace";
import { staffPageTitles } from "@/components/staff-navigation";
import { resolveEventContext } from "@/modules/events/selection";
import { getLodgingView } from "@/modules/lodging/service";

export const metadata: Metadata = { title: staffPageTitles.lodging };

export default async function LodgingPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  // Authorization is decided here on the server, and again by every API route the screen calls.
  if (!permissions.includes("CONFIGURE_EVENT")) {
    return <AccessRestricted title="Lodging is restricted" detail="Event administrators can review and set up lodging inventory for this event." />;
  }
  const view = await getLodgingView(event.id);
  return <LodgingWorkspace eventName={event.name} initialView={view} canSetRates={permissions.includes("MANAGE_FINANCE")} />;
}
