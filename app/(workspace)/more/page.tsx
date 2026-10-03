import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { DetailsOpenOnHash } from "@/components/details-open-on-hash";
import { EventActivityPanel } from "@/components/event-activity-panel";
import { EventModuleToggle } from "@/components/event-module-toggle";
import { MoreTaskSearch } from "@/components/more-task-search";
import {
  applicabilityLabels,
  buildEventModulesView,
  groupEnabledModules,
  healthStripState,
} from "@/components/event-modules-page-model";
import { buildMoreDirectoryCards, moreDirectoryGroupLabels, moreDirectoryGroupOrder, staffPageTitles } from "@/components/staff-navigation";
import { resolveStaffViewer } from "@/modules/club-forms/access";
import { listRecentAuditActivity } from "@/modules/audit/audit-service";
import { moduleState } from "@/modules/event-modules/service";
import { resolveEventContext } from "@/modules/events/selection";
import { eventKindFromAudience, selectActivity } from "@/modules/events/settings-sections";
import { resolveClubOversight } from "@/modules/club-rosters/event-oversight";
import { canAccessOperationalHealth, operationalHealthAccessFor } from "@/modules/operations/access";
import { getOperationalHealth } from "@/modules/operations/repository";

const signInAnchors = ["two-step-verification", "passkeys"] as const;

/**
 * `/more` is the Event modules page (#741): which features this event uses and,
 * for a system administrator, the switch. The destination keeps its one staff
 * name, "More" (#685), in the tab, the header and the page title.
 */
export const metadata: Metadata = { title: staffPageTitles.more };

export default async function MorePage({ searchParams }: { searchParams: Promise<{ event?: string; activity?: string }> }) {
  const { event: requested, activity: activityFilter } = await searchParams;
  const { event, permissions, user } = await resolveEventContext(requested);
  const { allowed: clubOversight, clubEvent } = await resolveClubOversight(event.id);
  const isSystemAdmin = user.globalRole === "SYSTEM_ADMIN";
  const kind = eventKindFromAudience(clubEvent ? "CLUB" : "GENERAL");
  // Activity is filtered to the event type (#624); "?activity=all" shows every entry.
  const showAllActivity = activityFilter === "all";
  const allActivity = permissions.includes("VIEW_REPORTS") ? await listRecentAuditActivity(event.id, 40) : [];
  const activity = selectActivity(allActivity, kind, showAllActivity);
  const eventQuery = `?event=${event.id}`;

  // Every card with its permission result and no module hiding, from the same
  // source the launcher and the desktop sidebar read (see
  // `tests/mobile-directory-parity.test.ts`). The page view then applies the
  // module rules: enabled modules for anyone who may open them, disabled ones
  // for a system administrator only. A module being on never grants access.
  const cards = buildMoreDirectoryCards({
    permissions,
    clubOversight,
    clubEvent,
    isSystemAdmin,
    clubFormsAccess: Boolean(await resolveStaffViewer()),
    eventQuery,
  });
  // Rows plus the data a module works on, the same state the launcher reads, so the two agree.
  const state = await moduleState(event.id);
  const view = buildEventModulesView({ cards, stored: state.stored, effective: state.effective, dataPresent: state.dataPresent, dataForced: state.dataForced, isSystemAdmin, audience: clubEvent ? "CLUB" : "GENERAL" });

  // The health strip reuses the Operational health data for staff who may open it; nobody else gets a strip.
  const health = canAccessOperationalHealth(permissions)
    ? healthStripState((await getOperationalHealth(event.id, operationalHealthAccessFor(permissions))).summary)
    : null;

  return (
    <section className="page-stack event-modules-page">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Event modules</p>
          <h2 className="event-modules-heading">Customize this event</h2>
          <p>Turn features on or off for {event.name}</p>
          {!view.canToggle && <p className="quiet-copy">A system administrator turns features on or off. These are the ones this event uses.</p>}
        </div>
      </div>

      {health && (
        <section className="event-modules-health" data-state={health.state} aria-label="Event health">
          {health.state === "clear" ? <CheckCircle2 aria-hidden="true" size={20} /> : <AlertTriangle aria-hidden="true" size={20} />}
          <p role="status">{health.message}</p>
          <Link className="secondary-button" href={`/more/health${eventQuery}`}>Operational health</Link>
        </section>
      )}

      {view.enabled.length === 0 && <p className="quiet-copy">No optional features are turned on for this event.</p>}
      {/* Optional task search (#743): filters the cards and tools below by name, in the browser. */}
      {/* The search decides in the browser whether enough tasks are drawn to be worth showing (phone and desktop show different lists). */}
      {(view.enabled.length + view.tools.length) > 0 && <MoreTaskSearch containerId="more-task-groups" />}
      <div className="more-task-groups" id="more-task-groups">
      {groupEnabledModules(view.enabled).map(({ group, entries }) => (
        <section aria-label={moreDirectoryGroupLabels[group]} className="foundation-group" data-task-group key={group}>
          <h2 className="foundation-group-label">{moreDirectoryGroupLabels[group]}</h2>
          <div className="foundation-grid">
            {entries.map(({ definition, card, canToggle, dataReason }) => (
              <article className="panel foundation-card event-module-card" data-module={definition.key} data-task-name={card.title} key={definition.key}>
                <Link className="event-module-card-link" href={card.href}>
                  <span><card.icon aria-hidden="true" size={21} /></span>
                  <h3>{card.title}</h3>
                  <p>{card.description}</p>
                  <small>{card.cta}</small>
                </Link>
                {canToggle && (
                  <EventModuleToggle enabled eventId={event.id} moduleKey={definition.key} title={definition.title} />
                )}
                {dataReason && <p className="quiet-copy event-module-reason">{dataReason}</p>}
              </article>
            ))}
          </div>
        </section>
      ))}

      {view.leftOver.length > 0 && (
        <section className="panel event-modules-leftover" aria-label="Left over from a change of event type">
          <h2>Left over from a change of event type</h2>
          <p className="quiet-copy">These are turned on but do not apply to this kind of event. Turning them off keeps their data.</p>
          <div className="foundation-grid">
            {view.leftOver.map((definition) => (
              <article className="panel foundation-card event-module-card" data-module={definition.key} key={definition.key}>
                <h3>{definition.title}</h3>
                <p>{definition.description}</p>
                <EventModuleToggle enabled eventId={event.id} moduleKey={definition.key} title={definition.title} />
              </article>
            ))}
          </div>
        </section>
      )}

      {view.disabled.length > 0 && (
        <details className="panel activity-disclosure event-modules-off" id="not-used-by-this-event">
          <summary><h2>Not used by this event</h2><small>{view.disabled.length} off. Turning one on keeps nothing hidden; turning one off never deletes data.</small></summary>
          <div className="foundation-grid">
            {view.disabled.map(({ definition, canEnable }) => (
              <article className="panel foundation-card event-module-card" data-module={definition.key} key={definition.key}>
                <h3>{definition.title}</h3>
                <p>{definition.description}</p>
                <small>{applicabilityLabels[definition.appliesTo]}</small>
                {canEnable
                  ? <EventModuleToggle enabled={false} eventId={event.id} moduleKey={definition.key} title={definition.title} />
                  : <p className="quiet-copy event-module-reason">Does not apply to this event.</p>}
              </article>
            ))}
          </div>
        </details>
      )}

      {/* Phone fallback (#741): the launcher is a bottom sheet there, but this page keeps every universal tool too, so nothing depends on scripts. Hidden on desktop by CSS. */}
      {view.tools.length > 0 && (
        <section aria-label="All tools" className="more-page-tools" data-task-group>
          <h2 className="foundation-group-label">All tools</h2>
          {moreDirectoryGroupOrder
            .map((group) => ({ group, tools: view.tools.filter((card) => card.group === group) }))
            .filter(({ tools }) => tools.length > 0)
            .map(({ group, tools }) => (
              <section aria-label={moreDirectoryGroupLabels[group]} className="foundation-group" data-task-group key={group}>
                <h3 className="foundation-group-label">{moreDirectoryGroupLabels[group]}</h3>
                <div className="foundation-grid">
                  {tools.map((card) => (
                    <Link className="panel foundation-card" data-task-name={card.title} href={card.href} key={card.key}>
                      <span><card.icon aria-hidden="true" size={21} /></span>
                      <h3>{card.title}</h3>
                      <p>{card.description}</p>
                      <small>{card.cta}</small>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
        </section>
      )}
      </div>

      {permissions.includes("VIEW_REPORTS") && <EventActivityPanel eventId={event.id} kind={kind} selection={activity} showAll={showAllActivity} />}
      {/* Two-step verification, passkeys and signed-in devices are on the one Edit profile page (#543, #741). The anchors keep older links to them landing here. */}
      <DetailsOpenOnHash anchors={signInAnchors} className="panel activity-disclosure" id="two-step-verification">
        <summary><h2>Sign-in settings</h2><small>Two-step verification, passkeys and signed-in devices</small></summary>
        <span id="passkeys" />
        <p className="quiet-copy">Set up two-step verification and passkeys, or review your signed-in devices, on your profile page.</p>
        <Link className="secondary-button" href="/profile" aria-label="Edit profile: two-step verification, passkeys and signed-in devices">Edit profile</Link>
      </DetailsOpenOnHash>
      {process.env.NODE_ENV !== "production" && <section className="panel review-gate"><div><p className="eyebrow">Testing status</p><h2>This local workspace uses test data</h2><p>Changes stay in the local IMSDA Events database. Live card charging and external delivery remain off until their configured test connections are ready.</p></div><span className="review-badge">Local testing</span></section>}
    </section>
  );
}
