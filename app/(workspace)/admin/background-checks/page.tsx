import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { SterlingUpload } from "@/components/sterling-upload";
import { getCurrentSession } from "@/modules/access/current-session";
import { backgroundCheckSummary } from "@/modules/background-checks/repository";

export const metadata: Metadata = { title: "Background checks" };
export const dynamic = "force-dynamic";

/**
 * Sterling Volunteers background checks (#388): the upload, what's on file,
 * and which youth or children's events have adults still needing a check.
 */
export default async function BackgroundChecksPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const summary = await backgroundCheckSummary();
  const cards = [
    { label: "Current checks", value: summary.current, detail: "Good through today or later", tone: "green" },
    { label: "Expiring in 60 days", value: summary.expiringSoon, detail: "Ask them to renew in Sterling", tone: "gold" },
    { label: "Expired", value: summary.expired, detail: "Flagged at youth events", tone: "purple" },
  ];
  return (
    <section className="page-stack">
      <Link className="secondary-button more-back-link" href="/admin">Back to system administration</Link>
      <div className="page-intro">
        <div>
          <p className="eyebrow">System administration</p>
          <h2>Background checks</h2>
          <p>
            Upload the Sterling Volunteers list by hand. At events marked as youth or children&apos;s events
            (in Event settings), every adult without a current check is flagged in red on the dashboard,
            People, rosters, and check-in. Nothing is blocked. Clubs never see these flags.
          </p>
          {summary.lastRecordedAt && (
            <p className="quiet-copy">Last recorded {new Date(summary.lastRecordedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Chicago" })}.</p>
          )}
        </div>
        <SterlingUpload />
      </div>

      <section className="report-summary-grid" aria-label="Background checks on file">
        {cards.map((card) => (
          <article className={`metric-card report-summary-card accent-${card.tone}`} key={card.label}>
            <strong>{card.value}</strong><p>{card.label}</p><small>{card.detail}</small>
          </article>
        ))}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Upcoming</p>
            <h2>Youth and children&apos;s events</h2>
            <p>Events that check adults. Open one&apos;s reports for the full list.</p>
          </div>
        </div>
        {summary.events.length === 0 ? (
          <p className="report-empty">No upcoming event is marked as a youth or children&apos;s event. Turn it on in an event&apos;s settings.</p>
        ) : (
          <div className="report-table-wrap">
            <table className="report-table">
              <caption className="sr-only">Youth and children&apos;s events</caption>
              <thead><tr><th scope="col">Event</th><th scope="col">Starts</th><th scope="col">Adults</th><th scope="col">Need a check</th></tr></thead>
              <tbody>
                {summary.events.map((event) => (
                  <tr key={event.id}>
                    <th scope="row"><Link className="report-record-link" href={`/more/reports?event=${encodeURIComponent(event.id)}#background-checks`}>{event.name}</Link></th>
                    <td>{event.startsOn}</td>
                    <td>{event.adults}</td>
                    <td>
                      {event.needed > 0
                        ? <span className="status-chip coral background-check-badge"><ShieldAlert aria-hidden="true" size={12} /> {event.needed}</span>
                        : <span className="status-chip green background-check-badge"><ShieldCheck aria-hidden="true" size={12} /> All current</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
