import { getFormTemplate, isBlankFormTemplateKey } from "@/modules/forms/definition";
import { eventTemplatePayloadSchema, type EventTemplatePayload, type TemplateLocation } from "@/modules/event-templates/domain";

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
  /** Locations created on the new event (#593); dates are day offsets from its first day. */
  locations?: readonly TemplateLocation[];
};


/**
 * Fall Camporee always runs at two sites with different dates (#593). Staff
 * name the sites and fill in the dates under Event settings > Locations, so
 * both start with no dates. They are created active on purpose: with active
 * locations every new club registration must pick one, and an inactive one
 * would leave the event with no site to choose.
 */
const fallCamporeeLocations: readonly TemplateLocation[] = [
  { name: "Iowa", address: null, capacity: null, firstDayOffset: null, lastDayOffset: null, registrationClosesOffset: null },
  { name: "Missouri", address: null, capacity: null, firstDayOffset: null, lastDayOffset: null, registrationClosesOffset: null },
];

export const starterEventTemplates: readonly StarterEventTemplate[] = [
  { starterKey: "blank_event", name: "Blank event", formTemplateKey: "blank_form", audience: "GENERAL", billingMode: "ATTENDEE_PAY", collectsShirtSizes: false, checksAdultBackgrounds: false },
  { starterKey: "blank_club_event", name: "Blank club event", formTemplateKey: "blank_club_form", audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", collectsShirtSizes: false, checksAdultBackgrounds: true },
  { starterKey: "womens_retreat", name: "Women's Retreat", formTemplateKey: "womens_retreat_export", audience: "GENERAL", billingMode: "ATTENDEE_PAY", collectsShirtSizes: true, checksAdultBackgrounds: false },
  { starterKey: "man_camp", name: "Man Camp", formTemplateKey: "man_camp_export", audience: "GENERAL", billingMode: "ATTENDEE_PAY", collectsShirtSizes: true, checksAdultBackgrounds: false },
  { starterKey: "spring_camporee", name: "Spring Camporee", formTemplateKey: "spring_camporee_export", audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", collectsShirtSizes: false, checksAdultBackgrounds: true },
  { starterKey: "fall_camporee", name: "Fall Camporee", formTemplateKey: "fall_camporee", audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", collectsShirtSizes: false, checksAdultBackgrounds: true, locations: fallCamporeeLocations },
  { starterKey: "camp_meeting", name: "Camp Meeting", formTemplateKey: "camp_meeting_export", audience: "GENERAL", billingMode: "ATTENDEE_PAY", collectsShirtSizes: false, checksAdultBackgrounds: false },
  { starterKey: "honors_weekend", name: "Honors Weekend", formTemplateKey: "honors_weekend", audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", collectsShirtSizes: false, checksAdultBackgrounds: true },
];

/** Real events with no form template yet: listed, never created. None are pending now that Fall Camporee has a starter (#593). */
export const pendingStarterEvents: readonly { starterKey: string; name: string; note: string }[] = [];

/** Whether a built-in form template carries prices, late pricing or choice limits of its own. */
function formCarriesPrices(formTemplateKey: string) {
  const form = getFormTemplate(formTemplateKey);
  return form ? /"(priceCents|choicePricesCents|creditCentsPerUnit|latePricing|choiceLimits)"/.test(JSON.stringify(form.definition)) : false;
}

export function starterDescription(starter: StarterEventTemplate) {
  const form = getFormTemplate(starter.formTemplateKey);
  if (isBlankFormTemplateKey(starter.formTemplateKey)) {
    return `Starter set: a blank ${starter.audience === "CLUB" ? "club " : ""}event created from the built-in "${form?.name ?? "Blank form"}" form (${starter.formTemplateKey}). It has a contact${starter.audience === "CLUB" ? " and club roster" : ""} section and no prices or capacity. Add your own questions on the draft event.`;
  }
  if (starter.locations?.length) {
    const names = starter.locations.map((location) => location.name).join(" and ");
    return `Starter set: created from the built-in "${form?.name ?? starter.name}" form (${starter.formTemplateKey}) with church billing and adult background checks on. It creates two locations, ${names}, with no dates. Fill in the sites and dates under Event settings > Locations. This template sets no prices or capacity: set the Fall Camporee fee on the draft event before publishing.`;
  }
  const source = form ? `the built-in "${form.name}" form (${starter.formTemplateKey})` : `the ${starter.formTemplateKey} form`;
  const priceNote = formCarriesPrices(starter.formTemplateKey)
    ? "The form keeps last year's prices, late-price dates and choice limits. Review them on the draft event before publishing."
    : "The form has no prices set. Set any fee on the draft event before publishing.";
  return `Starter set: created from ${source}. This template sets no prices or capacity. ${priceNote}`;
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
    ...(starter.locations ? { locations: starter.locations.map((location) => ({ ...location })) } : {}),
  });
}
