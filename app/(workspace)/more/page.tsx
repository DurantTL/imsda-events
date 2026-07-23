import type { Metadata } from "next";
import Link from "next/link";
import { Activity, ChartNoAxesCombined, FileUp, HeartPulse, ListChecks, PanelsTopLeft, Settings2, TicketPercent, UserCog } from "lucide-react";
import { listRecentAuditActivity } from "@/modules/audit/audit-service";
import { resolveEventContext } from "@/modules/events/selection";
import { canAccessOperationalHealth } from "@/modules/operations/access";
import { canManageProgramAssignments } from "@/modules/program-assignments/access";

export const metadata: Metadata = { title: "More" };

export default async function MorePage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  const activity = permissions.includes("VIEW_REPORTS") ? await listRecentAuditActivity(event.id) : [];

  return (
    <section className="page-stack">
      <div className="page-intro"><div><p className="eyebrow">Event administration</p><h2>Settings & activity</h2><p>Choose a task or review recent changes for {event.name}.</p></div></div>
      <div className="foundation-grid">
        {canAccessOperationalHealth(permissions) && <Link className="panel foundation-card" href={`/more/health?event=${event.id}`}><span><HeartPulse aria-hidden="true" size={21} /></span><h3>Operational health</h3><p>Review failed or delayed work, open balances, import exceptions, and capacity warnings.</p><small>Review exceptions</small></Link>}
        {permissions.includes("VIEW_REPORTS") && <Link className="panel foundation-card" href={`/more/reports?event=${event.id}`}><span><ChartNoAxesCombined aria-hidden="true" size={21} /></span><h3>Operational reports</h3><p>Print active attendee rosters and review meal, housing, and ranked seminar totals.</p><small>Open reports</small></Link>}
        {canManageProgramAssignments(permissions) && <Link className="panel foundation-card" href={`/more/program-assignments?event=${event.id}`}><span><ListChecks aria-hidden="true" size={21} /></span><h3>Seminar assignments</h3><p>Turn attendee rankings and room limits into reviewed, printable session rosters.</p><small>Preview assignments</small></Link>}
        {permissions.includes("MANAGE_FINANCE") && <Link className="panel foundation-card" href={`/more/promo-codes?event=${event.id}`}><span><TicketPercent aria-hidden="true" size={21} /></span><h3>Promo codes</h3><p>Create bounded registration discounts, schedule dates, and review use limits.</p><small>Manage discounts</small></Link>}
        {permissions.includes("CONFIGURE_EVENT") && <Link className="panel foundation-card" href={`/more/event-settings?event=${event.id}`}><span><Settings2 aria-hidden="true" size={21} /></span><h3>Event settings</h3><p>Edit dates, location, capacity, registration availability, and publishing.</p><small>Open settings</small></Link>}
        {permissions.includes("MANAGE_FORMS") && <Link className="panel foundation-card" href={`/registration-builder?event=${event.id}`}><span><PanelsTopLeft aria-hidden="true" size={21} /></span><h3>Registration form</h3><p>Build, test, and publish the form people use to register.</p><small>Open form builder</small></Link>}
        {permissions.includes("MANAGE_IMPORTS") && <Link className="panel foundation-card" href={`/imports?event=${event.id}`}><span><FileUp aria-hidden="true" size={21} /></span><h3>Import registrations</h3><p>Preview a CSV, review every change, then import approved records.</p><small>Open imports</small></Link>}
        {permissions.includes("MANAGE_STAFF") && <Link className="panel foundation-card" href={`/staff?event=${event.id}`}><span><UserCog aria-hidden="true" size={21} /></span><h3>Team access</h3><p>Add staff and choose what each person can do for this event.</p><small>Manage team</small></Link>}
      </div>
      {permissions.includes("VIEW_REPORTS") && <section className="panel"><div className="section-heading"><div><p className="eyebrow">Audit trail</p><h2>Recent activity</h2></div><span className="count-badge"><Activity aria-hidden="true" size={16} /> {activity.length} entries</span></div><div className="activity-list">{activity.map((entry) => <article className="activity-row" key={entry.id}><span className="activity-icon"><Activity aria-hidden="true" size={16} /></span><span><strong>{entry.summary}</strong><small>{entry.actorName} · {new Date(entry.createdAt).toLocaleString()}</small></span><code>{entry.action}</code></article>)}{activity.length === 0 && <p className="quiet-copy">No activity has been recorded for this event.</p>}</div></section>}
      {process.env.NODE_ENV !== "production" && <section className="panel review-gate"><div><p className="eyebrow">Testing status</p><h2>This local workspace uses test data</h2><p>Changes stay in the local IMSDA Events database. Live card charging and external delivery remain off until their configured test connections are ready.</p></div><span className="review-badge">Local testing</span></section>}
    </section>
  );
}
