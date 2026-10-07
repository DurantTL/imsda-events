import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { NewClubApplicationForm } from "@/components/new-club-application-form";
import { calendarDateInEventTimeZone } from "@/modules/events/lifecycle";
import { listPublicSponsorOptions } from "@/modules/club-applications/repository";

/**
 * The page around the new club application (#817), shared by the public
 * "Register a new club" page and the private invite link's page.
 */
export async function NewClubApplicationPage({ invite }: { invite?: { token: string; email: string; name: string } }) {
  const churches = await listPublicSponsorOptions();
  const today = calendarDateInEventTimeZone(new Date(), "America/Chicago");
  const todayLabel = new Date(`${today}T12:00:00Z`).toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" });
  return (
    <main className="public-registration-page public-manage-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <Link className="public-registration-brand public-event-brand-link" href="/">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </Link>
          {/* A plain link, not <Link>: /clubs carries its own CSP for the map, so it is only reached by a full page load (#437). */}
          <a className="text-button back-link" href="/clubs">Find a club</a>
        </div>
      </header>
      <section className="public-registration-hero public-manage-hero">
        <div>
          <p className="public-registration-eyebrow">Iowa-Missouri Conference</p>
          <h1>Register a new club</h1>
          <p>
            Apply to start a Pathfinder or Adventurer club. This mirrors the conference&apos;s paper application. Nothing is set up until the
            conference youth department approves it, and applications are open all year.
          </p>
          {invite && <p>You opened this from a private link, so your email is filled in. The link works once.</p>}
        </div>
      </section>
      <div className="public-manage-layout club-form-public">
        <NewClubApplicationForm
          churches={churches}
          inviteToken={invite?.token}
          prefill={invite ? { email: invite.email, name: invite.name } : undefined}
          todayLabel={todayLabel}
        />
      </div>
    </main>
  );
}
