import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarAdminWorkspace } from "@/components/calendar-admin-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { listCalendarEntries, listCalendarEvents } from "@/modules/calendar/repository";

export const metadata: Metadata = { title: "Conference calendar" };
export const dynamic = "force-dynamic";

export default async function CalendarAdminPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const [entries, events] = await Promise.all([listCalendarEntries(), listCalendarEvents()]);

  return (
    <>
      <Link className="secondary-button more-back-link" href="/admin">
        Back to system administration
      </Link>
      <CalendarAdminWorkspace initialEntries={entries} initialEvents={events} />
    </>
  );
}
