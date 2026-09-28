import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getCurrentSession } from "@/modules/access/current-session";
import { EventTemplateOperationError, getEventTemplate } from "@/modules/event-templates/repository";
import { EventTemplateEditor } from "@/components/event-template-editor";

export const metadata: Metadata = { title: "Edit event template" };

export default async function EventTemplateEditorPage({
  params,
}: {
  params: Promise<{ templateId: string }>;
}) {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  const { templateId } = await params;
  const template = await loadTemplateOrNotFound(templateId);

  return (
    <main className="event-setup-page">
      <header className="event-setup-header">
        <div><p className="eyebrow">System administration</p><h1>{template.name}</h1></div>
      </header>
      <EventTemplateEditor initialTemplate={template} />
    </main>
  );
}

async function loadTemplateOrNotFound(templateId: string) {
  try {
    return await getEventTemplate(templateId);
  } catch (error) {
    if (error instanceof EventTemplateOperationError && error.code === "TEMPLATE_NOT_FOUND") notFound();
    throw error;
  }
}
