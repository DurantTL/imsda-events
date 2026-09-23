import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import {
  Activity,
  ArrowRight,
  Award,
  CalendarDays,
  BellRing,
  CalendarPlus,
  CheckCircle2,
  Church,
  CircleAlert,
  CloudCog,
  Map as MapIcon,
  MailCheck,
  RefreshCw,
  ShieldCheck,
  TentTree,
  Timer,
  UsersRound,
} from "lucide-react";
import { getCurrentSession } from "@/modules/access/current-session";
import { getSystemAdminDashboard, getSystemHealth } from "@/modules/system-admin/repository";
import type { SetupWarningKind } from "@/modules/system-admin/dashboard";
import { getReleaseIdentity } from "@/lib/release";
import packageInfo from "@/package.json";
import styles from "./system-admin.module.css";

export const metadata: Metadata = { title: "System administration" };

/** Where the build plan lives. The command center shows live state, not the plan. */
const ROADMAP_URL = "https://github.com/DurantTL/imsda-events/issues/98";

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

function countdown(timing: string, daysUntilStart: number | null) {
  if (timing === "IN_PROGRESS") return "Happening now";
  if (daysUntilStart === null) return null;
  if (daysUntilStart <= 1) return "Starts tomorrow";
  return `Starts in ${daysUntilStart} days`;
}

function ago(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 90) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const warningHref: Record<SetupWarningKind, string> = {
  UNPUBLISHED: "/more/event-settings",
  NO_PUBLISHED_FORM: "/registration-builder",
  IMPORT_ISSUES: "/imports",
  IMPORT_WARNINGS: "/imports",
  DELIVERY_ISSUES: "/communications?view=deliveries",
};

function withEvent(href: string, eventQuery: string) {
  return `${href}${href.includes("?") ? "&" : "?"}${eventQuery}`;
}

type HealthRow = {
  name: string;
  state: "ok" | "warn" | "bad" | "unknown";
  label: string;
  detail: string;
  icon: typeof Activity;
  extra?: ReactNode;
};

const healthClass = {
  ok: styles.healthOk,
  warn: styles.healthWarn,
  bad: styles.healthBad,
  unknown: styles.healthUnknown,
};

export default async function SystemAdminPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  const [dashboard, health] = await Promise.all([
    getSystemAdminDashboard(),
    getSystemHealth(),
  ]);
  const currentEvents = dashboard.events.filter((event) => event.timing !== "PAST");
  const pastEvents = dashboard.events.filter((event) => event.timing === "PAST");
  const release = getReleaseIdentity();

  const { sweep, outbox, alerts } = health;
  const healthRows: HealthRow[] = [
    {
      name: "Email sweep",
      icon: Timer,
      ...(!sweep
        ? { state: "unknown" as const, label: "Unknown", detail: "The last sweep time could not be read." }
        : sweep.status === "ok"
          ? { state: "ok" as const, label: "Running", detail: `Last ran ${ago(sweep.ageMs ?? 0)}. Retries email, raises alerts, and prunes community content.` }
          : sweep.status === "stale"
            ? { state: "bad" as const, label: "Stopped?", detail: `Last ran ${ago(sweep.ageMs ?? 0)}. Failed email is not being retried and no alerts are raised until it runs again. Check the five-minute script on the server.` }
            : sweep.status === "failing"
              ? { state: "bad" as const, label: "Failing", detail: "The latest sweep reached the app but failed. Check the app logs for “Outbox sweep failed”." }
              : { state: "warn" as const, label: "Not seen", detail: "No sweep has reported yet. Make sure the five-minute script posts to /api/internal/outbox/sweep." }),
    },
    {
      name: "Email queue",
      icon: MailCheck,
      ...(!outbox
        ? { state: "unknown" as const, label: "Unknown", detail: "The email queue could not be read." }
        : outbox.status === "ok"
          ? { state: "ok" as const, label: "Flowing", detail: `${outbox.pending} waiting · ${outbox.failed} gave up after retries.` }
          : { state: "warn" as const, label: "Backing up", detail: `${outbox.reasons.join(". ")}. A large announcement can cause this briefly.` }),
    },
    {
      name: "Open alerts",
      icon: BellRing,
      ...(!alerts
        ? { state: "unknown" as const, label: "Unknown", detail: "Open alerts could not be read." }
        : alerts.length === 0
          ? { state: "ok" as const, label: "None", detail: "Nothing the alert scan is still reporting." }
          : {
              state: "bad" as const,
              label: `${dashboard.summary.unresolvedAlertCount} open`,
              detail: "Cleared automatically once the condition is fixed.",
              extra: (
                <ul className={styles.alertList}>
                  {alerts.map((alert) => <li key={alert.key}>{alert.summary}</li>)}
                </ul>
              ),
            }),
    },
  ];

  return (
    <section className={`page-stack ${styles.workspace}`}>
      <section className={styles.hero}>
        <div>
          <span className={styles.adminBadge}><ShieldCheck aria-hidden="true" size={16} /> System administrator</span>
          <p className="eyebrow">One IMSDA operations platform</p>
          <h2>System command center</h2>
          <p>Every event, the system&rsquo;s health, and the exceptions that need someone. Each link opens the event workspace that can change the record.</p>
        </div>
        <div className={styles.heroActions}>
          <Link className="primary-button" href="/event-setup"><CalendarPlus aria-hidden="true" size={16} /> Create event</Link>
          <Link className="secondary-button" href="/admin/team"><UsersRound aria-hidden="true" size={15} /> Team</Link>
          <Link className="secondary-button" href="/admin/settings"><CloudCog aria-hidden="true" size={15} /> Platform settings</Link>
          <Link className="secondary-button" href="/admin/organizations"><Church aria-hidden="true" size={15} /> Churches and clubs</Link>
          <Link className="secondary-button" href="/admin/honors"><Award aria-hidden="true" size={15} /> Honor catalog</Link>
          <Link className="secondary-button" href="/admin/calendar"><CalendarDays aria-hidden="true" size={15} /> Public calendar</Link>
          <Link className="secondary-button" href="/admin"><RefreshCw aria-hidden="true" size={15} /> Refresh</Link>
        </div>
      </section>

      <section className={styles.metrics} aria-label="System summary">
        <article><span className={styles.metricIcon}><TentTree aria-hidden="true" size={20} /></span><strong>{dashboard.summary.currentEventCount}</strong><p>Current events</p><small>{dashboard.summary.publishedEventCount} published across {dashboard.summary.eventCount} total</small></article>
        <article><span className={styles.metricIcon}><UsersRound aria-hidden="true" size={20} /></span><strong>{dashboard.summary.attendeeCount}</strong><p>Expected attendees</p><small>{dashboard.summary.registrationCount} active registrations</small></article>
        <article className={dashboard.summary.operationalIssueCount > 0 ? styles.needsAttention : undefined}><span className={styles.metricIcon}><CircleAlert aria-hidden="true" size={20} /></span><strong>{dashboard.summary.operationalIssueCount}</strong><p>Operational exceptions</p><small>{dashboard.summary.unresolvedAlertCount} open system alerts · failed imports and email</small></article>
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
              const when = countdown(event.timing, event.daysUntilStart);
              return (
                <article className={styles.eventCard} key={event.id}>
                  <div className={styles.eventMain}>
                    <div className={styles.eventTitle}>
                      <span>
                        <span className={`${styles.phase} ${event.registrationPhase === "OPEN" ? styles.phaseOpen : ""}`}>{phaseLabel(event.registrationPhase)}</span>
                        {when && <span className={styles.countdown}>{when}</span>}
                      </span>
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
                    <span>
                      <Link href={`/finance?${query}`} title="Money still owed on active registrations">
                        <strong>{money(event.ledgerBalanceCents)}</strong><small>Outstanding balance</small>
                      </Link>
                    </span>
                  </div>

                  <div className={styles.eventFooter}>
                    <div className={styles.eventWarnings}>
                      {event.setupWarnings.length === 0
                        ? <span className={styles.ready}><CheckCircle2 aria-hidden="true" size={14} /> No setup or delivery exceptions detected</span>
                        : event.setupWarnings.map((warning) => (
                          <Link
                            className={warning.exception ? styles.exception : undefined}
                            href={withEvent(warningHref[warning.kind], query)}
                            key={warning.kind}
                          >
                            <CircleAlert aria-hidden="true" size={14} /> {warning.label}
                          </Link>
                        ))}
                    </div>
                    <div className={styles.eventLinks}>
                      <Link href={`/registration-builder?${query}`}>Form</Link>
                      <Link href={`/finance/square-payments?${query}`}>Square matching</Link>
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
          <section className={styles.roadmap} id="system-health">
            <div className={styles.sectionHeading}>
              <div><p className="eyebrow">Live</p><h2>System health</h2><p>The unattended jobs nobody watches until they stop. Read when this page loaded.</p></div>
            </div>
            <div className={styles.moduleList}>
              {healthRows.map(({ name, state, label, detail, icon: Icon, extra }) => (
                <article key={name}>
                  <span className={styles.moduleIcon}><Icon aria-hidden="true" size={18} /></span>
                  <span>
                    <strong>{name}</strong>
                    <small>{detail}</small>
                    {extra}
                  </span>
                  <em className={healthClass[state]}>{label}</em>
                </article>
              ))}
            </div>
          </section>

          <section className={styles.scope}>
            <MapIcon aria-hidden="true" size={20} />
            <div>
              <strong>Build roadmap</strong>
              <p>
                What is being built next, and in what order, is kept in{" "}
                <a href={ROADMAP_URL} rel="noreferrer" target="_blank">GitHub issue #98</a>.
                This page only shows what is live.
              </p>
            </div>
          </section>

          <section className={styles.scope}>
            <RefreshCw aria-hidden="true" size={20} />
            <div>
              <strong>System version</strong>
              <p>
                App v{packageInfo.version}
                {release.sha ? ` · release ${release.sha.slice(0, 7)}` : " · release commit unknown"}
                {release.buildId ? ` · build ${release.buildId}` : ""}
              </p>
              <p>Changes when this deployment last changed. Compare after a deploy to confirm it took.</p>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}
