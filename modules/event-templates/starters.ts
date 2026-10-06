import { getFormTemplate, isBlankFormTemplateKey } from "@/modules/forms/definition";
import { unpricedFeeFieldLabels } from "@/modules/events/readiness";
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
 * size, adult Sterling Volunteers for the club events.
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
  /** Extra sentence for the starter's description: what staff must check on the draft (#606). */
  note?: string;
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
  // #606. Individuals register (GENERAL) and the church or school is billed later: the platform allows
  // church billing on a GENERAL event, and only the club portal needs CLUB. These forms take no online payment.
  {
    starterKey: "leadership_weekend", name: "Pathfinder Leadership Weekend", formTemplateKey: "leadership_weekend", audience: "GENERAL", billingMode: "DEFERRED_ORGANIZATION_INVOICE", collectsShirtSizes: false, checksAdultBackgrounds: false,
    note: "Each leader registers as an individual and their church is billed after the event, so nothing is paid online. The August 24 early-bird date is the 2026 one.",
  },
  {
    starterKey: "tlt_retreat", name: "TLT Retreat", formTemplateKey: "tlt_retreat", audience: "GENERAL", billingMode: "ATTENDEE_PAY", collectsShirtSizes: false, checksAdultBackgrounds: false,
    note: "The retreat is free. The form serves the spring and fall retreats: remove the recommendation-forms question for the fall retreat.",
  },
  {
    starterKey: "outdoor_school", name: "Outdoor School", formTemplateKey: "outdoor_school", audience: "GENERAL", billingMode: "DEFERRED_ORGANIZATION_INVOICE", collectsShirtSizes: false, checksAdultBackgrounds: false,
    note: "A school registers its students and is billed after the event, so nothing is paid online.",
  },
  {
    starterKey: "hispanic_institute", name: "Hispanic Institute of Evangelism", formTemplateKey: "hispanic_institute", audience: "GENERAL", billingMode: "ATTENDEE_PAY", collectsShirtSizes: false, checksAdultBackgrounds: false,
    note: "The $50 semester registration is the 2026 price. Card payments use the platform's card-fee setting.",
  },
];

/** Real events with no form template yet: listed, never created. None are pending now that Fall Camporee has a starter (#593). */
export const pendingStarterEvents: readonly { starterKey: string; name: string; note: string }[] = [];

/** Which price features a built-in form template carries: prices, late pricing, choice limits. */
function formPriceFeatures(formTemplateKey: string) {
  const form = getFormTemplate(formTemplateKey);
  const json = form ? JSON.stringify(form.definition) : "";
  return {
    prices: /"(priceCents|choicePricesCents|creditCentsPerUnit)"/.test(json),
    latePricing: /"latePricing"/.test(json),
    choiceLimits: /"choiceLimits"/.test(json),
  };
}

/** Whether a built-in form template carries prices, late pricing or choice limits of its own. */
function formCarriesPrices(formTemplateKey: string) {
  const features = formPriceFeatures(formTemplateKey);
  return features.prices || features.latePricing || features.choiceLimits;
}

export function starterDescription(starter: StarterEventTemplate) {
  const form = getFormTemplate(starter.formTemplateKey);
  if (isBlankFormTemplateKey(starter.formTemplateKey)) {
    return `Starter set: a blank ${starter.audience === "CLUB" ? "club " : ""}event created from the built-in "${form?.name ?? "Blank form"}" form (${starter.formTemplateKey}). It has a contact${starter.audience === "CLUB" ? " and club roster" : ""} section and no prices or capacity. Add your own questions on the draft event.`;
  }
  if (starter.locations?.length) {
    const names = starter.locations.map((location) => location.name).join(" and ");
    return `Starter set: created from the built-in "${form?.name ?? starter.name}" form (${starter.formTemplateKey}) with church billing and the adult Sterling Volunteers requirement on. It creates two locations, ${names}, with no dates. Fill in the sites and dates under Event settings > Locations. This template sets no prices or capacity: set the Fall Camporee fee on the draft event before publishing.`;
  }
  const source = form ? `the built-in "${form.name}" form (${starter.formTemplateKey})` : `the ${starter.formTemplateKey} form`;
  const features = formPriceFeatures(starter.formTemplateKey);
  const kept = ["prices", ...(features.latePricing ? ["late-price dates"] : []), ...(features.choiceLimits ? ["choice limits"] : [])];
  const keptText = kept.length > 1 ? `${kept.slice(0, -1).join(", ")} and ${kept[kept.length - 1]}` : kept[0];
  const unsetFees = unpricedFeeFieldLabels(form?.definition ?? { sections: [] });
  // One price sentence, said once: kept prices, an unset fee, or no fee at all. The template itself never sets capacity.
  const priceNote = formCarriesPrices(starter.formTemplateKey)
    ? `The form keeps last year's ${keptText}. Review them on the draft event before publishing.`
    : unsetFees.length > 0
      ? `The form has no prices set: set the ${unsetFees.join(" and the ")} on the draft event before publishing.`
      : "The form has no fees.";
  return `Starter set: created from ${source}. ${priceNote} This template sets no capacity.${starter.note ? ` ${starter.note}` : ""}`;
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
