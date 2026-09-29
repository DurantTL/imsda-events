import { getFormTemplate } from "@/modules/forms/definition";
import { eventTemplatePayloadSchema, type EventTemplatePayload } from "@/modules/event-templates/domain";

/**
 * The starter event templates (#546): one per real IMSDA event that already
 * has a built-in registration form template. Pure data, so the admin action,
 * the dev seed, and the tests all read one definition.
 *
 * Deliberately absent: pricing and capacity (human gates in AGENTS.md; the
 * form templates carry their own legacy prices, which staff review), waitlist
 * switches (they only mean something with a capacity), and message template
 * defaults (event message templates are generic in code, none is specific to
 * one event). Module switches are set only where the form or the legacy
 * document clearly implies them: shirt sizes when the form asks for a shirt
 * size, adult background checks for the club events.
 */
export type StarterEventTemplate = {
  starterKey: string;
  name: string;
  formTemplateKey: string;
  audience: "GENERAL" | "CLUB";
  /** CLUB starters are church-billed (#565): the director routes only show deferred-billing club events. */
  billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE";
  collectsShirtSizes: boolean;
  checksAdultBackgrounds: boolean;
};

export const starterEventTemplates: readonly StarterEventTemplate[] = [
  { starterKey: "womens_retreat", name: "Women's Retreat", formTemplateKey: "womens_retreat_export", audience: "GENERAL", billingMode: "ATTENDEE_PAY", collectsShirtSizes: true, checksAdultBackgrounds: false },
  { starterKey: "man_camp", name: "Man Camp", formTemplateKey: "man_camp_export", audience: "GENERAL", billingMode: "ATTENDEE_PAY", collectsShirtSizes: true, checksAdultBackgrounds: false },
  { starterKey: "spring_camporee", name: "Spring Camporee", formTemplateKey: "spring_camporee_export", audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", collectsShirtSizes: false, checksAdultBackgrounds: true },
  { starterKey: "camp_meeting", name: "Camp Meeting", formTemplateKey: "camp_meeting_export", audience: "GENERAL", billingMode: "ATTENDEE_PAY", collectsShirtSizes: false, checksAdultBackgrounds: false },
  { starterKey: "honors_weekend", name: "Honors Weekend", formTemplateKey: "honors_weekend", audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", collectsShirtSizes: false, checksAdultBackgrounds: true },
];

/** Real events with no form template yet: listed, never created. */
export const pendingStarterEvents = [
  { starterKey: "fall_camporee", name: "Fall Camporee", note: "form still needed" },
] as const;

export function starterDescription(starter: StarterEventTemplate) {
  const form = getFormTemplate(starter.formTemplateKey);
  const source = form ? `the built-in "${form.name}" form (${starter.formTemplateKey})` : `the ${starter.formTemplateKey} form`;
  return `Starter set: created from ${source}. This template sets no prices or capacity. The form keeps last year's prices, late-price dates and choice limits. Review them on the draft event before publishing.`;
}

export function starterPayload(starter: StarterEventTemplate): EventTemplatePayload {
  return eventTemplatePayloadSchema.parse({
    starterKey: starter.starterKey,
    audience: starter.audience,
    billingMode: starter.billingMode,
    formTemplateKeys: [starter.formTemplateKey],
    moduleEnablement: {
      collectsShirtSizes: starter.collectsShirtSizes,
      checksAdultBackgrounds: starter.checksAdultBackgrounds,
    },
  });
}
