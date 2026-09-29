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
      label: CLUB_EVENT_BILLING_MESSAGE,
      detail: "Churches register club events through director routes, and those only list events billed to the church. Set the billing mode to church invoice in event settings.",
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
