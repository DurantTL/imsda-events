import {
  evaluateEventRegistrationPhase,
  remainingEventCapacity,
  type EventRegistrationPhase,
} from "@/modules/events/lifecycle";
import type { RegistrationFormDefinition } from "@/modules/forms/definition";

export type PublicEventRegistrationState =
  | "UPCOMING"
  | "OPEN"
  | "WAITLIST"
  | "FULL"
  | "CLOSED";

export type PublicEventLifecycleSummary = {
  phase: EventRegistrationPhase;
  state: PublicEventRegistrationState;
  statusLabel: string;
  detail: string;
  ctaLabel: string;
  ctaEnabled: boolean;
  remainingSpots: number | null;
};

export type PublicAnnouncementPriority = "NORMAL" | "IMPORTANT" | "URGENT";

export type PublicAnnouncementCandidate = {
  title: string;
  body: string;
  audience: unknown;
  placement: string;
  status: string;
  priority: PublicAnnouncementPriority;
  publishedAt: Date | null;
};

export type PublicEventAnnouncement = {
  title: string;
  body: string;
  placement: string;
  placementLabel: string;
  priority: PublicAnnouncementPriority;
  priorityLabel: string;
  publishedAt: string;
  publishedLabel: string;
  isFeatured: boolean;
};

type PublicEventLifecycleInput = {
  isPublished: boolean;
  timezone: string;
  capacity: number | null;
  registrationOpensOn: string | null;
  registrationClosesOn: string | null;
  waitlistEnabled: boolean;
};

const publicAnnouncementPriorityRank: Record<
  PublicAnnouncementPriority,
  number
> = {
  URGENT: 0,
  IMPORTANT: 1,
  NORMAL: 2,
};

function isExactAllAttendeesAudience(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const audience = value as Record<string, unknown>;
  return Object.keys(audience).length === 1
    && audience.type === "ALL_ATTENDEES";
}

function publicAnnouncementPlacementLabel(placement: string) {
  if (placement === "HOME_BANNER") return "Featured notice";
  if (placement === "REGISTRATION_PAGE") return "Registration update";
  return "Attendee update";
}

function publicAnnouncementPriorityLabel(
  priority: PublicAnnouncementPriority,
) {
  if (priority === "URGENT") return "Urgent";
  if (priority === "IMPORTANT") return "Important";
  return "Update";
}

export function buildPublicEventAnnouncementFeed(
  candidates: PublicAnnouncementCandidate[],
  timeZone: string,
  now = new Date(),
): PublicEventAnnouncement[] {
  const publishedFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });

  return candidates
    .filter((candidate) => (
      candidate.status === "PUBLISHED"
      && isExactAllAttendeesAudience(candidate.audience)
      && candidate.publishedAt !== null
      && Number.isFinite(candidate.publishedAt.valueOf())
      && candidate.publishedAt.getTime() <= now.getTime()
      && candidate.title.trim().length > 0
      && candidate.body.trim().length > 0
    ))
    .sort((left, right) => (
      publicAnnouncementPriorityRank[left.priority]
        - publicAnnouncementPriorityRank[right.priority]
      || right.publishedAt!.getTime() - left.publishedAt!.getTime()
      || left.placement.localeCompare(right.placement)
      || left.title.localeCompare(right.title)
      || left.body.localeCompare(right.body)
    ))
    .map((candidate) => {
      const publishedAt = candidate.publishedAt!;
      return {
        title: candidate.title.trim(),
        body: candidate.body.trim(),
        placement: candidate.placement,
        placementLabel: publicAnnouncementPlacementLabel(candidate.placement),
        priority: candidate.priority,
        priorityLabel: publicAnnouncementPriorityLabel(candidate.priority),
        publishedAt: publishedAt.toISOString(),
        publishedLabel: publishedFormatter.format(publishedAt),
        isFeatured: candidate.placement === "HOME_BANNER",
      };
    });
}

function calendarDateLabel(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00.000Z`));
}

export function describePublicEventLifecycle(
  event: PublicEventLifecycleInput,
  occupiedSpots: number,
  now = new Date(),
): PublicEventLifecycleSummary {
  const phase = evaluateEventRegistrationPhase(event, now);
  const remainingSpots = remainingEventCapacity(event.capacity, occupiedSpots);

  if (phase === "UPCOMING") {
    const opens = event.registrationOpensOn
      ? calendarDateLabel(event.registrationOpensOn)
      : "soon";
    return {
      phase,
      state: "UPCOMING",
      statusLabel: `Registration opens ${opens}`,
      detail: "Review the event details now and return when online registration opens.",
      ctaLabel: `Opens ${opens}`,
      ctaEnabled: false,
      remainingSpots,
    };
  }

  if (phase === "CLOSED" || phase === "DRAFT") {
    const closed = event.registrationClosesOn
      ? ` on ${calendarDateLabel(event.registrationClosesOn)}`
      : "";
    return {
      phase,
      state: "CLOSED",
      statusLabel: "Registration closed",
      detail: `Online registration is no longer available${closed}. Contact the event team if you need help.`,
      ctaLabel: "Registration closed",
      ctaEnabled: false,
      remainingSpots,
    };
  }

  if (remainingSpots === 0) {
    if (event.waitlistEnabled) {
      return {
        phase,
        state: "WAITLIST",
        statusLabel: "Event full · waitlist open",
        detail: "The event is currently full, but you can submit a registration to join the waitlist.",
        ctaLabel: "Join the waitlist",
        ctaEnabled: true,
        remainingSpots,
      };
    }
    return {
      phase,
      state: "FULL",
      statusLabel: "Event at capacity",
      detail: "All available places are currently filled. Contact the event team with questions.",
      ctaLabel: "Event full",
      ctaEnabled: false,
      remainingSpots,
    };
  }

  const closes = event.registrationClosesOn
    ? ` through ${calendarDateLabel(event.registrationClosesOn)}`
    : "";
  const availability = remainingSpots === null
    ? "Choose the form that best matches who you are registering."
    : `${remainingSpots} spot${remainingSpots === 1 ? "" : "s"} currently remain.`;
  return {
    phase,
    state: "OPEN",
    statusLabel: "Registration open",
    detail: `Online registration is available${closes}. ${availability}`,
    ctaLabel: "Start registration",
    ctaEnabled: true,
    remainingSpots,
  };
}

export function summarizePublicRegistrationForm(
  definition: RegistrationFormDefinition,
) {
  const fields = definition.sections.flatMap((section) => section.fields);
  const attendeeFields = fields.filter((field) => field.scope === "ATTENDEE");
  const roster = definition.attendeeRoster?.enabled
    ? definition.attendeeRoster
    : null;
  const hasPricing = fields.some((field) => (
    field.priceCents !== undefined
    || Object.keys(field.choicePricesCents ?? {}).length > 0
  ));

  return {
    title: definition.title,
    description: definition.description || "Complete this form to register for the event.",
    audienceLabel: roster
      ? `${roster.attendeeLabel} roster`
      : attendeeFields.length > 0
        ? "Individual attendee"
        : "Event registration",
    highlights: [
      roster
        ? `Add up to ${roster.maxAttendees} ${roster.attendeeLabel.toLowerCase()}${roster.maxAttendees === 1 ? "" : "s"}`
        : "One registration at a time",
      `${definition.sections.length} section${definition.sections.length === 1 ? "" : "s"}`,
      ...(definition.payment?.enabled || hasPricing ? ["Includes fee calculation"] : []),
    ],
  };
}

export function formatPublicEventSchedule(
  startsAt: Date,
  endsAt: Date,
  timeZone: string,
) {
  const dates = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
  const times = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });

  return {
    dateLabel: dates.formatRange(startsAt, endsAt),
    timeLabel: `${times.format(startsAt)} – ${times.format(endsAt)}`,
  };
}

export function publicEventWebsiteLinks(
  eventSlug: string,
  configuredDetailsUrl?: string | null,
) {
  const eventDetailsBySlug: Record<string, string> = {
    "womens-retreat-2026": "https://imsda.org/event/womens-retreat-3/",
  };

  return {
    detailsUrl: configuredDetailsUrl
      ?? eventDetailsBySlug[eventSlug]
      ?? "https://imsda.org/events/",
    supportUrl: "https://imsda.org/contact/",
  };
}
