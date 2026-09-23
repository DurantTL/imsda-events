import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  CircleHelp,
  Clock3,
  ExternalLink,
  Eye,
  ListChecks,
  MapPin,
  Megaphone,
  QrCode,
  UsersRound,
} from "lucide-react";
import { AttendeeCommunityBoard } from "@/components/attendee-community-board";
import { BrandMark } from "@/components/brand-mark";
import { getCurrentSession } from "@/modules/access/current-session";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import {
  getAttendeeRetreatHub,
  getStaffRetreatHubPreview,
  type AttendeeRetreatHub,
} from "@/modules/attendee-accounts/retreat-hub-repository";
import {
  getAttendeeCommunity,
  getStaffCommunity,
} from "@/modules/community/repository";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Retreat hub",
  description: "Your event schedule, updates, resources, and assigned sessions.",
  robots: { index: false, follow: false, nocache: true },
};

function eventDateLabel(
  startsAt: string,
  endsAt: string,
  timeZone: string,
) {
  const dates = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
  return dates.formatRange(new Date(startsAt), new Date(endsAt));
}

function eventTimeLabel(
  startsAt: string,
  endsAt: string,
  timeZone: string,
) {
  const times = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
  return `${times.format(new Date(startsAt))} – ${times.format(new Date(endsAt))}`;
}

function paragraphs(body: string) {
  return body.split(/\n\s*\n/).map((entry) => entry.trim()).filter(Boolean);
}

export default async function AttendeeEventHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventSlug: string }>;
  searchParams: Promise<{ preview?: string }>;
}) {
  const [{ eventSlug }, query, attendeeSession, staffSession] = await Promise.all([
    params,
    searchParams,
    getCurrentAttendee(),
    getCurrentSession(),
  ]);
  const staffPreview = query.preview === "staff" && Boolean(staffSession.user);
  let hub: AttendeeRetreatHub;
  let staffPreviewEventId: string | null = null;
  let attendeeCommunity: NonNullable<Awaited<ReturnType<typeof getAttendeeCommunity>>> | null = null;
  let staffCommunity: NonNullable<Awaited<ReturnType<typeof getStaffCommunity>>> | null = null;
  if (staffPreview && staffSession.user) {
    const preview = await getStaffRetreatHubPreview(staffSession.user, eventSlug);
    if (!preview) notFound();
    hub = preview.hub;
    staffPreviewEventId = preview.eventId;
    staffCommunity = await getStaffCommunity(preview.eventId);
  } else {
    if (!attendeeSession.account) redirect("/account/sign-in");
    const attendeeHub = await getAttendeeRetreatHub(
      attendeeSession.account.verifiedEmail,
      eventSlug,
    );
    if (!attendeeHub) notFound();
    hub = attendeeHub;
    attendeeCommunity = await getAttendeeCommunity(attendeeSession.account, eventSlug);
  }
  const textSections = hub.contentSections.filter((section) => section.kind === "RICH_TEXT");
  const resourceSections = hub.contentSections.filter((section) => section.kind === "RESOURCE_LINKS");
  const staffTimeline = staffCommunity
    ? [
        ...hub.announcements
          .filter((announcement) => announcement.publishedAt)
          .map((announcement) => ({ kind: "OFFICIAL" as const, occurredAt: announcement.publishedAt!, announcement })),
        ...(staffCommunity.settings.isEnabled
          ? staffCommunity.posts.map((post) => ({ kind: "COMMUNITY" as const, occurredAt: post.createdAt, post }))
          : []),
      ].sort((left, right) => {
        const leftPinned = left.kind === "OFFICIAL" && Boolean(left.announcement.pinnedAt);
        const rightPinned = right.kind === "OFFICIAL" && Boolean(right.announcement.pinnedAt);
        if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
        return right.occurredAt.localeCompare(left.occurredAt);
      })
    : [];

  return (
    <main className="public-registration-page attendee-retreat-hub">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <a className="public-registration-brand public-event-brand-link" href="https://imsda.org/">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </a>
          <Link
            className="text-button"
            href={staffPreviewEventId
              ? `/overview?event=${encodeURIComponent(staffPreviewEventId)}`
              : staffSession.user
                ? "/overview"
                : "/account/registrations"}
          >
            <ArrowLeft size={15} aria-hidden="true" />
            {staffPreviewEventId || staffSession.user
              ? "Back to staff workspace"
              : "All registrations"}
          </Link>
        </div>
      </header>

      {staffPreviewEventId && (
        <section className="attendee-staff-preview-banner" role="status">
          <Eye size={20} aria-hidden="true" />
          <div>
            <strong>Staff preview of the attendee experience</strong>
            <p>Published shared content is live below. Personal registrations, assignments, balances, and QR passes are intentionally hidden in preview mode.</p>
          </div>
        </section>
      )}

      <section className="public-registration-hero attendee-hub-hero">
        <div>
          <p className="public-registration-eyebrow">
            {staffPreviewEventId ? "Staff preview · Attendee experience" : "Your attendee hub"}
          </p>
          <h1>{hub.event.name}</h1>
          <p>Schedule, updates, resources, passes and assigned sessions in one signed-in place.</p>
        </div>
        <div className="public-registration-event-details">
          <span><CalendarDays size={17} aria-hidden="true" /> {eventDateLabel(hub.event.startsAt, hub.event.endsAt, hub.event.timezone)}</span>
          <span><Clock3 size={17} aria-hidden="true" /> {eventTimeLabel(hub.event.startsAt, hub.event.endsAt, hub.event.timezone)}</span>
          <span><MapPin size={17} aria-hidden="true" /> {hub.event.location ?? "Location details coming soon"}</span>
        </div>
      </section>

      <div className="attendee-hub-layout">
        <div className="attendee-hub-main">
          <section className="public-manage-card attendee-hub-registration-card">
            <div className="public-manage-card-heading">
              <p className="public-registration-eyebrow">Your party</p>
              <h2>Registration and arrival</h2>
            </div>
            {staffPreviewEventId ? (
              <div className="attendee-preview-private-placeholder">
                <Eye size={20} aria-hidden="true" />
                <div>
                  <strong>Personal registration details appear here for attendees.</strong>
                  <p>Confirmation, party names, check-in state, balances, and QR passes are hidden from this shared staff preview.</p>
                </div>
              </div>
            ) : hub.registrations.map((registration) => (
              <article key={registration.id}>
                <header>
                  <strong>Confirmation <span translate="no">{registration.confirmationCode}</span></strong>
                  <span>{registration.status.toLowerCase()}</span>
                </header>
                <ul>
                  {registration.attendees.map((attendee) => (
                    <li key={attendee.id}>
                      <UsersRound size={16} aria-hidden="true" />
                      <span translate="no">{attendee.name}</span>
                      {attendee.checkedInAt
                        ? <small><CheckCircle2 size={14} aria-hidden="true" /> Checked in</small>
                        : <small><QrCode size={14} aria-hidden="true" /> Open the pass below at check-in</small>}
                    </li>
                  ))}
                </ul>
                <details className="attendee-hub-pass-details">
                  <summary><QrCode size={16} aria-hidden="true" /> Show attendee QR passes</summary>
                  <div className="public-attendee-pass-grid">
                    {registration.attendees.map((attendee) => (
                      <article className="public-attendee-pass" key={attendee.id}>
                        <div className="public-attendee-pass-heading">
                          <span><QrCode size={19} aria-hidden="true" /></span>
                          <strong translate="no">{attendee.name}</strong>
                        </div>
                        {/* Private dynamic image; the response explicitly disables caching. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          alt={`QR event pass for ${attendee.name}`}
                          height={280}
                          loading="lazy"
                          src={`/api/attendee/registrations/${encodeURIComponent(registration.id)}/attendee-passes/${encodeURIComponent(attendee.id)}/qr`}
                          width={280}
                        />
                      </article>
                    ))}
                  </div>
                </details>
              </article>
            ))}
          </section>

          <section className="public-manage-card attendee-hub-assignments">
            <div className="public-manage-card-heading">
              <p className="public-registration-eyebrow">Personal schedule</p>
              <h2>Your assigned sessions</h2>
            </div>
            {staffPreviewEventId ? (
              <p className="public-manage-empty">Each attendee sees only her own published session assignments here. Staff preview does not impersonate a registration.</p>
            ) : hub.assignmentRuns.length > 0 ? (
              <div className="attendee-hub-assignment-list">
                {hub.assignmentRuns.map((run) => (
                  <article key={run.id}>
                    <header><ListChecks size={18} aria-hidden="true" /><strong>{run.fieldLabel}</strong></header>
                    {run.assignments.map((assignment) => (
                      <div key={assignment.attendeeId}>
                        <span>{assignment.attendeeName}</span>
                        <strong>{assignment.option ?? "Assignment pending"}</strong>
                        {assignment.preferenceRank && <small>Choice {assignment.preferenceRank}</small>}
                      </div>
                    ))}
                  </article>
                ))}
              </div>
            ) : (
              <p className="public-manage-empty">Session assignments will appear here after the event team publishes the reviewed assignment runs.</p>
            )}
          </section>

          {attendeeCommunity && (
            <AttendeeCommunityBoard
              community={attendeeCommunity}
              announcements={hub.announcements}
            />
          )}

          {staffCommunity && (
            <section className="public-manage-card attendee-community-board attendee-community-staff-preview">
              <div className="public-manage-card-heading">
                <UsersRound size={20} aria-hidden="true" />
                <div>
                  <p className="public-registration-eyebrow">Community preview</p>
                  <h2>{staffCommunity.eventName} Community</h2>
                </div>
              </div>
              <p>
                {staffCommunity.settings.isEnabled
                  ? "Attendee discussion is enabled. This preview shows shared posts without impersonating a registrant."
                  : "Attendee discussion is currently disabled."}
              </p>
              {staffTimeline.length > 0 ? (
                <div className="attendee-community-posts attendee-timeline-items">
                  {staffTimeline.map((item) => item.kind === "OFFICIAL" ? (
                    <article className={`attendee-timeline-official is-${item.announcement.priority.toLowerCase()}`} key={`announcement:${item.announcement.id}`}>
                      <header><div><Megaphone size={15} aria-hidden="true" /><strong>Official update</strong><small>{item.announcement.priority.toLowerCase()}</small></div><time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleString()}</time></header>
                      <h3>{item.announcement.title}</h3><p>{item.announcement.body}</p>
                    </article>
                  ) : (
                    <article className={`attendee-community-post is-${item.post.status.toLowerCase()}`} key={`post:${item.post.id}`}>
                      <header><strong>{item.post.authorName}</strong><time dateTime={item.post.createdAt}>{new Date(item.post.createdAt).toLocaleString()}</time></header>
                      <p>{item.post.status === "PUBLISHED" ? item.post.body : "This post is not visible to attendees."}</p>
                      {item.post.replies.filter((reply) => reply.status === "PUBLISHED").map((reply) => (
                        <article className="community-staff-reply" key={reply.id}>
                          <strong>{reply.authorName}</strong><p>{reply.body}</p>
                        </article>
                      ))}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="public-manage-empty">No shared timeline updates are visible.</p>
              )}
              <Link className="secondary-button" href={`/community?event=${encodeURIComponent(staffCommunity.eventId)}`}>
                Open moderation controls
              </Link>
            </section>
          )}

          {textSections.map((section) => (
            <section className="public-manage-card attendee-hub-content" key={section.id}>
              <div className="public-manage-card-heading"><h2>{section.title}</h2></div>
              {paragraphs(section.body).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
            </section>
          ))}
        </div>

        <aside className="attendee-hub-side">
          {resourceSections.map((section) => (
            <section className="public-manage-card attendee-hub-resources" key={section.id}>
              <div className="public-manage-card-heading"><h2>{section.title}</h2></div>
              <ul>
                {section.links.map((link, index) => (
                  <li key={`${section.id}:${index}`}>
                    <a
                      href={link.assetId
                        ? `/api/public/events/${encodeURIComponent(hub.event.slug)}/assets/${encodeURIComponent(link.assetId)}`
                        : link.url ?? "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span><strong>{link.label}</strong>{link.description && <small>{link.description}</small>}</span>
                      <ExternalLink size={15} aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <section className="public-manage-help-card">
            <span><CircleHelp size={23} aria-hidden="true" /></span>
            <p className="public-registration-eyebrow">During the retreat</p>
            <h2>Need help?</h2>
            <p>{hub.event.supportContact ?? "Contact the event team at the registration desk."}</p>
          </section>
        </aside>
      </div>
    </main>
  );
}
