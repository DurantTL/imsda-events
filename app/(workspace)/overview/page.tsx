import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  CircleDollarSign,
  Megaphone,
  Search,
  UserRoundPlus,
  UsersRound,
  WalletCards,
} from "lucide-react";
import { evaluateEventRegistrationPhase } from "@/modules/events/lifecycle";
import { getEventOverview } from "@/modules/events/repository";
import { resolveEventContext } from "@/modules/events/selection";
import { listRegistrations } from "@/modules/registrations/repository";

export const metadata: Metadata = { title: "Overview" };

function formatEventDates(start: Date, end: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone,
  });
  return formatter.formatRange(start, end);
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

function registrationSummary(registration: Awaited<ReturnType<typeof listRegistrations>>[number]) {
  if (registration.status === "CANCELLED") return { label: "Cancelled", tone: "purple" };
  if (registration.status === "WAITLISTED") return { label: "Waitlisted", tone: "purple" };
  if (registration.status === "DRAFT") return { label: "Draft", tone: "purple" };
  if (registration.balanceCents > 0) return { label: `${money(registration.balanceCents)} due`, tone: "gold" };
  if (registration.totalAmountCents === 0) return { label: "No charge", tone: "purple" };
  return { label: "Paid", tone: "green" };
}

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const requested = (await searchParams).event;
  const { event, permissions } = await resolveEventContext(requested);
  const canSeeSensitiveData = permissions.includes("VIEW_SENSITIVE_DATA");
  const canViewReports = permissions.includes("VIEW_REPORTS");
  const [overview, registrations] = await Promise.all([
    getEventOverview(event.id),
    canSeeSensitiveData ? listRegistrations(event.id) : Promise.resolve([]),
  ]);
  if (!overview) return null;

  const { metrics } = overview;
  const query = `?event=${encodeURIComponent(event.id)}`;
  const incomplete = registrations.filter((registration) => registration.status === "DRAFT").length;
  const recent = registrations.slice(0, 4);
  const workerCount = registrations.flatMap((registration) => registration.attendees).filter((attendee) => attendee.attendeeType === "WORKER").length;
  const capacityUsed = event.capacity ? Math.min((metrics.people / event.capacity) * 100, 100) : 0;
  const registrationPhase = evaluateEventRegistrationPhase(event);
  const eventState = {
    DRAFT: "Draft event",
    UPCOMING: "Registration opens soon",
    OPEN: overview.lifecycle.remainingSpots === 0
      ? event.waitlistEnabled ? "Waitlist open" : "Registration full"
      : "Registration open",
    CLOSED: "Registration closed",
  }[registrationPhase];
  const metricsCards = [
    { label: "Registrations", value: metrics.registrations, detail: canSeeSensitiveData ? `${registrations.filter((registration) => registration.status === "CONFIRMED").length} confirmed` : "Event total", tone: "navy", visible: true },
    { label: "Expected people", value: metrics.people, detail: canSeeSensitiveData ? `${workerCount} event ${workerCount === 1 ? "worker" : "workers"}` : "Event total", tone: "purple", visible: true },
    { label: "Pending payment", value: metrics.pendingPaymentCount, detail: `${money(metrics.outstandingCents)} outstanding`, tone: "gold", visible: canViewReports },
    { label: "Checked in", value: metrics.checkedIn, detail: `${metrics.people - metrics.checkedIn} awaiting arrival`, tone: "green", visible: true },
  ].filter((metric) => metric.visible);
  const quickActions = [
    canSeeSensitiveData ? { href: `/people${query}`, label: "Find a person", detail: "Search registrations and attendees", icon: Search, tone: "navy" } : null,
    permissions.includes("MANAGE_REGISTRATION") ? { href: `/events/${event.slug}`, label: "Start registration", detail: "Use the same published form as attendees", icon: UserRoundPlus, tone: "purple" } : null,
    permissions.includes("MANAGE_FINANCE") ? { href: `/finance${query}`, label: "Review finances", detail: "Payments, refunds, and balances", icon: WalletCards, tone: "gold" } : null,
    permissions.includes("MANAGE_CHECK_IN") ? { href: `/check-in${query}`, label: "Open check-in", detail: "Record attendee arrivals", icon: CheckCircle2, tone: "green" } : null,
    { href: `/communications${query}${permissions.includes("MANAGE_COMMUNICATIONS") ? "&new=1" : ""}`, label: permissions.includes("MANAGE_COMMUNICATIONS") ? "Draft an update" : "View updates", detail: permissions.includes("MANAGE_COMMUNICATIONS") ? "Create an attendee announcement" : "Review attendee announcements", icon: Megaphone, tone: "gold" },
  ].filter((action): action is NonNullable<typeof action> => Boolean(action));

  return (
    <>
      <section className="event-hero">
        <div className="hero-copy">
          <span className="event-state">{eventState}</span>
          <p className="hero-eyebrow">Current event</p><h2>{event.name}</h2>
          <p className="hero-meta"><CalendarDays aria-hidden="true" size={17} /> {formatEventDates(event.startsAt, event.endsAt, event.timezone)}<span aria-hidden="true">•</span> {event.location ?? "Location pending"}</p>
        </div>
        <div className="hero-capacity" aria-label="Event capacity"><span>Capacity</span><strong>{metrics.people} / {event.capacity ?? "Open"}</strong><div className="capacity-track"><span style={{ width: `${capacityUsed}%` }} /></div></div>
      </section>

      <section className="metric-grid" aria-label="Event metrics">
        {metricsCards.map((metric) => <article className={`metric-card accent-${metric.tone}`} key={metric.label}><strong>{metric.value}</strong><p>{metric.label}</p><small>{metric.detail}</small></article>)}
      </section>

      <div className="dashboard-grid">
        <div className="main-column">
          <section className="panel"><div className="section-heading"><div><p className="eyebrow">Event operations</p><h2>Quick actions</h2></div></div><div className="action-grid">{quickActions.map(({ href, label, detail, icon: Icon, tone }) => <Link className="action-card" href={href} key={label}><span className={`action-icon ${tone}`}><Icon aria-hidden="true" size={19} /></span><strong>{label}</strong><small>{detail}</small><ArrowRight className="action-arrow" aria-hidden="true" size={16} /></Link>)}</div></section>
          {canSeeSensitiveData && <section className="panel">
            <div className="section-heading"><div><p className="eyebrow">Latest records</p><h2>Recent registrations</h2></div><Link className="text-link" href={`/people${query}`}>View all <ArrowRight aria-hidden="true" size={15} /></Link></div>
            <div className="person-list">
              {recent.map((registration) => {
                const summary = registrationSummary(registration);
                return <Link className="person-row linked-row" href={`/people${query}&registration=${registration.id}`} key={registration.id}><span className={`person-avatar ${summary.tone}`}>{registration.accountHolder.firstName[0]}{registration.accountHolder.lastName[0]}</span><span><strong>{registration.accountHolder.firstName} {registration.accountHolder.lastName}</strong><small>{registration.confirmationCode} · {registration.attendeeCount} {registration.attendeeCount === 1 ? "person" : "people"}</small></span><span className={`status-chip ${summary.tone}`}>{summary.label}</span></Link>;
              })}
              {recent.length === 0 && <p className="quiet-copy">No registrations have been added to this event yet.</p>}
            </div>
          </section>}
        </div>

        <aside className="side-column">
          {canSeeSensitiveData && <section className="panel attention-panel"><div className="section-heading"><div><p className="eyebrow">Needs attention</p><h2>Operations queue</h2></div></div>{permissions.includes("MANAGE_FINANCE") && <Link className="attention-row" href={`/finance${query}&filter=BALANCE`}><span className="attention-icon gold"><CircleDollarSign aria-hidden="true" size={18} /></span><span><strong>{metrics.pendingPaymentCount} {metrics.pendingPaymentCount === 1 ? "balance" : "balances"} to review</strong><small>{money(metrics.outstandingCents)} outstanding</small></span><ArrowRight aria-hidden="true" size={16} /></Link>}{permissions.includes("MANAGE_REGISTRATION") && <Link className="attention-row" href={`/people${query}&filter=DRAFT`}><span className="attention-icon purple"><UsersRound aria-hidden="true" size={18} /></span><span><strong>{incomplete} draft {incomplete === 1 ? "registration" : "registrations"}</strong><small>Complete attendee details</small></span><ArrowRight aria-hidden="true" size={16} /></Link>}</section>}
          {process.env.NODE_ENV !== "production" && <section className="panel safe-boundary"><p className="eyebrow">Development environment</p><h2>Local database</h2><p>This preview writes only to the local IMSDA Events database. External delivery and card charging require their separate test credentials.</p><span><CheckCircle2 aria-hidden="true" size={16} /> Production services stay isolated</span></section>}
        </aside>
      </div>
    </>
  );
}
