import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { EventSettingsWorkspace } from "@/components/event-settings-workspace";
import { getCurrentSession } from "@/modules/access/current-session";

export const metadata: Metadata = { title: "Create an event" };

export default async function EventSetupPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  return (
    <main className="event-setup-page">
      <header className="event-setup-header">
        <div className="brand"><BrandMark /><span><strong>IMSDA</strong><small>Events</small></span></div>
        <div><p className="eyebrow">System administration</p><h1>Set up a new event</h1></div>
      </header>
      <EventSettingsWorkspace mode="create" initialEvent={null} />
    </main>
  );
}
