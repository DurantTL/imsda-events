import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { ResponsibleAdultReview } from "@/components/responsible-adult-review";
import { resolveEventContext } from "@/modules/events/selection";
import { getGuardianReview } from "@/modules/guardian-authority/repository";

export const metadata: Metadata = { title: "Responsible adults" };

/**
 * Minors who need staff attention (#131): "None of us", no adult on the registration, unknown age, two adults
 * claiming one minor. Names are attendee names, so the same permission as the people list applies; changing
 * anything needs MANAGE_REGISTRATION, checked again by the endpoint.
 */
export default async function ResponsibleAdultsPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("VIEW_SENSITIVE_DATA")) {
    return <AccessRestricted title="People records are restricted" detail="Your event role does not include access to attendee names, so the responsible-adult review is not available." />;
  }
  const review = await getGuardianReview(event.id);
  return <ResponsibleAdultReview eventId={event.id} review={review} canEdit={permissions.includes("MANAGE_REGISTRATION")} canExport={permissions.includes("VIEW_REPORTS")} />;
}
