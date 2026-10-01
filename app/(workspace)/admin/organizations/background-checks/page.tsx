import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { BackgroundCheckImportPanel } from "@/components/background-check-import-panel";
import { BackgroundCheckReviewPanel } from "@/components/background-check-review-panel";
import { getCurrentSession } from "@/modules/access/current-session";
import { backgroundCheckSummary } from "@/modules/background-checks/repository";

export const metadata: Metadata = { title: "Background checks" };
export const dynamic = "force-dynamic";

/**
 * Background checks (#388, #427): the upload, what's on file, and which
 * youth or children's events have adults still needing a check. Moved under
 * Clubs and churches (#427); `/admin/background-checks` redirects here.
 */
export default async function BackgroundChecksPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const summary = await backgroundCheckSummary();
  const cards = [
    { label: "Current checks", value: summary.current, detail: "Clear, or a Sterling check good for more than 60 days. Does not include the expiring-soon checks below", tone: "green" },
    { label: "Expiring soon", value: summary.expiringSoon, detail: "Marked \"!\" on the roster, or a Sterling check ending within 60 days", tone: "gold" },
    { label: "Not current", value: summary.notCurrent, detail: "Not in compliance or expired; flagged at youth events", tone: "purple" },
    { label: "Needs a look", value: summary.reviewCount, detail: `Rows waiting on a staff decision. ${summary.unmatchedCount} more match no club roster or registration yet; that isn't work to do.`, tone: "coral" },
  ];
  return (
    <section className="page-stack">
      <BackLink href="/admin/organizations" variant="staff">Back to Clubs and churches</BackLink>
      <div className="page-intro">
        <div>
          <p className="eyebrow">Clubs and churches</p>
          <h2>Background checks</h2>
          <p>
            Upload the roster export (matched by name and club or church; no email or birth date needed) or the
            older Sterling Volunteers list. The newest upload replaces whatever was on file for a person. At events
            marked as youth or children&apos;s events (in Event settings), every adult with no check on file, an
            expired check, or a roster mark of not in compliance is flagged in red on the dashboard, People, rosters,
            and check-in. Expiring soon is not flagged there, and nothing is blocked.
          </p>
          <p>
            Each adult on a club&apos;s roster shows Clear, Expiring soon, Not in compliance, or No record. Club
            directors and deputies see the status only; the roster note, with the check and training dates, is shown
            to staff only.
          </p>
          {summary.lastRecordedAt && (
            <p className="quiet-copy">Last recorded {new Date(summary.lastRecordedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Chicago" })}.</p>
          )}
        </div>
        <BackgroundCheckImportPanel />
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

      <BackgroundCheckReviewPanel />
    </section>
  );
}
