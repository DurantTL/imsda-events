import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ClubReportsConference } from "@/components/club-reports-conference";
import { getCurrentSession } from "@/modules/access/current-session";
import { calendarDateIn } from "@/modules/calendar/domain";
import { listClubReportsForYear } from "@/modules/club-reports/repository";
import { clubYearFor } from "@/modules/club-rosters/domain";

export const metadata: Metadata = { title: "Club monthly reports" };
export const dynamic = "force-dynamic";

export default async function ClubReportsAdminPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const { year } = await searchParams;
  const now = new Date();
  const current = clubYearFor(now);
  const clubYear = year && /^\d{4}-\d{2}$/.test(year) ? year : current;
  const start = Number(clubYear.slice(0, 4));
  const label = (value: number) => `${value}-${String((value + 1) % 100).padStart(2, "0")}`;
  return (
    <>
      <div className="intro-actions club-admin-links">
        <Link className="secondary-button more-back-link" href="/admin/organizations">Back to churches and clubs</Link>
        <Link className="secondary-button" href={`/admin/clubs/reports?year=${label(start - 1)}`}>← {label(start - 1)}</Link>
        {clubYear !== current && <Link className="secondary-button" href={`/admin/clubs/reports?year=${label(start + 1)}`}>{label(start + 1)} →</Link>}
      </div>
      <ClubReportsConference clubYear={clubYear} initialClubs={await listClubReportsForYear(clubYear)} key={clubYear} now={calendarDateIn(now)} />
    </>
  );
}
