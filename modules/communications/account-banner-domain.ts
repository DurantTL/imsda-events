import { hasEventEnded } from "@/modules/events/lifecycle";
import {
  isExactAllAttendeesAudience,
  publicAnnouncementPriorityRank,
  type PublicAnnouncementPriority,
} from "@/modules/events/public-domain";

/**
 * Which published announcements an account banner may show (#590). The
 * audience rule is the public event page's (`isExactAllAttendeesAudience`);
 * the attendee event hub itself applies no audience filter. This adds the
 * banner placement, the event-ended cut-off and the ordering.
 */

/** Blank-line paragraph split, shared with the attendee event hub. */
export function splitParagraphs(body: string) {
  return body.split(/\n\s*\n/).map((entry) => entry.trim()).filter(Boolean);
}

export type AccountBannerCandidate = {
  id: string;
  title: string;
  body: string;
  audience: unknown;
  placement: string;
  status: string;
  priority: PublicAnnouncementPriority;
  publishedAt: Date | null;
  pinnedAt: Date | null;
  event: { name: string; slug: string; timezone: string; endsAt: Date | null };
  /** Set when the account has its own active registration for the event. */
  hasOwnRegistration: boolean;
  /** A directed or deputised club with an active club registration, if any. */
  clubOrganizationId: string | null;
  eventId: string;
};

export type AccountBannerAnnouncement = {
  id: string;
  title: string;
  body: string;
  priority: PublicAnnouncementPriority;
  pinned: boolean;
  eventName: string;
  /** Where "Read more" goes: the hub for a personal registration, else the club's event page. */
  href: string;
};

export function selectAccountBannerAnnouncements(
  candidates: AccountBannerCandidate[],
  now = new Date(),
): AccountBannerAnnouncement[] {
  return candidates
    .filter((candidate) => (
      candidate.status === "PUBLISHED"
      && candidate.placement === "HOME_BANNER"
      && isExactAllAttendeesAudience(candidate.audience)
      && candidate.publishedAt !== null
      && candidate.publishedAt.getTime() <= now.getTime()
      && candidate.title.trim().length > 0
      && candidate.body.trim().length > 0
      && !hasEventEnded(candidate.event, now)
    ))
    .sort((left, right) => (
      Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt))
      || publicAnnouncementPriorityRank[left.priority] - publicAnnouncementPriorityRank[right.priority]
      || right.publishedAt!.getTime() - left.publishedAt!.getTime()
      || left.id.localeCompare(right.id)
    ))
    .map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      body: candidate.body,
      priority: candidate.priority,
      pinned: Boolean(candidate.pinnedAt),
      eventName: candidate.event.name,
      href: candidate.hasOwnRegistration || !candidate.clubOrganizationId
        ? `/account/events/${candidate.event.slug}`
        : `/account/clubs/${candidate.clubOrganizationId}/events/${candidate.eventId}`,
    }));
}
