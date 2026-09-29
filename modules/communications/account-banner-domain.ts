import { hasEventEnded } from "@/modules/events/lifecycle";
import {
  isExactAllAttendeesAudience,
  publicAnnouncementPriorityRank,
  type PublicAnnouncementPriority,
} from "@/modules/events/public-domain";

/**
 * Which published announcements an account banner may show (#590). The
 * audience rule is the event hub's own (`isExactAllAttendeesAudience`, shared
 * with the public event page); this only adds the banner placement, the
 * event-ended cut-off and the ordering.
 */

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
};

export type AccountBannerAnnouncement = {
  id: string;
  title: string;
  body: string;
  priority: PublicAnnouncementPriority;
  pinned: boolean;
  eventName: string;
  eventSlug: string;
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
      eventSlug: candidate.event.slug,
    }));
}
