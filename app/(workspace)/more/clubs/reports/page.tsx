import type { Metadata } from "next";
import Link from "next/link";
import { AccessRestricted } from "@/components/access-restricted";
import { ClubReportsConference } from "@/components/club-reports-conference";
import { calendarDateIn } from "@/modules/calendar/domain";
import { resolveClubOversight } from "@/modules/club-rosters/event-oversight";
import { listClubReportsForYear } from "@/modules/club-reports/repository";
import { clubYearFor } from "@/modules/club-rosters/domain";

export const metadata: Metadata = { title: "Club monthly reports" };
export const dynamic = "force-dynamic";

/** Every club's monthly reports, view only, for a Pathfinder event's managers (#387). */
export default async function EventClubReportsPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, allowed } = await resolveClubOversight(requested);
  if (!allowed) return <AccessRestricted title="Club oversight is restricted" detail="Event administrators of this Pathfinder event can view club reports." />;
  const now = new Date();
  const clubYear = clubYearFor(now);
  return (
    <>
      <Link className="secondary-button more-back-link" href={`/more/clubs?event=${event.id}`}>Back to clubs</Link>
      <ClubReportsConference
        clubYear={clubYear}
        initialClubs={await listClubReportsForYear(clubYear)}
        now={calendarDateIn(now)}
        viewOnlyReportHref={{ base: "/more/clubs/reports", query: `?event=${event.id}` }}
      />
    </>
  );
}
