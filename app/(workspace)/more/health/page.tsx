import type { Metadata } from "next";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CircleDollarSign,
  FileWarning,
  Gauge,
  HeartPulse,
  MailWarning,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { resolveEventContext } from "@/modules/events/selection";
import {
  canAccessOperationalHealth,
  operationalHealthAccessFor,
} from "@/modules/operations/access";
import {
  CAPACITY_NEAR_PERCENT,
  MESSAGE_OVERDUE_AFTER_MINUTES,
  PAYMENT_STUCK_AFTER_MINUTES,
  type OperationalSeverity,
} from "@/modules/operations/operational-health";
import { getOperationalHealth } from "@/modules/operations/repository";
import styles from "./operational-health.module.css";

export const metadata: Metadata = { title: "Operational health" };

const visibleRowLimit = 20;

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function timeLabel(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
}

function words(value: string) {
  return value
    .toLocaleLowerCase("en-US")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase("en-US"));
}

function severityLabel(severity: OperationalSeverity) {
  return severity === "URGENT" ? "Needs action" : "Watch";
}

function SeverityBadge({ severity }: { severity: OperationalSeverity }) {
  return (
    <span className={`${styles.badge} ${severity === "URGENT" ? styles.badgeUrgent : ""}`}>
      {severityLabel(severity)}
    </span>
  );
}

function IssueSection({
  icon,
  title,
  description,
  count,
  emptyCopy,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  count: number;
  emptyCopy: string;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeading}>
        <div className={styles.sectionTitle}>
          <span className={styles.sectionIcon}>{icon}</span>
          <div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
        </div>
        <span className={styles.count}>{count} {count === 1 ? "item" : "items"}</span>
      </div>
      {count === 0 ? <div className={styles.empty}>{emptyCopy}</div> : children}
    </section>
  );
}

function ResolveLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link className={styles.resolveLink} href={href}>
      {children}
      <ArrowRight aria-hidden="true" size={14} />
    </Link>
  );
}

function hiddenRowsNotice(total: number) {
  const hidden = total - visibleRowLimit;
  return hidden > 0
    ? <p className={styles.moreNotice}>Showing the first {visibleRowLimit}. Open the linked workspace to review all {total}.</p>
    : null;
}

export default async function OperationalHealthPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const requested = (await searchParams).event;
  const { event, permissions } = await resolveEventContext(requested);
  if (!canAccessOperationalHealth(permissions)) {
    return (
      <AccessRestricted
        title="Operational health is restricted"
        detail="This page only shows staff the event areas their role can resolve. Ask an event administrator if you need operational access."
      />
    );
  }

  const access = operationalHealthAccessFor(permissions);
  const health = await getOperationalHealth(event.id, access);
  const eventQuery = `event=${encodeURIComponent(event.id)}`;
  const refreshHref = `/more/health?${eventQuery}`;
  const financeHref = `/finance?${eventQuery}`;
  const communicationsHref = `/communications?${eventQuery}&view=deliveries`;
  const importsHref = `/imports?${eventQuery}`;
  const peopleHref = `/people?${eventQuery}`;
  const formHref = `/registration-builder?${eventQuery}`;
  const settingsHref = `/more/event-settings?${eventQuery}`;
  const capacityHref = permissions.includes("MANAGE_FORMS")
    ? formHref
    : permissions.includes("CONFIGURE_EVENT")
      ? settingsHref
      : peopleHref;

  return (
    <section className={`page-stack ${styles.workspace}`}>
      <div className="page-intro">
        <div>
          <p className="eyebrow">Exceptions, not another inbox</p>
          <h2>Operational health</h2>
          <p>See what may need attention for {event.name}, then go straight to the workspace that can resolve it. This page never changes event data.</p>
        </div>
        <div className={styles.introActions}>
          <Link className="secondary-button" href={`/more?${eventQuery}`}>Back to More</Link>
          <Link className="secondary-button" href={refreshHref}>
            <RefreshCw aria-hidden="true" size={15} />
            Refresh status
          </Link>
        </div>
      </div>

      <div className={styles.scopeNote}>
        <ShieldCheck aria-hidden="true" size={20} />
        <div>
          <strong>Only the areas your event role can resolve are shown.</strong>
          <p>Names, email addresses, private form answers, card details, provider messages, and import row contents stay out of this summary.</p>
        </div>
      </div>

      {health.summary.total === 0 && (
        <div className={styles.healthyState} role="status">
          <HeartPulse aria-hidden="true" size={22} />
          <div>
            <strong>Everything visible to your role looks healthy.</strong>
            <p>No current exceptions matched the checks below as of {timeLabel(health.generatedAt, event.timezone)}.</p>
          </div>
        </div>
      )}

      <section className={styles.summaryGrid} aria-label="Operational health summary">
        <article className={styles.summaryCard}>
          <strong>{health.summary.total}</strong>
          <span>Total items</span>
          <small>Across the areas you can manage</small>
        </article>
        <article className={`${styles.summaryCard} ${styles.summaryCardUrgent}`}>
          <strong>{health.summary.urgent}</strong>
          <span>Needs action</span>
          <small>Failed, rejected, or at limit</small>
        </article>
        <article className={`${styles.summaryCard} ${styles.summaryCardWatch}`}>
          <strong>{health.summary.watch}</strong>
          <span>Watch or follow up</span>
          <small>Delayed, balance due, or near limit</small>
        </article>
      </section>

      {access.finance && (
        <>
          <IssueSection
            icon={<CircleDollarSign aria-hidden="true" size={20} />}
            title="Square payment attempts"
            description={`Shows the newest Square attempt for an unpaid active registration when it failed or stayed processing for at least ${PAYMENT_STUCK_AFTER_MINUTES} minutes. Older failed attempts disappear after a newer attempt or full payment.`}
            count={health.paymentAttempts.length}
            emptyCopy="No current failed or stuck Square payment attempts."
          >
            <ul className={styles.issueList}>
              {health.paymentAttempts.slice(0, visibleRowLimit).map((issue) => (
                <li className={`${styles.issue} ${issue.severity === "URGENT" ? styles.urgent : ""}`} key={issue.id}>
                  <div className={styles.issueMain}>
                    <div className={styles.issueTitle}>
                      <strong>{issue.confirmationCode} · {money(issue.amountCents)}</strong>
                      <SeverityBadge severity={issue.severity} />
                    </div>
                    <p>
                      {issue.kind === "FAILED"
                        ? `Square attempt failed${issue.failureCode ? ` (${issue.failureCode})` : ""}.`
                        : `${words(issue.status)} for ${issue.ageMinutes} minutes without a final result.`}
                    </p>
                    <time dateTime={issue.occurredAt}>Last update {timeLabel(issue.occurredAt, event.timezone)}</time>
                  </div>
                  <ResolveLink href={`${financeHref}&registration=${encodeURIComponent(issue.registrationId)}`}>Review payment</ResolveLink>
                </li>
              ))}
            </ul>
            {hiddenRowsNotice(health.paymentAttempts.length)}
          </IssueSection>

          <IssueSection
            icon={<AlertTriangle aria-hidden="true" size={20} />}
            title="Registration balances"
            description="Active submitted and confirmed registrations with money still due. Successful refunds are added back to the remaining balance."
            count={health.balances.length}
            emptyCopy="Every active paid registration is currently paid in full."
          >
            <ul className={styles.issueList}>
              {health.balances.slice(0, visibleRowLimit).map((issue) => (
                <li className={styles.issue} key={issue.registrationId}>
                  <div className={styles.issueMain}>
                    <div className={styles.issueTitle}>
                      <strong>{issue.confirmationCode} · {money(issue.balanceCents)} due</strong>
                      <SeverityBadge severity={issue.severity} />
                    </div>
                    <p>{money(issue.paidCents)} received toward {money(issue.totalAmountCents)}.</p>
                    {issue.submittedAt && <time dateTime={issue.submittedAt}>Registered {timeLabel(issue.submittedAt, event.timezone)}</time>}
                  </div>
                  <ResolveLink href={`${financeHref}&filter=BALANCE&registration=${encodeURIComponent(issue.registrationId)}`}>Open balance</ResolveLink>
                </li>
              ))}
            </ul>
            {hiddenRowsNotice(health.balances.length)}
          </IssueSection>
        </>
      )}

      {access.communications && (
        <IssueSection
          icon={<MailWarning aria-hidden="true" size={20} />}
          title="Email delivery"
          description={`Shows the latest unretried failure, bounce, complaint, provider failure, or message still pending at least ${MESSAGE_OVERDUE_AFTER_MINUTES} minutes after it became available.`}
          count={health.messages.length}
          emptyCopy="No failed, rejected, or overdue email deliveries."
        >
          <ul className={styles.issueList}>
            {health.messages.slice(0, visibleRowLimit).map((issue) => (
              <li className={`${styles.issue} ${issue.severity === "URGENT" ? styles.urgent : ""}`} key={issue.id}>
                <div className={styles.issueMain}>
                  <div className={styles.issueTitle}>
                    <strong>{words(issue.templateKey)}{issue.confirmationCode ? ` · ${issue.confirmationCode}` : ""}</strong>
                    <SeverityBadge severity={issue.severity} />
                  </div>
                  <p>{issue.kind === "OVERDUE" ? `Pending for ${issue.ageMinutes} minutes.` : `${words(issue.kind)} delivery.`} {issue.attemptCount} {issue.attemptCount === 1 ? "attempt" : "attempts"} recorded.</p>
                  <time dateTime={issue.occurredAt}>Last relevant update {timeLabel(issue.occurredAt, event.timezone)}</time>
                </div>
                <ResolveLink href={communicationsHref}>Open deliveries</ResolveLink>
              </li>
            ))}
          </ul>
          {hiddenRowsNotice(health.messages.length)}
        </IssueSection>
      )}

      {access.imports && (
        <IssueSection
          icon={<FileWarning aria-hidden="true" size={20} />}
          title="Import review"
          description="Shows unfinished or failed import previews that contain row errors or warnings. Completed imports are treated as reviewed."
          count={health.imports.length}
          emptyCopy="No unfinished import previews have errors or warnings."
        >
          <ul className={styles.issueList}>
            {health.imports.slice(0, visibleRowLimit).map((issue) => (
              <li className={`${styles.issue} ${issue.severity === "URGENT" ? styles.urgent : ""}`} key={issue.id}>
                <div className={styles.issueMain}>
                  <div className={styles.issueTitle}>
                    <strong>{issue.fileName}</strong>
                    <SeverityBadge severity={issue.severity} />
                  </div>
                  <p>{words(issue.status)} · {issue.errors} {issue.errors === 1 ? "error" : "errors"} · {issue.warnings} {issue.warnings === 1 ? "warning" : "warnings"}.</p>
                  <time dateTime={issue.startedAt}>Started {timeLabel(issue.startedAt, event.timezone)}</time>
                </div>
                <ResolveLink href={importsHref}>Review import</ResolveLink>
              </li>
            ))}
          </ul>
          {hiddenRowsNotice(health.imports.length)}
        </IssueSection>
      )}

      {access.capacity && (
        <IssueSection
          icon={<Gauge aria-hidden="true" size={20} />}
          title="Capacity"
          description={`Shows overall event and limited-choice capacity at 100%, or within the final ${100 - CAPACITY_NEAR_PERCENT}% (at least the final place for a small limit). Unlimited and ranked-interest choices are not treated as capacity exceptions.`}
          count={health.capacity.length}
          emptyCopy="No configured event or choice limit is at or near capacity."
        >
          <ul className={styles.issueList}>
            {health.capacity.slice(0, visibleRowLimit).map((issue) => (
              <li className={`${styles.issue} ${issue.severity === "URGENT" ? styles.urgent : ""}`} key={issue.id}>
                <div className={styles.issueMain}>
                  <div className={styles.issueTitle}>
                    <strong>{issue.label}</strong>
                    <SeverityBadge severity={issue.severity} />
                  </div>
                  <p>{issue.detail} {issue.used} of {issue.limit} used · {issue.remaining} remaining · {issue.percentUsed}%.</p>
                </div>
                <ResolveLink href={capacityHref}>{permissions.includes("MANAGE_FORMS") ? "Open form" : permissions.includes("CONFIGURE_EVENT") ? "Open settings" : "Open registrations"}</ResolveLink>
              </li>
            ))}
          </ul>
          {hiddenRowsNotice(health.capacity.length)}
        </IssueSection>
      )}

      <details className={styles.rules}>
        <summary>How these checks work</summary>
        <ul>
          {access.finance && <li>A failed Square attempt is only current when it is the newest attempt and that active registration still has a balance.</li>}
          {access.communications && <li>An email failure is hidden after a retry exists; the retry becomes the current delivery record.</li>}
          {access.imports && <li>Import warnings and errors stay here until the preview is completed or replaced.</li>}
          {access.capacity && <li>Capacity uses active submitted or confirmed attendees and unreleased choice reservations.</li>}
          {permissions.includes("MANAGE_CHECK_IN") && <li>Offline check-in conflicts remain device-local and are resolved on the Check-in screen; no central conflict record exists yet.</li>}
          <li>This screen is read-only. Use the linked workspace for any reviewed correction.</li>
        </ul>
      </details>
    </section>
  );
}
