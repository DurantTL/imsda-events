import {
  evaluateEventRegistrationPhase,
  hasEventEnded,
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
  /** The event itself is over (registration is closed for good). */
  ended: boolean;
  heroTagline: string;
  /** Heading above the form list; never invites a choice when none can be made. */
  formsHeading: string;
  /** Shown when no forms are listed; "being prepared" only when that is true. */
  emptyForms: { title: string; body: string };
  /** Sidebar card text; carries the capacity number only when one may be shown. */
  availability: { heading: string; body: string };
  /** Null on closed or ended events. */
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
  endsAt?: Date | null;
};

export const publicAnnouncementPriorityRank: Record<
  PublicAnnouncementPriority,
  number
> = {
  URGENT: 0,
  IMPORTANT: 1,
  NORMAL: 2,
};

export function isExactAllAttendeesAudience(value: unknown) {
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

type LifecyclePresentation = Pick<
  PublicEventLifecycleSummary,
  | "state"
  | "statusLabel"
  | "detail"
  | "ctaLabel"
  | "ctaEnabled"
  | "ended"
  | "heroTagline"
  | "formsHeading"
  | "emptyForms"
  | "availability"
> & { showCapacity: boolean };

function spotsPhrase(remainingSpots: number) {
  return `${remainingSpots} spot${remainingSpots === 1 ? "" : "s"}`;
}

/**
 * One presentation per lifecycle state (#642). The hero, the forms heading and
 * empty state, the availability card, and the call to action all come from
 * this single result, so a page can never say "closed" in one place and show a
 * capacity number or "forms are being prepared" in another.
 */
function presentPublicEventLifecycle(
  event: PublicEventLifecycleInput,
  phase: EventRegistrationPhase,
  remainingSpots: number | null,
  now: Date,
): LifecyclePresentation {
  const preparing = {
    title: "Registration forms are being prepared",
    body: "Event details are available now. Please check back or contact the event team for registration help.",
  };

  if (phase === "UPCOMING") {
    const opens = event.registrationOpensOn
      ? calendarDateLabel(event.registrationOpensOn)
      : "soon";
    return {
      state: "UPCOMING",
      statusLabel: `Registration opens ${opens}`,
      detail: "Review the event details now and return when online registration opens.",
      ctaLabel: `Opens ${opens}`,
      ctaEnabled: false,
      ended: false,
      heroTagline: `Registration opens ${opens}. Review the details below in the meantime.`,
      formsHeading: "Registration options",
      emptyForms: preparing,
      availability: {
        heading: `Registration opens ${opens}`,
        body: "Online registration has not opened yet.",
      },
      showCapacity: true,
    };
  }

  if (phase === "CLOSED" && hasEventEnded(event, now)) {
    return {
      state: "CLOSED",
      statusLabel: "This event has ended",
      detail: "This event has ended. Contact the event team if you need help.",
      ctaLabel: "This event has ended",
      ctaEnabled: false,
      ended: true,
      heroTagline: "This event has ended.",
      formsHeading: "Registration is closed",
      emptyForms: {
        title: "This event has ended",
        body: "Online registration is no longer available. Contact the event team if you need help.",
      },
      availability: {
        heading: "This event has ended",
        body: "Online registration is no longer available.",
      },
      showCapacity: false,
    };
  }

  if (phase === "CLOSED" || phase === "DRAFT") {
    const closed = event.registrationClosesOn
      ? ` on ${calendarDateLabel(event.registrationClosesOn)}`
      : "";
    return {
      state: "CLOSED",
      statusLabel: "Registration closed",
      detail: `Online registration is no longer available${closed}. Contact the event team if you need help.`,
      ctaLabel: "Registration closed",
      ctaEnabled: false,
      ended: false,
      heroTagline: "Online registration is closed.",
      formsHeading: "Registration is closed",
      emptyForms: {
        title: "Registration closed",
        body: "Online registration is no longer available. Contact the event team if you need help.",
      },
      availability: {
        heading: "Registration closed",
        body: "Online registration is no longer available.",
      },
      showCapacity: false,
    };
  }

  if (remainingSpots === 0) {
    if (event.waitlistEnabled) {
      return {
        state: "WAITLIST",
        statusLabel: "Event full · waitlist open",
        detail: "The event is currently full, but you can submit a registration to join the waitlist.",
        ctaLabel: "Join the waitlist",
        ctaEnabled: true,
        ended: false,
        heroTagline: "The event is full, but you can join the waitlist.",
        formsHeading: "Join the waitlist",
        emptyForms: {
          title: "Waitlist opening soon",
          body: "The waitlist form will appear here when it's ready.",
        },
        availability: {
          heading: "Event full · waitlist open",
          body: "The event-wide capacity has been reached. You can join the waitlist.",
        },
        showCapacity: true,
      };
    }
    return {
      state: "FULL",
      statusLabel: "Event full",
      detail: "All available places are currently filled. Contact the event team with questions.",
      ctaLabel: "Event full",
      ctaEnabled: false,
      ended: false,
      heroTagline: "This event is full.",
      formsHeading: "Event full",
      emptyForms: {
        title: "Event full",
        body: "All available places are filled. Contact the event team with questions.",
      },
      availability: {
        heading: "Event full",
        body: "The event-wide capacity has been reached.",
      },
      showCapacity: true,
    };
  }

  const closes = event.registrationClosesOn
    ? ` through ${calendarDateLabel(event.registrationClosesOn)}`
    : "";
  const availability = remainingSpots === null
    ? "Choose the form that best matches who you are registering."
    : `${spotsPhrase(remainingSpots)} currently remain.`;
  return {
    state: "OPEN",
    statusLabel: "Registration open",
    detail: `Online registration is available${closes}. ${availability}`,
    ctaLabel: "Start registration",
    ctaEnabled: true,
    ended: false,
    heroTagline: "Everything you need to choose the right registration path.",
    formsHeading: "Choose how you\u2019re registering",
    emptyForms: preparing,
    availability: {
      heading: "Registration open",
      body: remainingSpots === null
        ? "No event-wide capacity limit is listed."
        : `${spotsPhrase(remainingSpots)} currently remain.`,
    },
    showCapacity: true,
  };
}

export function describePublicEventLifecycle(
  event: PublicEventLifecycleInput,
  occupiedSpots: number,
  now = new Date(),
): PublicEventLifecycleSummary {
  const phase = evaluateEventRegistrationPhase(event, now);
  const capacityLeft = remainingEventCapacity(event.capacity, occupiedSpots);
  const { showCapacity, ...presentation } = presentPublicEventLifecycle(
    event,
    phase,
    capacityLeft,
    now,
  );

  return {
    phase,
    ...presentation,
    // A closed or ended event shows no capacity number (#642).
    remainingSpots: showCapacity ? capacityLeft : null,
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
    description: definition.description?.trim() || "Complete this form to register for the event.",
    /** True when the form collects a list of people (a roster form). */
    isRoster: roster !== null,
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

/**
 * The IMSDA.org information page is an optional setting (#467), not a
 * required one: event information now lives on IMSDA Events. When neither a
 * configured `publicInfoUrl` nor a known legacy page exists for this event,
 * `detailsUrl` is `null` so a caller drops the "More information" link
 * instead of rendering one that points nowhere useful.
 */
export function publicEventWebsiteLinks(
  eventSlug: string,
  configuredDetailsUrl?: string | null,
) {
  const eventDetailsBySlug: Record<string, string> = {
    "womens-retreat-2026": "https://imsda.org/event/womens-retreat-3/",
  };

  return {
    detailsUrl: configuredDetailsUrl
      || eventDetailsBySlug[eventSlug]
      || null,
    supportUrl: "https://imsda.org/contact/",
  };
}
