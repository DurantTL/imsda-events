import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { Activity, Award, ChartNoAxesCombined, FileText, FileUp, HeartPulse, ListChecks, MessagesSquare, PanelsTopLeft, Settings2, Tent, TicketPercent, UserCog, UsersRound, type LucideIcon } from "lucide-react";
import { MfaManager, type MfaStatus } from "@/components/mfa-manager";
import { SessionManager } from "@/components/session-manager";
import { StaffPasskeyManager } from "@/components/staff-passkey-manager";
import { getMfaStatus } from "@/modules/access/mfa-service";
import { getPasskeySettings } from "@/modules/access/passkeys";
import { listUserSessions, SESSION_COOKIE_NAME, SESSION_IDLE_TIMEOUT_SECONDS } from "@/modules/access/session-store";
import { listRecentAuditActivity } from "@/modules/audit/audit-service";
import { resolveEventContext } from "@/modules/events/selection";
import { canAccessOperationalHealth } from "@/modules/operations/access";
import { resolveClubOversight } from "@/modules/club-rosters/event-oversight";
import { canManageProgramAssignments } from "@/modules/program-assignments/access";
import { canManageClubAssignments } from "@/modules/club-registrations/assignments-access";

export const metadata: Metadata = { title: "More" };

/** Related destinations sit together (#428): Events, Clubs and churches, People, Finance, Communications, System. */
const foundationGroupOrder = ["events", "clubs", "people", "finance", "communications", "system"] as const;
type FoundationGroup = (typeof foundationGroupOrder)[number];
const foundationGroupLabels: Record<FoundationGroup, string> = {
  events: "Events",
  clubs: "Clubs and churches",
  people: "People",
  finance: "Finance",
  communications: "Communications",
  system: "System",
};

type FoundationCard = {
  key: string;
  group: FoundationGroup;
  allowed: boolean;
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
  cta: string;
};

export default async function MorePage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions, user } = await resolveEventContext(requested);
  const activity = permissions.includes("VIEW_REPORTS") ? await listRecentAuditActivity(event.id) : [];
  const sessionToken = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const sessions = await listUserSessions(user.id, sessionToken);
  const mfaStatus = await getMfaStatus(user.id) as MfaStatus;
  const passkeySettings = await getPasskeySettings(user);
  const { allowed: clubOversight, clubEvent } = await resolveClubOversight(event.id);
  const q = `?event=${event.id}`;

  const cards: FoundationCard[] = [
    { key: "event-settings", group: "events", allowed: permissions.includes("CONFIGURE_EVENT"), href: `/more/event-settings${q}`, icon: Settings2, title: "Event settings", description: "Edit dates, location, capacity, registration availability, and publishing.", cta: "Open settings" },
    { key: "honors", group: "events", allowed: permissions.includes("CONFIGURE_EVENT"), href: `/more/honors${q}`, icon: Award, title: "Honors Weekend classes", description: "Name this site's sessions and set the honor classes, seats, and age limits it offers.", cta: "Set up classes" },
    { key: "event-content", group: "events", allowed: permissions.includes("CONFIGURE_EVENT"), href: `/more/event-content${q}`, icon: FileText, title: "Event page", description: "Speaker bios, seminar descriptions, lodging, schedules, and downloads shown publicly.", cta: "Edit page" },
    { key: "registration-builder", group: "events", allowed: permissions.includes("MANAGE_FORMS"), href: `/registration-builder${q}`, icon: PanelsTopLeft, title: "Registration form", description: "Build, test, and publish the form people use to register.", cta: "Open form builder" },
    { key: "program-assignments", group: "events", allowed: canManageProgramAssignments(permissions), href: `/more/program-assignments${q}`, icon: ListChecks, title: "Seminar assignments", description: "Turn attendee rankings and room limits into reviewed, printable session rosters.", cta: "Preview assignments" },
    { key: "clubs", group: "clubs", allowed: clubOversight, href: `/more/clubs${q}`, icon: UsersRound, title: "Clubs", description: "Every registered club's roster (ages only) and all clubs' monthly reports, view only.", cta: "Open clubs" },
    { key: "club-assignments", group: "clubs", allowed: clubEvent && canManageClubAssignments(permissions), href: `/more/club-assignments${q}`, icon: Tent, title: "Club assignments", description: "Set each registered club's campsite, duty, and activity, then email directors after review.", cta: "Assign clubs" },
    { key: "imports", group: "people", allowed: permissions.includes("MANAGE_IMPORTS"), href: `/imports${q}`, icon: FileUp, title: "Import registrations", description: "Preview a CSV, review every change, then import approved records.", cta: "Open imports" },
    { key: "staff", group: "people", allowed: permissions.includes("MANAGE_STAFF"), href: `/staff${q}`, icon: UserCog, title: "Team access", description: "Add staff and choose what each person can do for this event.", cta: "Manage team" },
    { key: "promo-codes", group: "finance", allowed: permissions.includes("MANAGE_FINANCE"), href: `/more/promo-codes${q}`, icon: TicketPercent, title: "Promo codes", description: "Create bounded registration discounts, schedule dates, and review use limits.", cta: "Manage discounts" },
    { key: "community", group: "communications", allowed: permissions.includes("MANAGE_COMMUNICATIONS"), href: `/community${q}`, icon: MessagesSquare, title: "Attendee community", description: "Open or pause discussion, review attendee reports, and moderate posts and replies.", cta: "Moderate community" },
    { key: "health", group: "system", allowed: canAccessOperationalHealth(permissions), href: `/more/health${q}`, icon: HeartPulse, title: "Operational health", description: "Review failed or delayed work, open balances, import exceptions, and capacity warnings.", cta: "Review exceptions" },
    { key: "reports", group: "system", allowed: permissions.includes("VIEW_REPORTS"), href: `/more/reports${q}`, icon: ChartNoAxesCombined, title: "Operational reports", description: "Print active attendee rosters and review meal, housing, and ranked seminar totals.", cta: "Open reports" },
  ];
  const visibleGroups = foundationGroupOrder
    .map((group) => ({ group, cards: cards.filter((card) => card.group === group && card.allowed) }))
    .filter(({ cards: groupCards }) => groupCards.length > 0);

  return (
    <section className="page-stack">
      <div className="page-intro"><div><p className="eyebrow">Event administration</p><h2>Settings & activity</h2><p>Choose a task or review recent changes for {event.name}.</p></div></div>
      {visibleGroups.map(({ group, cards: groupCards }) => (
        <section aria-label={foundationGroupLabels[group]} className="foundation-group" key={group}>
          <h2 className="foundation-group-label">{foundationGroupLabels[group]}</h2>
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
      ))}
      {permissions.includes("VIEW_REPORTS") && <section className="panel"><div className="section-heading"><div><p className="eyebrow">Audit trail</p><h2>Recent activity</h2></div><span className="count-badge"><Activity aria-hidden="true" size={16} /> {activity.length} {activity.length === 1 ? "entry" : "entries"}</span></div><div className="activity-list">{activity.map((entry) => <article className="activity-row" key={entry.id}><span className="activity-icon"><Activity aria-hidden="true" size={16} /></span><span><strong>{entry.summary}</strong><small>{entry.actorName} · {new Date(entry.createdAt).toLocaleString()}</small></span><code>{entry.action}</code></article>)}{activity.length === 0 && <p className="quiet-copy">No activity has been recorded for this event.</p>}</div></section>}
      <MfaManager initialStatus={mfaStatus} />
      <StaffPasskeyManager available={passkeySettings.available} initialPasskeys={passkeySettings.passkeys} />
      <SessionManager initialSessions={sessions} idleTimeoutSeconds={SESSION_IDLE_TIMEOUT_SECONDS} />
      {process.env.NODE_ENV !== "production" && <section className="panel review-gate"><div><p className="eyebrow">Testing status</p><h2>This local workspace uses test data</h2><p>Changes stay in the local IMSDA Events database. Live card charging and external delivery remain off until their configured test connections are ready.</p></div><span className="review-badge">Local testing</span></section>}
    </section>
  );
}
