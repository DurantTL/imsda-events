import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, ChevronRight, LayoutDashboard, MapPin, UserRound, UsersRound } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { AgendaItem } from "@/components/calendar-agenda-item";
import { getCurrentSession } from "@/modules/access/current-session";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { addDays } from "@/modules/calendar/domain";
import { conferenceToday, listPublicCalendarItems } from "@/modules/calendar/repository";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "IMSDA Events",
  description: "Register for Iowa-Missouri Conference events, manage your club, and see the conference calendar.",
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
};

const upcomingLimit = 6;

/**
 * The public front door (#373). Members, club leaders, and visitors start
 * here. Staff sign-in is deliberately not linked (decision 2026-09-23).
 */
export default async function Home() {
  const today = conferenceToday();
  const [items, session, attendee] = await Promise.all([
    listPublicCalendarItems(today, addDays(today, 365)),
    getCurrentSession(),
    getCurrentAttendee(),
  ]);
  const upcoming = items.slice(0, upcomingLimit);
  const signedInName = attendee.account?.displayName || attendee.account?.verifiedEmail;

  return (
    <main className="public-registration-page public-calendar-page public-home-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <a className="public-registration-brand public-event-brand-link" href="https://imsda.org/">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </a>
          {/* Staff sign-in isn't linked from the public site; administrators use /login directly. */}
          {session.user && (
            <Link className="text-button" href="/overview">
              <LayoutDashboard size={16} aria-hidden="true" /> <span>Staff workspace</span>
            </Link>
          )}
        </div>
      </header>

      <section className="public-registration-hero calendar-hero">
        <div>
          <p className="public-registration-eyebrow">Iowa-Missouri Conference</p>
          <h1>Events and registration</h1>
          <p>Register for camps and conventions, manage your club, and see what&apos;s coming up across Iowa and Missouri.</p>
        </div>
      </section>

      <div className="calendar-layout">
        <nav aria-label="Get started" className="home-actions">
          <Link className="home-action" href="/account">
            <UserRound size={22} aria-hidden="true" />
            <span>
              <strong>{signedInName ? "Go to my account" : "My account"}</strong>
              <small>{signedInName ? `Signed in as ${signedInName}` : "Your registrations, profile, and sign-in"}</small>
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </Link>
          <Link className="home-action" href="/account/clubs">
            <UsersRound size={22} aria-hidden="true" />
            <span>
              <strong>My club</strong>
              <small>Directors and club leaders: roster and club registrations</small>
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </Link>
          <Link className="home-action" href="/calendar">
            <CalendarDays size={22} aria-hidden="true" />
            <span>
              <strong>Conference calendar</strong>
              <small>Every camp, convention, and ministry date</small>
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </Link>
          <Link className="home-action" href="/clubs">
            <MapPin size={22} aria-hidden="true" />
            <span>
              <strong>Find a club</strong>
              <small>Pathfinder and Adventurer clubs near you</small>
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </Link>
        </nav>

        <section aria-labelledby="home-upcoming-heading" className="calendar-agenda">
          <h2 id="home-upcoming-heading">Coming up</h2>
          {upcoming.length === 0 ? (
            <p className="calendar-empty">Nothing is on the calendar yet. Check back soon.</p>
          ) : (
            <ul className="calendar-agenda-list">{upcoming.map((item) => <AgendaItem item={item} key={item.key} />)}</ul>
          )}
          {items.length > 0 && (
            <p className="home-more"><Link href="/calendar?view=list">See the full calendar</Link></p>
          )}
        </section>
      </div>
    </main>
  );
}
