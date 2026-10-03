import type { EventPermission } from "@/modules/access/permissions";

/**
 * The Dashboard's event setup checklist (#743): seven steps from "Event basics"
 * to "View public page". Every step is computed from data the event already
 * has (no new table, no stored "done" flag), and each step names the control
 * that does the work, so a viewer is never sent to a page they cannot open.
 */

export const setupStepIds = [
  "basics",
  "attendee-types",
  "forms",
  "test-form",
  "publish-form",
  "publish-event",
  "public-page",
] as const;

export type SetupStepId = (typeof setupStepIds)[number];

/** What the event already holds. Counts and flags only; nothing personal. */
export type SetupChecklistFacts = {
  eventId: string;
  slug: string;
  name: string;
  /** Calendar dates (YYYY-MM-DD) or ISO timestamps; blank means not set. */
  startsOn: string | null;
  endsOn: string | null;
  isPublished: boolean;
  /** Active attendee types. */
  activeAttendeeTypeCount: number;
  formCount: number;
  /** Valid FormTestSubmission rows for the event (a failed test does not count). */
  testSubmissionCount: number;
  publishedFormCount: number;
};

export type SetupStep = {
  id: SetupStepId;
  label: string;
  /** Plain words for what "done" means, shown under the label. */
  detail: string;
  done: boolean;
  /** The control that does the work. Absent only if the viewer could not open it (the step is then not listed). */
  href: string;
  /** Opens in a new tab: the public page. */
  external?: boolean;
  /** False when the destination is not live yet: the step shows as text, with no link. */
  linkable: boolean;
  /** Said instead of the link while it is not linkable. */
  unavailableNote?: string;
  actionLabel: string;
};

type StepDefinition = {
  id: SetupStepId;
  label: string;
  detail: string;
  actionLabel: string;
  /** Needs every one of these; the public page needs none of its own. */
  requires: readonly EventPermission[];
  done: (facts: SetupChecklistFacts) => boolean;
  href: (facts: SetupChecklistFacts) => string;
  external?: boolean;
  linkable?: (facts: SetupChecklistFacts) => boolean;
  unavailableNote?: string;
};

const hasText = (value: string | null | undefined) => Boolean(value?.trim());
const query = (eventId: string) => `?event=${encodeURIComponent(eventId)}`;

/** In the order staff do them. The permission is the one the destination page itself checks. */
const definitions: readonly StepDefinition[] = [
  {
    id: "basics",
    label: "Event basics",
    detail: "A name, a web address and dates.",
    actionLabel: "Open event settings",
    requires: ["CONFIGURE_EVENT"],
    done: (facts) => [facts.name, facts.slug, facts.startsOn, facts.endsOn].every(hasText),
    href: (facts) => `/more/event-settings${query(facts.eventId)}#event-settings-block-basics`,
  },
  {
    id: "attendee-types",
    label: "Attendee types",
    detail: "At least one active attendee type. Prices are set on the registration form's fields.",
    actionLabel: "Open attendee setup",
    requires: ["CONFIGURE_EVENT"],
    done: (facts) => facts.activeAttendeeTypeCount > 0,
    href: (facts) => `/more/attendee-configuration${query(facts.eventId)}`,
  },
  {
    id: "forms",
    label: "Registration forms and prices",
    detail: "A registration form exists. Add its prices in the form builder.",
    actionLabel: "Open form builder",
    requires: ["MANAGE_FORMS"],
    done: (facts) => facts.formCount > 0,
    href: (facts) => `/registration-builder${query(facts.eventId)}`,
  },
  {
    id: "test-form",
    label: "Test form",
    detail: "A valid test submission has been run.",
    actionLabel: "Run a test",
    requires: ["MANAGE_FORMS"],
    done: (facts) => facts.testSubmissionCount > 0,
    href: (facts) => `/registration-builder${query(facts.eventId)}#live-form-preview`,
  },
  {
    id: "publish-form",
    label: "Publish form",
    detail: "A form version is published.",
    actionLabel: "Open form builder",
    requires: ["MANAGE_FORMS"],
    done: (facts) => facts.publishedFormCount > 0,
    href: (facts) => `/registration-builder${query(facts.eventId)}`,
  },
  {
    id: "publish-event",
    label: "Publish event",
    detail: "The event is published.",
    actionLabel: "Open publishing",
    requires: ["CONFIGURE_EVENT"],
    done: (facts) => facts.isPublished,
    href: (facts) => `/more/event-settings${query(facts.eventId)}#event-readiness-panel`,
  },
  {
    id: "public-page",
    label: "View public page",
    detail: "The public page is live with a published form.",
    actionLabel: "View public page",
    requires: [],
    done: (facts) => facts.isPublished && facts.publishedFormCount > 0 && hasText(facts.slug),
    href: (facts) => `/events/${encodeURIComponent(facts.slug)}`,
    external: true,
    // No live link until the event is published: an unpublished page is not there to open.
    linkable: (facts) => facts.isPublished,
    unavailableNote: "Available once the event is published.",
  },
];

export type SetupChecklist = {
  /** Steps this viewer can act on, in order. */
  steps: SetupStep[];
  doneCount: number;
  /** The first step not yet done: the one to point at. */
  nextStepId: SetupStepId | null;
  /** Nothing left for this viewer, or the viewer has no step to act on. The Dashboard then hides the checklist. */
  hidden: boolean;
};

/**
 * The steps this viewer can act on. A step whose destination the viewer cannot
 * open is not listed at all (never a dead link), and the last step, a public
 * page, is listed only when the viewer has at least one step of their own.
 * The server pages still check access again.
 */
export function buildSetupChecklist(
  facts: SetupChecklistFacts,
  permissions: readonly EventPermission[],
): SetupChecklist {
  const granted = new Set(permissions);
  const own = definitions.filter((definition) => definition.requires.length > 0 && definition.requires.every((permission) => granted.has(permission)));
  const listed = definitions.filter((definition) => definition.requires.length === 0 ? own.length > 0 : own.includes(definition));
  const steps = listed.map<SetupStep>((definition) => ({
    id: definition.id,
    label: definition.label,
    detail: definition.detail,
    done: definition.done(facts),
    href: definition.href(facts),
    actionLabel: definition.actionLabel,
    ...(definition.external ? { external: true } : {}),
    linkable: definition.linkable?.(facts) ?? true,
    ...(definition.unavailableNote ? { unavailableNote: definition.unavailableNote } : {}),
  }));
  const next = steps.find((step) => !step.done);
  return {
    steps,
    doneCount: steps.filter((step) => step.done).length,
    nextStepId: next?.id ?? null,
    hidden: steps.length === 0 || !next,
  };
}
