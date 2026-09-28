import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { EventSettingsWorkspace } from "@/components/event-settings-workspace";
import { getCurrentSession } from "@/modules/access/current-session";

export const metadata: Metadata = {
  title: "Create an event",
  robots: { index: false, follow: false },
};

export default async function EventSetupPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  return (
    <main className="event-setup-page">
      <header className="event-setup-header">
        <div className="brand"><BrandMark /><span><strong>IMSDA</strong><small>Events</small></span></div>
        <div><p className="eyebrow">System administration</p><h1>Set up a new event</h1></div>
      </header>
      <div className="event-setup-entry-actions">
        <Link className="secondary-button" href="/event-setup/from-template">Start from template</Link>
        <Link className="secondary-button" href="/event-setup/copy">Copy from a past event</Link>
      </div>
      <EventSettingsWorkspace mode="create" initialEvent={null} />
    </main>
  );
}
