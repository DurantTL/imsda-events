import type { Metadata } from "next";
import Link from "next/link";
import { BackLink } from "@/components/back-link";
import { BrandMark } from "@/components/brand-mark";
import { PublicClubDirectory } from "@/components/public-club-directory";
import { listPublicClubs } from "@/modules/organizations/public-club-directory";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Find a club",
  description: "Pathfinder and Adventurer clubs across the Iowa-Missouri Conference that have chosen to be listed publicly.",
  alternates: { canonical: "/clubs" },
  robots: { index: true, follow: true },
};

/**
 * The public club directory and map (#437): only clubs whose own director
 * chose "list this club publicly," with only what they published. See
 * modules/organizations/public-club-directory for exactly what that is and
 * what it deliberately leaves out.
 */
export default async function PublicClubsPage() {
  const clubs = await listPublicClubs();

  return (
    <main className="public-registration-page public-calendar-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <Link className="public-registration-brand public-event-brand-link" href="/">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </Link>
          <BackLink href="/">Events home</BackLink>
        </div>
      </header>

      <section className="public-registration-hero calendar-hero">
        <div>
          <p className="public-registration-eyebrow">Iowa-Missouri Conference</p>
          <h1>Find a club</h1>
          <p>Pathfinder and Adventurer clubs that have chosen to be listed publicly.</p>
          <p><Link href="/clubs/register">Register a new club</Link>: applications are open all year.</p>
        </div>
      </section>

      <div className="calendar-layout">
        <PublicClubDirectory clubs={clubs} />
      </div>
    </main>
  );
}
