import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { getCurrentSession } from "@/modules/access/current-session";
import { listEventTemplates } from "@/modules/event-templates/repository";
import { StartFromTemplate } from "@/components/start-from-template";

export const metadata: Metadata = { title: "Start from template" };

export default async function StartFromTemplatePage() {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  // Exactly what `applyEventTemplate` accepts: not archived, with a valid
  // published version. A published template with a newer draft stays listed.
  const templates = (await listEventTemplates()).filter((template) => template.canApply);

  return (
    <main className="event-setup-page">
      <header className="event-setup-header">
        <div className="brand"><BrandMark /><span><strong>IMSDA</strong><small>Events</small></span></div>
        <div><p className="eyebrow">System administration</p><h1>Start from template</h1></div>
      </header>
      <StartFromTemplate templates={templates} />
    </main>
  );
}
