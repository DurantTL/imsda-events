import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { DetailsOpenOnHash } from "@/components/details-open-on-hash";
import { EventActivityPanel } from "@/components/event-activity-panel";
import { SessionManager } from "@/components/session-manager";
import { buildMoreDirectoryCards, moreDirectoryGroupLabels, moreDirectoryGroupOrder } from "@/components/staff-navigation";
import { listUserSessions, SESSION_COOKIE_NAME, SESSION_IDLE_TIMEOUT_SECONDS } from "@/modules/access/session-store";
import { resolveStaffViewer } from "@/modules/club-forms/access";
import { listRecentAuditActivity } from "@/modules/audit/audit-service";
import { resolveEventContext } from "@/modules/events/selection";
import { eventKindFromAudience, moreCardApplies, selectActivity } from "@/modules/events/settings-sections";
import { resolveClubOversight } from "@/modules/club-rosters/event-oversight";
import { staffPageTitles } from "@/components/staff-navigation";

const signInAnchors = ["two-step-verification", "passkeys"] as const;

export const metadata: Metadata = { title: staffPageTitles.more };

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
  const activity = selectActivity(allActivity, kind, showAllActivity);

  // Every page the desktop sidebar can reach that isn't one of the five
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
      <div className="page-intro"><div><p className="eyebrow">Event administration</p><h2 className="duplicate-page-title">{staffPageTitles.more}</h2><p>Choose a task or review recent changes for {event.name}.</p></div></div>
      {renderGroups(visibleGroups)}
      {otherGroups.length > 0 && (
        <details className="panel activity-disclosure">
          <summary><h2>More settings</h2><small>Tools that do not apply to {kind === "club" ? "club" : "general"} events. Nothing is removed.</small></summary>
          <div className="page-stack">{renderGroups(otherGroups)}</div>
        </details>
      )}
      {permissions.includes("VIEW_REPORTS") && <EventActivityPanel eventId={event.id} kind={kind} selection={activity} showAll={showAllActivity} />}
      {/* Two-step verification and passkeys moved to the one Edit profile page (#543). The anchors keep older links to them landing here. */}
      <DetailsOpenOnHash anchors={signInAnchors} className="panel activity-disclosure" id="two-step-verification">
        <summary><h2>Sign-in settings</h2><small>Two-step verification and passkeys</small></summary>
        <span id="passkeys" />
        <p className="quiet-copy">Set up two-step verification and passkeys on your profile page.</p>
        <Link className="secondary-button" href="/profile" aria-label="Edit profile: two-step verification and passkeys">Edit profile</Link>
      </DetailsOpenOnHash>
      <details className="panel activity-disclosure">
        <summary><h2>Your signed-in devices</h2><small>Review or end other sessions</small></summary>
        <SessionManager initialSessions={sessions} idleTimeoutSeconds={SESSION_IDLE_TIMEOUT_SECONDS} />
      </details>
      {process.env.NODE_ENV !== "production" && <section className="panel review-gate"><div><p className="eyebrow">Testing status</p><h2>This local workspace uses test data</h2><p>Changes stay in the local IMSDA Events database. Live card charging and external delivery remain off until their configured test connections are ready.</p></div><span className="review-badge">Local testing</span></section>}
    </section>
  );
}
