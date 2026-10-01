import { DUPLICATE_PUBLIC_FORMS_MESSAGE, duplicatePublicFormGroups, publicFormLookKey } from "@/modules/forms/duplicate-public-forms";

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
 * still see them until the work is done: a location never edited, and a fee
 * field with no amount (pricing is a human decision, so nothing sets it for
 * them).
 */
export type EventReadinessWarning = {
  id: string;
  label: string;
  detail: string;
  /** Where to fix it, when the warning points at one place (#617). */
  href?: string;
};

/** A location saved within this long of its creation counts as never edited. */
const NEVER_EDITED_WINDOW_MS = 1000;

/**
 * A location with no dates of its own uses the event's dates, so blank dates
 * are valid. Warn only "until edited": an active location with neither a first
 * nor a last day that nobody has saved since it was created (for example one a
 * starter made). One date set, or any save by staff, never warns.
 */
export function getLocationDateWarnings(
  locations: ReadonlyArray<{
    name: string;
    firstDay: string | null;
    lastDay: string | null;
    isActive: boolean;
    createdAt: string | Date;
    updatedAt: string | Date;
  }>,
): EventReadinessWarning[] {
  return locations
    .filter((location) => location.isActive
      && !location.firstDay
      && !location.lastDay
      && Math.abs(new Date(location.updatedAt).getTime() - new Date(location.createdAt).getTime()) <= NEVER_EDITED_WINDOW_MS)
    .map((location) => ({
      id: `location-dates:${location.name}`,
      label: `Check the dates for ${location.name}`,
      detail: "It uses the event's dates until you set its own.",
    }));
}

type FeeFieldShape = {
  id?: string;
  type: string;
  scope?: string;
  label: string;
  priceCents?: number;
};

/** The label the registration builder puts on a fee field's amount input. */
export const REGISTRATION_FEE_INPUT_LABEL = "Registration fee (standard price)";

/** A per-attendee fee field with no amount, and where to find it in the builder. */
export type UnpricedFeeField = { label: string; fieldId?: string; formId?: string };

/**
 * The per-attendee fee fields that have no amount: a CALCULATED attendee field
 * with no `priceCents`. The label is the field's own, so "Fall Camporee fee"
 * reads "Set the Fall Camporee fee". `fieldId` lets the warning link to it.
 */
export function unpricedFeeFields(
  definition: { sections: ReadonlyArray<{ fields: ReadonlyArray<FeeFieldShape> }> },
  formId?: string,
): UnpricedFeeField[] {
  return definition.sections
    .flatMap((section) => section.fields)
    .filter((field) => field.type === "CALCULATED" && field.scope === "ATTENDEE" && field.priceCents === undefined)
    .map((field) => ({ label: field.label, fieldId: field.id, formId }));
}

/** Labels of the unpriced fee fields (see `unpricedFeeFields`). */
export function unpricedFeeFieldLabels(definition: { sections: ReadonlyArray<{ fields: ReadonlyArray<FeeFieldShape> }> }) {
  return unpricedFeeFields(definition).map((field) => field.label);
}

/** The builder URL for one form's field; the builder opens that form and focuses the field's amount. */
export function registrationBuilderFieldHref(eventId: string, formId?: string, fieldId?: string) {
  const query = new URLSearchParams({ event: eventId });
  if (formId && fieldId) {
    query.set("form", formId);
    query.set("field", fieldId);
  }
  return `/registration-builder?${query.toString()}`;
}

/**
 * One warning per unpriced fee field, naming the exact place to set it (#617).
 * Plain strings (labels only) are accepted for callers with no builder context;
 * with an `eventId` the warning also links straight to the field.
 */
export function getFeeWarnings(unpriced: ReadonlyArray<string | UnpricedFeeField>, eventId?: string): EventReadinessWarning[] {
  const fields = unpriced.map((entry) => (typeof entry === "string" ? { label: entry } : entry));
  const seen = new Set<string>();
  return fields.flatMap((field) => {
    if (seen.has(field.label)) return [];
    seen.add(field.label);
    return [{
      id: `fee:${field.label}`,
      label: `Set the ${field.label}`,
      detail: `No amount is set. Open the registration builder \u2192 ${field.label} \u2192 set the amount in the "${REGISTRATION_FEE_INPUT_LABEL}" box, shown as soon as the field is open, before publishing.`,
      ...(eventId ? { href: registrationBuilderFieldHref(eventId, field.formId, field.fieldId) } : {}),
    }];
  });
}

/**
 * A form that takes card payment on a church-billed event (#606): the public form refuses to submit
 * there, so say why up front. `formTitles` are the titles of the attached forms with payment enabled.
 */
export function getPaymentOnChurchBilledWarnings(
  billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE" | null | undefined,
  formTitles: readonly string[],
): EventReadinessWarning[] {
  if (billingMode !== "DEFERRED_ORGANIZATION_INVOICE") return [];
  return [...new Set(formTitles)].map((title) => ({
    id: `payment-on-church-billed:${title}`,
    label: `${title} collects payment on a church-billed event`,
    detail: "This event bills the church or organization later, so a form with card payment cannot be submitted. Turn payment off on the form, or change the event to attendee pay.",
  }));
}

/**
 * Two or more published forms sharing a public title and description (#720):
 * the public event page can't tell them apart. Pass only forms with a
 * published version; a draft or withdrawn form never counts.
 */
export function getDuplicatePublicFormWarnings(
  publishedForms: ReadonlyArray<{ title: string; description?: string | null }>,
  eventId?: string,
): EventReadinessWarning[] {
  return duplicatePublicFormGroups(publishedForms).map((group) => ({
    id: `duplicate-public-forms:${publicFormLookKey(group[0]!)}`,
    label: `${group.length} published forms are titled "${group[0]!.title}"`,
    detail: DUPLICATE_PUBLIC_FORMS_MESSAGE,
    ...(eventId ? { href: registrationBuilderFieldHref(eventId) } : {}),
  }));
}
