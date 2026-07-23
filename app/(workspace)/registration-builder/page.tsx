import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { RegistrationBuilderWorkspace } from "@/components/registration-builder-workspace";
import { resolveEventContext } from "@/modules/events/selection";
import { listFormTemplates, listRegistrationForms } from "@/modules/forms/repository";

export const metadata: Metadata = { title: "Registration builder" };

export default async function RegistrationBuilderPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_FORMS")) {
    return <AccessRestricted title="Registration builder access is restricted" detail="Event administrators and registration managers can create, test, and publish event forms." />;
  }
  return <RegistrationBuilderWorkspace key={event.id} eventId={event.id} eventSlug={event.slug} eventName={event.name} initialForms={await listRegistrationForms(event.id)} templates={listFormTemplates()} />;
}
