export type EventReadinessSource = {
  name?: string | null;
  slug?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
  timezone?: string | null;
  location?: string | null;
  publicInfoUrl?: string | null;
  supportContact?: string | null;
  audience?: "GENERAL" | "CLUB" | null;
  billingMode?: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE" | null;
};

/** Shown as the publish blocker and the settings/readiness flag (#565). */
export const CLUB_EVENT_BILLING_MESSAGE = "Club registration uses church billing — choose it before publishing.";

export type EventReadinessItem = {
  id: "basics" | "location" | "support" | "registration-form" | "club-billing";
  label: string;
  detail: string;
  complete: boolean;
};

/**
 * Event information no longer lives on a required IMSDA.org page (#467):
 * it is an optional setting, never counted toward "ready" and never a
 * publish blocker. It is reported separately so a caller that wants to show
 * it can, without folding it back into readiness math.
 */
export type EventReadinessOptionalItem = {
  id: "public-info";
  label: string;
  detail: string;
  complete: boolean;
};

export const pastEventPublishWarning =
  "This event's dates have passed; public registration will be closed.";

/**
 * Warnings shown when publishing (#575). Unlike readiness items they never
 * block publishing: an event whose last day has passed can still be published
 * (for example to show its page), it just won't take public registrations.
 * `endsOn` is a calendar date (YYYY-MM-DD) in the event time zone.
 */
export function getEventPublishWarnings(
  event: { endsOn?: string | null; timezone?: string | null },
  now = new Date(),
) {
  if (!event.endsOn || !event.timezone) return [];
  const today = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: event.timezone,
  }).format(now);
  return today > event.endsOn ? [pastEventPublishWarning] : [];
}

function hasText(value: string | null | undefined) {
  return Boolean(value?.trim());
}

function isPublicWebUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function getEventPublishReadiness(
  event: EventReadinessSource,
  publishedFormCount: number,
) {
  const items: EventReadinessItem[] = [
    {
      id: "basics",
      label: "Event name, web address, dates, and timezone",
      detail: "These identify the event and place it correctly on the calendar.",
      complete: [
        event.name,
        event.slug,
        event.startsOn,
        event.endsOn,
        event.timezone,
      ].every(hasText),
    },
    {
      id: "location",
      label: "Event location",
      detail: "A venue, campus, or clear location note is ready for attendees.",
      complete: hasText(event.location),
    },
    {
      id: "support",
      label: "Support contact",
      detail: "Attendees know who to contact with registration questions.",
      complete: hasText(event.supportContact),
    },
    {
      id: "registration-form",
      label: "Published registration form",
      detail: "At least one tested form is published for this event.",
      complete: publishedFormCount > 0,
    },
  ];

  // Directors only see CLUB events billed to the church (#565), so a CLUB
  // event set to attendee-pay would 404 for them. Listed only for CLUB
  // events, and never auto-corrected: a billing change is a human decision.
  if (event.audience === "CLUB") {
    items.push({
      id: "club-billing",
      label: "Church billing for club registration",
      detail: `${CLUB_EVENT_BILLING_MESSAGE} Directors only see club events billed to the church, so set billing mode to church invoice in event settings.`,
      complete: event.billingMode === "DEFERRED_ORGANIZATION_INVOICE",
    });
  }

  // Complete when nothing is set (there is nothing to fix) or when the
  // configured value is a valid web address. Never a blocker either way.
  const publicInfoComplete = !hasText(event.publicInfoUrl) || isPublicWebUrl(event.publicInfoUrl);
  const optionalItems: EventReadinessOptionalItem[] = [
    {
      id: "public-info",
      label: "IMSDA.org information page (optional)",
      detail: publicInfoComplete
        ? "Event information now lives on IMSDA Events. Set this only if a separate IMSDA.org page also describes the event."
        : "The saved address isn't a complete http:// or https:// web address. Fix it or clear it.",
      complete: publicInfoComplete,
    },
  ];

  return {
    ready: items.every((item) => item.complete),
    completedCount: items.filter((item) => item.complete).length,
    items,
    optionalItems,
  };
}

/**
 * Setup reminders that never block publishing (#593). Directors and staff
 * still see them until the work is done: a location with no dates, and a fee
 * field with no amount (pricing is a human decision, so nothing sets it for
 * them).
 */
export type EventReadinessWarning = {
  id: string;
  label: string;
  detail: string;
};

/** One warning for each active location that is missing its first or last day. */
export function getLocationDateWarnings(
  locations: ReadonlyArray<{ name: string; firstDay: string | null; lastDay: string | null; isActive: boolean }>,
): EventReadinessWarning[] {
  return locations
    .filter((location) => location.isActive && !(location.firstDay && location.lastDay))
    .map((location) => ({
      id: `location-dates:${location.name}`,
      label: `Set the dates for ${location.name}`,
      detail: "Add this location's first and last day under Event settings, Locations.",
    }));
}

type FeeFieldShape = {
  type: string;
  scope?: string;
  label: string;
  priceCents?: number;
};

/**
 * Labels of the per-attendee fee fields that have no amount: a CALCULATED
 * attendee field with no `priceCents`. The label is the field's own, so
 * "Fall Camporee fee" reads "Set the Fall Camporee fee".
 */
export function unpricedFeeFieldLabels(definition: { sections: ReadonlyArray<{ fields: ReadonlyArray<FeeFieldShape> }> }) {
  return definition.sections
    .flatMap((section) => section.fields)
    .filter((field) => field.type === "CALCULATED" && field.scope === "ATTENDEE" && field.priceCents === undefined)
    .map((field) => field.label);
}

export function getFeeWarnings(unpricedLabels: readonly string[]): EventReadinessWarning[] {
  return [...new Set(unpricedLabels)].map((label) => ({
    id: `fee:${label}`,
    label: `Set the ${label}`,
    detail: "No amount is set. Choose the fee in the registration builder before publishing.",
  }));
}
