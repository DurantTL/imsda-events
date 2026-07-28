import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Activity,
  ArrowRight,
  BadgeDollarSign,
  Building2,
  CalendarPlus,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  CloudCog,
  HeartPulse,
  RefreshCw,
  ShieldCheck,
  TentTree,
  UsersRound,
} from "lucide-react";
import { getCurrentSession } from "@/modules/access/current-session";
import { getSystemAdminDashboard } from "@/modules/system-admin/repository";
import styles from "./system-admin.module.css";

export const metadata: Metadata = { title: "System administration" };

const platformModules = [
  {
    name: "Event operations",
    detail: "Registration, payments, communications, imports, check-in, badges, reports, and assignments.",
    status: "LIVE",
    icon: CheckCircle2,
  },
  {
    name: "WR26 launch work",
    detail: "Full bundle import, aligned form steps, shirt reconfirmation, and Avery badge output.",
    status: "IN_PROGRESS",
    icon: ClipboardCheck,
  },
  {
    name: "Churches and club rosters",
    detail: "Shared organizations, club years, members, consent, and stable provider identities.",
    status: "IN_PROGRESS",
    icon: Building2,
    href: "/admin/organizations",
  },
  {
    name: "Treasury settlement",
    detail: "Post-event church billing from actual attendance and approved charge lines.",
    status: "PLANNED",
    icon: BadgeDollarSign,
  },
  {
    name: "Camp medical operations",
    detail: "Emergency workspace, audited access, confidential reports, and an expiring offline packet.",
    status: "PLANNED",
    icon: HeartPulse,
  },
  {
    name: "External systems",
    detail: "eAdventist organizations, UltraCamp operations, and Sterling clearance synchronization.",
    status: "PLANNED",
    icon: CloudCog,
  },
] as const;

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function dateRange(start: Date, end: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone,
  }).formatRange(start, end);
}

function phaseLabel(value: string) {
  return {
    DRAFT: "Draft",
    UPCOMING: "Opens soon",
    OPEN: "Registration open",
    CLOSED: "Registration closed",
  }[value] ?? value;
}

function statusLabel(value: typeof platformModules[number]["status"]) {
  return {
    LIVE: "Live",
    IN_PROGRESS: "In progress",
    NEXT: "Next",
    PLANNED: "Planned",
  }[value];
}

export default async function SystemAdminPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  const dashboard = await getSystemAdminDashboard();
  const currentEvents = dashboard.events.filter((event) => event.timing !== "PAST");
  const pastEvents = dashboard.events.filter((event) => event.timing === "PAST");

  return (
    <section className={`page-stack ${styles.workspace}`}>
      <section className={styles.hero}>
        <div>
          <span className={styles.adminBadge}><ShieldCheck aria-hidden="true" size={16} /> System administrator</span>
          <p className="eyebrow">One IMSDA operations platform</p>
          <h2>System command center</h2>
          <p>Manage every event, watch cross-system exceptions, and follow the CMMS, treasury, medical, and provider-integration build from one place.</p>
        </div>
        <div className={styles.heroActions}>
          <Link className="primary-button" href="/event-setup"><CalendarPlus aria-hidden="true" size={16} /> Create event</Link>
          <Link className="secondary-button" href="/admin/team"><UsersRound aria-hidden="true" size={15} /> Team</Link>
          <Link className="secondary-button" href="/admin/settings"><CloudCog aria-hidden="true" size={15} /> Platform settings</Link>
          <Link className="secondary-button" href="/admin"><RefreshCw aria-hidden="true" size={15} /> Refresh</Link>
        </div>
      </section>

      <section className={styles.metrics} aria-label="System summary">
        <article><span className={styles.metricIcon}><TentTree aria-hidden="true" size={20} /></span><strong>{dashboard.summary.currentEventCount}</strong><p>Current events</p><small>{dashboard.summary.publishedEventCount} published across {dashboard.summary.eventCount} total</small></article>
        <article><span className={styles.metricIcon}><UsersRound aria-hidden="true" size={20} /></span><strong>{dashboard.summary.attendeeCount}</strong><p>Expected attendees</p><small>{dashboard.summary.registrationCount} active registrations</small></article>
        <article className={dashboard.summary.operationalIssueCount > 0 ? styles.needsAttention : undefined}><span className={styles.metricIcon}><CircleAlert aria-hidden="true" size={20} /></span><strong>{dashboard.summary.operationalIssueCount}</strong><p>Operational exceptions</p><small>{dashboard.summary.unresolvedAlertCount} unresolved system alerts</small></article>
        <article><span className={styles.metricIcon}><ShieldCheck aria-hidden="true" size={20} /></span><strong>{dashboard.summary.activeUserCount}</strong><p>Active staff accounts</p><small>{dashboard.summary.pendingUserCount} pending · {dashboard.summary.systemAdminCount} system admins</small></article>
      </section>

      <div className={styles.dashboardGrid}>
        <section className={styles.primaryColumn}>
          <div className={styles.sectionHeading}>
            <div><p className="eyebrow">Across all events</p><h2>Event operations</h2><p>Open the event workspace that owns the underlying record or exception.</p></div>
            <span>{currentEvents.length} current</span>
          </div>

          <div className={styles.eventList}>
            {currentEvents.map((event) => {
              const query = `event=${encodeURIComponent(event.id)}`;
              return (
                <article className={styles.eventCard} key={event.id}>
                  <div className={styles.eventMain}>
                    <div className={styles.eventTitle}>
                      <span className={`${styles.phase} ${event.registrationPhase === "OPEN" ? styles.phaseOpen : ""}`}>{phaseLabel(event.registrationPhase)}</span>
                      <h3>{event.name}</h3>
                      <p>{dateRange(event.startsAt, event.endsAt, event.timezone)} · {event.location ?? "Location pending"}</p>
                    </div>
                    <Link className={styles.openEvent} href={`/overview?${query}`}>Open event <ArrowRight aria-hidden="true" size={15} /></Link>
                  </div>

                  <div className={styles.eventStats}>
                    <span><strong>{event.activeRegistrationCount}</strong><small>Registrations</small></span>
                    <span><strong>{event.attendeeCount}</strong><small>Attendees</small></span>
                    <span><strong>{event.checkedInCount}</strong><small>Checked in</small></span>
                    <span><strong>{event.waitingCount}</strong><small>Waitlisted</small></span>
                    <span><strong>{money(event.ledgerBalanceCents)}</strong><small>Current ledger balance</small></span>
                  </div>

                  <div className={styles.eventFooter}>
                    <div className={styles.eventWarnings}>
                      {event.setupWarnings.length === 0
                        ? <span className={styles.ready}><CheckCircle2 aria-hidden="true" size={14} /> No setup or delivery exceptions detected</span>
                        : event.setupWarnings.map((warning) => <span key={warning}><CircleAlert aria-hidden="true" size={14} /> {warning}</span>)}
                    </div>
                    <div className={styles.eventLinks}>
                      <Link href={`/registration-builder?${query}`}>Form</Link>
                      <Link href={`/more/promo-codes?${query}`}>Promo codes</Link>
                      <Link href={`/staff?${query}`}>Team</Link>
                      <Link href={`/more/health?${query}`}>Health</Link>
                      <Link href={`/more/event-settings?${query}`}>Settings</Link>
                    </div>
                  </div>
                </article>
              );
            })}
            {currentEvents.length === 0 && (
              <div className={styles.emptyState}>
                <CalendarPlus aria-hidden="true" size={24} />
                <strong>No current events</strong>
                <p>Create the next event to begin registration setup.</p>
              </div>
            )}
          </div>

          {pastEvents.length > 0 && (
            <details className={styles.pastEvents}>
              <summary>{pastEvents.length} past {pastEvents.length === 1 ? "event" : "events"}</summary>
              <div>
                {pastEvents.map((event) => (
                  <Link href={`/overview?event=${encodeURIComponent(event.id)}`} key={event.id}>
                    <span><strong>{event.name}</strong><small>{dateRange(event.startsAt, event.endsAt, event.timezone)}</small></span>
                    <ArrowRight aria-hidden="true" size={15} />
                  </Link>
                ))}
              </div>
            </details>
          )}
        </section>

        <aside className={styles.sideColumn}>
          <section className={styles.roadmap}>
            <div className={styles.sectionHeading}>
              <div><p className="eyebrow">Unified system</p><h2>Platform modules</h2><p>Live operations and the accepted build sequence.</p></div>
            </div>
            <div className={styles.moduleList}>
              {platformModules.map(({ name, detail, status, icon: Icon, ...module }) => (
                <article key={name}>
                  <span className={styles.moduleIcon}><Icon aria-hidden="true" size={18} /></span>
                  <span>
                    <strong>
                      {"href" in module
                        ? <Link href={module.href}>{name}</Link>
                        : name}
                    </strong>
                    <small>{detail}</small>
                  </span>
                  <em className={styles[`status${status}`]}>{statusLabel(status)}</em>
                </article>
              ))}
            </div>
          </section>

          <section className={styles.scope}>
            <Activity aria-hidden="true" size={20} />
            <div>
              <strong>Read-only command center</strong>
              <p>This first slice summarizes authoritative records and sends administrators to the existing workspace that can safely change them.</p>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}
