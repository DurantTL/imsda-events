import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/modules/access/current-session";
import { listEventTemplates } from "@/modules/event-templates/repository";
import { EventTemplateList } from "@/components/event-template-list";

export const metadata: Metadata = { title: "Event templates" };

export default async function EventTemplatesPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  const templates = await listEventTemplates();

  return (
    <main className="event-setup-page">
      <header className="event-setup-header">
        <div><p className="eyebrow">System administration</p><h1>Event templates</h1></div>
      </header>
      <EventTemplateList initialTemplates={templates} />
    </main>
  );
}
