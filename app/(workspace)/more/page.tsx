import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { Activity } from "lucide-react";
import { SessionManager } from "@/components/session-manager";
import { buildMoreDirectoryCards, moreDirectoryGroupLabels, moreDirectoryGroupOrder } from "@/components/staff-navigation";
import { listUserSessions, SESSION_COOKIE_NAME, SESSION_IDLE_TIMEOUT_SECONDS } from "@/modules/access/session-store";
import { resolveStaffViewer } from "@/modules/club-forms/access";
import { listRecentAuditActivity } from "@/modules/audit/audit-service";
import { resolveEventContext } from "@/modules/events/selection";
import { eventKindFromAudience, filterActivityForKind, moreCardApplies } from "@/modules/events/settings-sections";
import { resolveClubOversight } from "@/modules/club-rosters/event-oversight";

export const metadata: Metadata = { title: "More" };

export default async function MorePage({ searchParams }: { searchParams: Promise<{ event?: string; activity?: string }> }) {
  const { event: requested, activity: activityFilter } = await searchParams;
  const { event, permissions, user } = await resolveEventContext(requested);
  const sessionToken = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const sessions = await listUserSessions(user.id, sessionToken);
  const { allowed: clubOversight, clubEvent } = await resolveClubOversight(event.id);
  const isSystemAdmin = user.globalRole === "SYSTEM_ADMIN";
  const kind = eventKindFromAudience(clubEvent ? "CLUB" : "GENERAL");
  // Activity is filtered to the event type (#624); "?activity=all" shows every entry.
  const showAllActivity = activityFilter === "all";
  const allActivity = permissions.includes("VIEW_REPORTS") ? await listRecentAuditActivity(event.id, 40) : [];
  const activity = (showAllActivity ? allActivity : filterActivityForKind(allActivity, kind)).slice(0, 12);
  const activityFiltered = allActivity.length > activity.length && !showAllActivity;

  // Every page the desktop sidebar can reach that isn't one of the six
  // bottom tabs (#475): built from `buildMoreDirectoryCards`, the same
  // permission and navigation source `AppShell`'s sidebar reads, so the two
  // can't drift — see `tests/mobile-directory-parity.test.ts`.
  const cards = buildMoreDirectoryCards({
    permissions,
    clubOversight,
    clubEvent,
    isSystemAdmin,
    clubFormsAccess: Boolean(await resolveStaffViewer()),
    eventQuery: `?event=${event.id}`,
  });
  const allowedCards = cards.filter((card) => card.allowed);
  const groupsFor = (list: typeof allowedCards) => moreDirectoryGroupOrder
    .map((group) => ({ group, cards: list.filter((card) => card.group === group) }))
    .filter(({ cards: groupCards }) => groupCards.length > 0);
  // Cards that do not apply to this event type are collapsed, never removed (#624).
  const visibleGroups = groupsFor(allowedCards.filter((card) => moreCardApplies(card.key, kind)));
  const otherGroups = groupsFor(allowedCards.filter((card) => !moreCardApplies(card.key, kind)));

  const renderGroups = (groups: typeof visibleGroups) => groups.map(({ group, cards: groupCards }) => (
    <section aria-label={moreDirectoryGroupLabels[group]} className="foundation-group" key={group}>
      <h2 className="foundation-group-label">{moreDirectoryGroupLabels[group]}</h2>
      <div className="foundation-grid">
        {groupCards.map((card) => (
          <Link className="panel foundation-card" href={card.href} key={card.key}>
            <span><card.icon aria-hidden="true" size={21} /></span>
            <h3>{card.title}</h3>
            <p>{card.description}</p>
            <small>{card.cta}</small>
          </Link>
        ))}
      </div>
    </section>
  ));

  return (
    <section className="page-stack">
      <div className="page-intro"><div><p className="eyebrow">Event administration</p><h2>Settings & activity</h2><p>Choose a task or review recent changes for {event.name}.</p></div></div>
      {renderGroups(visibleGroups)}
      {otherGroups.length > 0 && (
        <details className="panel activity-disclosure">
          <summary><strong>More settings</strong><small>Tools that do not apply to {kind === "club" ? "club" : "general"} events. Nothing is removed.</small></summary>
          <div className="page-stack">{renderGroups(otherGroups)}</div>
        </details>
      )}
      {permissions.includes("VIEW_REPORTS") && <section className="panel"><div className="section-heading"><div><p className="eyebrow">Audit trail</p><h2>Recent activity</h2></div><span className="count-badge"><Activity aria-hidden="true" size={16} /> {activity.length} {activity.length === 1 ? "entry" : "entries"}</span></div><div className="activity-list">{activity.map((entry) => <article className="activity-row" key={entry.id}><span className="activity-icon"><Activity aria-hidden="true" size={16} /></span><span><strong>{entry.summary}</strong><small>{entry.actorName} · {new Date(entry.createdAt).toLocaleString()}</small></span><code>{entry.action}</code></article>)}{activity.length === 0 && <p className="quiet-copy">No activity has been recorded for this event.</p>}</div>{activityFiltered && <p className="quiet-copy">Showing activity for {kind === "club" ? "club" : "general"} events. <Link href={`/more?event=${event.id}&activity=all`}>Show all activity</Link></p>}{showAllActivity && <p className="quiet-copy"><Link href={`/more?event=${event.id}`}>Show only {kind === "club" ? "club" : "general"} event activity</Link></p>}</section>}
      {/* Two-step verification and passkeys moved to the one Edit profile page (#543). The anchors keep older links to them landing here. */}
      <details className="panel activity-disclosure" id="two-step-verification">
        <summary><strong>Sign-in settings</strong><small>Two-step verification and passkeys</small></summary>
        <span id="passkeys" />
        <p className="quiet-copy">Set up two-step verification and passkeys on your profile page.</p>
        <Link className="secondary-button" href="/profile">Edit profile</Link>
      </details>
      <details className="activity-disclosure">
        <summary><strong>Your signed-in devices</strong><small>Review or end other sessions</small></summary>
        <SessionManager initialSessions={sessions} idleTimeoutSeconds={SESSION_IDLE_TIMEOUT_SECONDS} />
      </details>
      {process.env.NODE_ENV !== "production" && <section className="panel review-gate"><div><p className="eyebrow">Testing status</p><h2>This local workspace uses test data</h2><p>Changes stay in the local IMSDA Events database. Live card charging and external delivery remain off until their configured test connections are ready.</p></div><span className="review-badge">Local testing</span></section>}
    </section>
  );
}
