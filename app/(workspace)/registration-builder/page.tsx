import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { BuilderDeviceHint } from "@/components/builder-device-hint";
import { BuilderPhoneNotice } from "@/components/builder-phone-notice";
import { RegistrationBuilderWorkspace } from "@/components/registration-builder-workspace";
import { resolveEventContext } from "@/modules/events/selection";
import { listFormTemplates, listRegistrationForms } from "@/modules/forms/repository";
import { staffPageTitles } from "@/components/staff-navigation";

export const metadata: Metadata = { title: staffPageTitles.registrationForm };

export default async function RegistrationBuilderPage({ searchParams }: { searchParams: Promise<{ event?: string; form?: string; field?: string }> }) {
  const { event: requested, form: focusForm, field: focusField } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_FORMS")) {
    return <AccessRestricted title="Registration form access is restricted" detail="Event administrators and registration managers can create, test, and publish event forms." />;
  }
  return <>
    <BuilderPhoneNotice eventId={event.id} />
    <div className="builder-phone-hidden"><BuilderDeviceHint /><RegistrationBuilderWorkspace key={event.id} eventId={event.id} eventSlug={event.slug} eventName={event.name} eventAudience={event.audience} eventBillingMode={event.billingMode} initialForms={await listRegistrationForms(event.id)} templates={listFormTemplates()} focusTarget={focusForm && focusField ? { formId: focusForm, fieldId: focusField } : null} /></div>
  </>;
}
