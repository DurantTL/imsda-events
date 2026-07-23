import { z } from "zod";

export const formFieldTypes = ["TEXT", "LONG_TEXT", "EMAIL", "PHONE", "SELECT", "RADIO", "MULTISELECT", "RANKED_CHOICE", "CHECKBOX", "DATE", "NUMBER", "CALCULATED"] as const;
export const formFieldScopes = ["REGISTRATION", "ATTENDEE"] as const;
export const choiceFieldTypes = ["SELECT", "RADIO", "MULTISELECT", "RANKED_CHOICE"] as const;
export const conditionOperators = ["EQUALS", "NOT_EQUALS", "INCLUDES", "NOT_EMPTY"] as const;
export const availabilityModes = ["NONE", "CAPACITY", "RANKED_INTEREST"] as const;
const attendeeNameKeys = ["full_name", "name", "attendee_name", "guest_name"] as const;

const priceCentsSchema = z.number().int().min(0).max(10000000);
const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date in YYYY-MM-DD format.").refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, "Enter a valid calendar date.");

export function isChoiceFieldType(type: string): type is typeof choiceFieldTypes[number] {
  return choiceFieldTypes.includes(type as typeof choiceFieldTypes[number]);
}

export function getAvailabilityMode(field: Pick<RegistrationFormField, "type" | "choiceLimits" | "availabilityMode">) {
  if (field.availabilityMode) return field.availabilityMode;
  if (field.choiceLimits !== undefined) return field.type === "RANKED_CHOICE" ? "RANKED_INTEREST" : "CAPACITY";
  return "NONE";
}

export const formFieldSchema = z.object({
  id: z.string().trim().min(3).max(80),
  key: z.string().trim().min(2).max(60).regex(/^[a-z][a-z0-9_]*$/, "Field keys use lowercase letters, numbers, and underscores."),
  label: z.string().trim().min(2, "Every field needs a label.").max(120),
  helpText: z.string().trim().max(240).default(""),
  placeholder: z.string().trim().max(120).optional(),
  type: z.enum(formFieldTypes),
  scope: z.enum(formFieldScopes),
  required: z.boolean(),
  options: z.array(z.string().trim().min(1).max(120)).max(200).default([]),
  minSelections: z.number().int().min(1).max(10).optional(),
  maxSelections: z.number().int().min(1).max(10).optional(),
  availabilityMode: z.enum(availabilityModes).optional(),
  choiceLimits: z.record(z.string(), z.number().int().min(1).max(10000)).optional(),
  priceCents: priceCentsSchema.optional(),
  choicePricesCents: z.record(z.string(), priceCentsSchema).optional(),
  latePricing: z.object({
    startsOn: calendarDateSchema,
    label: z.string().trim().min(2).max(80).default("Late registration pricing"),
    priceCents: priceCentsSchema.optional(),
    choicePricesCents: z.record(z.string(), priceCentsSchema).optional(),
  }).optional(),
  conditional: z.object({ fieldKey: z.string().trim().min(2).max(60), operator: z.enum(conditionOperators), value: z.string().max(120).default("") }).optional(),
}).superRefine((field, context) => {
  if (isChoiceFieldType(field.type) && field.options.length < 2) {
    context.addIssue({ code: "custom", path: ["options"], message: "Choice fields need at least two choices." });
  }
  if ((field.type === "MULTISELECT" || field.type === "RANKED_CHOICE") && field.maxSelections && field.maxSelections > field.options.length) {
    context.addIssue({ code: "custom", path: ["maxSelections"], message: "Maximum selections cannot exceed the number of choices." });
  }
  if ((field.type === "MULTISELECT" || field.type === "RANKED_CHOICE") && field.minSelections && field.maxSelections && field.minSelections > field.maxSelections) {
    context.addIssue({ code: "custom", path: ["minSelections"], message: "Minimum selections cannot exceed the maximum." });
  }
  for (const choice of Object.keys(field.choiceLimits ?? {})) {
    if (!field.options.includes(choice)) context.addIssue({ code: "custom", path: ["choiceLimits", choice], message: "Choice limits must reference a configured choice." });
  }
  for (const choice of Object.keys(field.choicePricesCents ?? {})) {
    if (!field.options.includes(choice)) context.addIssue({ code: "custom", path: ["choicePricesCents", choice], message: "Choice prices must reference a configured choice." });
  }
  for (const choice of Object.keys(field.latePricing?.choicePricesCents ?? {})) {
    if (!field.options.includes(choice)) context.addIssue({ code: "custom", path: ["latePricing", "choicePricesCents", choice], message: "Late choice prices must reference a configured choice." });
  }
  if (field.latePricing && field.priceCents === undefined && !field.choicePricesCents) {
    context.addIssue({ code: "custom", path: ["latePricing"], message: "Late pricing requires a regular field or choice price." });
  }
});

export const formSectionSchema = z.object({
  id: z.string().trim().min(3).max(80),
  title: z.string().trim().min(2, "Every section needs a title.").max(120),
  description: z.string().trim().max(300).default(""),
  fields: z.array(formFieldSchema).min(1, "Every section needs at least one field.").max(20),
});

export const registrationFormDefinitionSchema = z.object({
  title: z.string().trim().min(3, "Form title must be at least 3 characters.").max(120),
  description: z.string().trim().max(500).default(""),
  confirmationMessage: z.string().trim().min(3).max(500),
  sections: z.array(formSectionSchema).min(1, "Add at least one section.").max(12),
  attendeeRoster: z.object({
    enabled: z.boolean(),
    minAttendees: z.number().int().min(1).max(50).default(1),
    maxAttendees: z.number().int().min(1).max(50).default(8),
    attendeeLabel: z.string().trim().min(2).max(40).default("Attendee"),
    addButtonLabel: z.string().trim().min(2).max(80).default("Add another attendee"),
  }).optional(),
  payment: z.object({
    enabled: z.boolean(),
    currency: z.literal("USD").default("USD"),
    paymentMethodFieldKey: z.string().trim().min(2).max(60),
    cardOptionValue: z.string().trim().min(1).max(120),
    percentageBasisPoints: z.number().int().min(0).max(2000).default(290),
    fixedFeeCents: z.number().int().min(0).max(1000).default(30),
    passFeeToRegistrant: z.boolean().default(true),
  }).optional(),
}).superRefine((definition, context) => {
  const sectionIds = new Set<string>();
  const fieldIds = new Set<string>();
  const fieldKeys = new Set<string>();
  definition.sections.forEach((section, sectionIndex) => {
    if (sectionIds.has(section.id)) context.addIssue({ code: "custom", path: ["sections", sectionIndex, "id"], message: "Section IDs must be unique." });
    sectionIds.add(section.id);
    section.fields.forEach((field, fieldIndex) => {
      if (fieldIds.has(field.id)) context.addIssue({ code: "custom", path: ["sections", sectionIndex, "fields", fieldIndex, "id"], message: "Field IDs must be unique." });
      if (fieldKeys.has(field.key)) context.addIssue({ code: "custom", path: ["sections", sectionIndex, "fields", fieldIndex, "key"], message: `Field key ${field.key} is already in use.` });
      fieldIds.add(field.id);
      fieldKeys.add(field.key);
      if (
        field.key === "promo_code"
        && (
          field.type !== "TEXT"
          || field.scope !== "REGISTRATION"
          || field.required
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["sections", sectionIndex, "fields", fieldIndex],
          message: "The Promo code module must remain an optional registration-level short text field.",
        });
      }
    });
  });
  definition.sections.forEach((section, sectionIndex) => section.fields.forEach((field, fieldIndex) => {
    if (field.conditional && (!fieldKeys.has(field.conditional.fieldKey) || field.conditional.fieldKey === field.key)) context.addIssue({ code: "custom", path: ["sections", sectionIndex, "fields", fieldIndex, "conditional"], message: "Conditional logic must reference another configured field." });
    const controller = field.conditional
      ? definition.sections.flatMap((candidate) => candidate.fields).find((candidate) => candidate.key === field.conditional?.fieldKey)
      : null;
    if (field.scope === "REGISTRATION" && controller?.scope === "ATTENDEE") {
      context.addIssue({ code: "custom", path: ["sections", sectionIndex, "fields", fieldIndex, "conditional"], message: "A registration-level field cannot depend on an attendee answer." });
    }
  }));
  const allFields = definition.sections.flatMap((section) => section.fields);
  const paymentField = definition.payment ? allFields.find((field) => field.key === definition.payment?.paymentMethodFieldKey) : null;
  if (definition.payment && !paymentField) context.addIssue({ code: "custom", path: ["payment", "paymentMethodFieldKey"], message: "Payment settings must reference a configured payment-method field." });
  if (definition.payment && paymentField?.scope === "ATTENDEE") context.addIssue({ code: "custom", path: ["payment", "paymentMethodFieldKey"], message: "The payment method must apply to the registration, not each attendee." });
  if (definition.attendeeRoster?.enabled) {
    if (definition.attendeeRoster.minAttendees > definition.attendeeRoster.maxAttendees) {
      context.addIssue({ code: "custom", path: ["attendeeRoster", "minAttendees"], message: "Minimum attendees cannot exceed the maximum." });
    }
    const attendeeFields = allFields.filter((field) => field.scope === "ATTENDEE");
    if (attendeeFields.length === 0) {
      context.addIssue({ code: "custom", path: ["attendeeRoster"], message: "Repeatable rosters require at least one attendee-level field." });
    }
    const hasSplitName = attendeeFields.some((field) => field.key === "first_name")
      && attendeeFields.some((field) => field.key === "last_name");
    const hasFullName = attendeeFields.some((field) => attendeeNameKeys.includes(field.key as typeof attendeeNameKeys[number]));
    if (!hasSplitName && !hasFullName) {
      context.addIssue({ code: "custom", path: ["attendeeRoster"], message: "Repeatable rosters require attendee first/last name fields or a supported full-name field." });
    }
    const hasRequiredSplitName = attendeeFields.some((field) => field.key === "first_name" && field.required && !field.conditional)
      && attendeeFields.some((field) => field.key === "last_name" && field.required && !field.conditional);
    const hasRequiredFullName = attendeeFields.some((field) => (
      attendeeNameKeys.includes(field.key as typeof attendeeNameKeys[number])
      && field.required
      && !field.conditional
    ));
    if ((hasSplitName || hasFullName) && !hasRequiredSplitName && !hasRequiredFullName) {
      context.addIssue({
        code: "custom",
        path: ["attendeeRoster"],
        message: "Each roster entry needs an always-visible required attendee name. Require both first and last name, or one supported full-name field.",
      });
    }
  }
});

export type RegistrationFormDefinition = z.infer<typeof registrationFormDefinitionSchema>;
export type RegistrationFormField = z.infer<typeof formFieldSchema>;
export type ChoiceUsage = Record<string, Record<string, { total: number; first: number; second: number }>>;
export type FormCalculation = { subtotalCents: number; processingFeeCents: number; totalCents: number; lineItems: Array<{ key: string; label: string; amountCents: number; pricingLabel?: string; attendeeIndex?: number; attendeeLabel?: string }> };
export type AttendeeRosterConfig = {
  enabled: boolean;
  minAttendees: number;
  maxAttendees: number;
  attendeeLabel: string;
  addButtonLabel: string;
};

export type FormTemplate = {
  key: string;
  name: string;
  description: string;
  audience: string;
  definition: RegistrationFormDefinition;
};

function templateField(id: string, key: string, label: string, type: RegistrationFormField["type"], required = false, options: string[] = [], extra: Partial<RegistrationFormField> = {}): RegistrationFormField {
  return { id, key, label, helpText: "", type, scope: "REGISTRATION", required, options, ...extra };
}

const imsdaChurchOptions = [
  "Albany SDA Church",
  "Albia SDA Church",
  "Ames SDA Church",
  "Ankeny SDA Church",
  "Atlantic SDA Church",
  "Ava SDA Church",
  "Bedford SDA Church",
  "Belton 3 Angels SDA Company",
  "Bolivar SDA Church",
  "Boone SDA Church",
  "Boonville SDA Church",
  "Bourbon SDA Church",
  "Branson East SDA Church",
  "Burlington SDA Church",
  "Butler Living Word SDA Company",
  "Campbell SDA Church",
  "Cape Girardeau SDA Church",
  "Carthage SDA Church",
  "Carthage Hispanic SDA Company",
  "Cedar Rapids SDA Church",
  "Centerville SDA Church",
  "Charles City SDA Church",
  "Clinton (IA) SDA Church",
  "Clinton (MO) SDA Church",
  "Columbia Hope SDA",
  "Columbia SDA Church",
  "Council Bluffs SDA Church",
  "Davenport SDA Church",
  "Des Moines Karen SDA Company",
  "Des Moines Mizo SDA Company",
  "Des Moines SDA Church",
  "Des Moines Spanish SDA Church",
  "Doniphan SDA Church",
  "Dubuque SDA Church",
  "Exira SDA Church",
  "Fairfield SDA Church",
  "Farmington SDA Church",
  "Fort Dodge SDA Church",
  "Fort Madison SDA Church",
  "Fredericktown SDA Church",
  "Fulton SDA Church",
  "Gallatin SDA Church",
  "Gladstone SDA Church",
  "Guthrie Center SDA Church",
  "Hampton SDA Church",
  "Hannibal SDA Church",
  "Harlan SDA Church",
  "Hawkeye SDA Church",
  "Houston SDA Fellowship",
  "Independence SDA Church",
  "Independence Ebenezer Spanish SDA Church",
  "Independence Samoan-English SDA Church",
  "Iowa City Hispanic Group",
  "Iowa City SDA Church",
  "Jefferson City SDA Church",
  "Joplin SDA Church",
  "Kahoka SDA Church",
  "Kansas City Central SDA Church",
  "Kansas City Latin-American SDA Church",
  "Kansas City Ububyutse SDA Group",
  "Kimberling City SDA Church",
  "Kingsville Adventist Church",
  "Kirksville SDA Church",
  "Knoxville SDA Church",
  "Lake of the Ozarks SDA Church",
  "Lamar SDA Church",
  "Lebanon SDA Church",
  "Lee's Summit SDA Church",
  "Lewistown SDA Company",
  "Lineville Group",
  "Macon SDA Church",
  "Marceline SDA Church",
  "Marshall SDA Church",
  "Marshalltown SDA Church",
  "Mason City SDA Church",
  "Mexico SDA Church",
  "Moberly SDA Church",
  "Monett Bilingual SDA Company",
  "Mountain Grove SDA Church",
  "Multicultural Church for the Community",
  "Muscatine SDA Church",
  "Neosho Granby SDA Church",
  "Nevada IA SDA Church",
  "Nevada MO SDA Church",
  "Newton SDA Church",
  "Nixa SDA Church",
  "Nixa Slavic Seventh-day Adventist Church of Hope",
  "NC4Y",
  "Oak Grove SDA Church",
  "Oak Grove Heights SDA Church",
  "Osceola SDA Church",
  "Ottumwa SDA Church",
  "Poplar Bluff SDA Church",
  "Prescott SDA School",
  "Republic New Horizons SDA Church",
  "Richville SDA Church",
  "Riverside Hispanic SDA Church",
  "Rolla SDA Church",
  "Salem SDA Church",
  "Sedalia SDA Church",
  "Sedalia SDA School",
  "Sikeston Peace Point Chapel",
  "Sioux City SDA Church",
  "South West City Spanish Company",
  "Spencer SDA Church",
  "Springfield SDA Church",
  "Springfield Seventh-day Adventist Jr Aca",
  "St James Hope SDA Group",
  "St Joseph Hispanic SDA Company",
  "St Joseph Three Angels SDA Church",
  "St Louis Central SDA Church",
  "St Louis Immanuel SDA Group",
  "St Louis Korean SDA Church",
  "St Louis Mid-Rivers SDA Church",
  "St Louis Southside French SDA Group",
  "St Louis Southside SDA Church",
  "St Louis Spanish SDA Church",
  "St Louis Urumuri (Light House) SDA",
  "St Louis West County SDA Church",
  "Sullivan SDA Church",
  "Summersville (MO) SDA Group",
  "Summit View Adventist School",
  "Sunnydale Adventist Academy",
  "Sunnydale SDA Church",
  "Sunnydale SDA Elementary School",
  "Trenton-Chillicothe SDA Church",
  "Warrensburg Crossroads SDA Church",
  "Waterloo SDA Church",
  "Waukon SDA Church",
  "Waynesville SDA Church",
  "West Des Moines (Jordan Crossing) SDA Co",
  "West Plains SDA Church",
  "Willow Springs SDA Church",
  "Winterset SDA Church",
  "Woodland Hills SDA",
  "Other",
];

const pathfinderClubOptions = [
  "Ankeny Son-Seekers",
  "Branson East",
  "Cape Girardeau",
  "Cedar Rapids",
  "College Park",
  "Coordinators",
  "Davenport Soaring Eagles",
  "Des Moines Navigators",
  "Des Moines Spanish",
  "Ebenezer",
  "Fulton Foxes",
  "Gladstone",
  "Houston Knights",
  "KC Alpha & Omega",
  "Latin American",
  "Macon Messengers",
  "Moberly Prospectors",
  "Mtn Grove Trailblazers",
  "Muscatine",
  "NC4Y",
  "Nevada Frogs",
  "Nevada MO",
  "Oak Grove Heights",
  "Ottumwa",
  "Sedalia",
  "Sikeston Spartans",
  "Springfield",
  "St Louis Mid-Rivers Cats",
  "St Louis West County Pioneers",
  "St Louis Maranata",
  "Sunnydale",
  "Other",
  "Waterloo Blackhawks",
  "West Plain Warriors",
];

const manCampRegistrationPackages = [
  "Shared cabin — connected restroom",
  "Shared cabin — detached restroom",
  "RV hookup",
  "Tent camping",
  "Sabbath attendance only",
  "Volunteer — no registration fee",
];

const campMeetingHousingOptions = [
  "Dorm room",
  "RV / camper hookup",
  "Tent campsite",
  "No housing needed",
];

const campMeetingNights = ["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const formTemplates: FormTemplate[] = [
  {
    key: "simple_rsvp",
    name: "Simple RSVP",
    description: "A short individual response form for meals, meetings, and simple events.",
    audience: "Individual",
    definition: {
      title: "Event RSVP",
      description: "Reserve your place and provide the best way to reach you.",
      confirmationMessage: "Thank you. Your RSVP has been received.",
      sections: [{ id: "section_contact", title: "Your information", description: "Tell us who is attending.", fields: [
        { id: "field_first_name", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: "field_last_name", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: "field_email", key: "email", label: "Email address", helpText: "We will send event updates here.", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
      ] }],
    },
  },
  {
    key: "retreat_registration",
    name: "Retreat registration",
    description: "Contact, attendance, and lodging questions for a weekend retreat.",
    audience: "Individual or household",
    definition: {
      title: "Women’s Retreat registration",
      description: "Complete this form for each person attending.",
      confirmationMessage: "Your registration has been received.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 8, attendeeLabel: "Attendee", addButtonLabel: "Add another attendee" },
      sections: [
        { id: "section_attendee", title: "Attendee details", description: "Information specific to the person attending.", fields: [
          { id: "field_first_name", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
          { id: "field_last_name", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
          { id: "field_attendee_type", key: "attendee_type", label: "Registration type", helpText: "Choose the closest match.", type: "SELECT", scope: "ATTENDEE", required: true, options: ["Attendee", "Worker"] },
        ] },
        { id: "section_contact", title: "Contact & stay", description: "Used for this event registration.", fields: [
          { id: "field_email", key: "email", label: "Email address", helpText: "Registration confirmation and event updates use this address.", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
          { id: "field_phone", key: "phone", label: "Mobile phone", helpText: "", type: "PHONE", scope: "REGISTRATION", required: false, options: [] },
          { id: "field_lodging", key: "lodging", label: "Lodging preference", helpText: "Choose what best fits this attendee’s plans.", type: "SELECT", scope: "ATTENDEE", required: true, options: ["Conference hotel", "Commuting", "Not sure yet"] },
        ] },
      ],
    },
  },
  {
    key: "household_interest",
    name: "Household interest",
    description: "A lightweight household-oriented form without pricing or payment collection.",
    audience: "Household",
    definition: {
      title: "Household event interest",
      description: "Share a household contact and an estimated party size.",
      confirmationMessage: "Thank you. Your household response has been received.",
      sections: [{ id: "section_household", title: "Household contact", description: "One response per household.", fields: [
        { id: "field_household_name", key: "household_name", label: "Household name", helpText: "For example, Miller household.", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
        { id: "field_email", key: "email", label: "Primary email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
        { id: "field_party_size", key: "party_size", label: "Estimated party size", helpText: "", type: "NUMBER", scope: "REGISTRATION", required: true, options: [] },
      ] }],
    },
  },
  {
    key: "womens_retreat_export",
    name: "Women’s Retreat 2026",
    description: "Primary contact, repeatable attendee roster, meals, childcare, ranked seminars, late pricing, and payment.",
    audience: "Retreat",
    definition: {
      title: "Women’s Retreat 2026 registration",
      description: "Register each attendee, rank two choices for every breakout block, and review the full amount before submitting.",
      confirmationMessage: "Your Women’s Retreat registration has been received. Check your email for payment and edit-registration details.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 12, attendeeLabel: "Attendee", addButtonLabel: "Add another attendee" },
      payment: { enabled: true, currency: "USD", paymentMethodFieldKey: "payment_method", cardOptionValue: "Credit / debit card", percentageBasisPoints: 290, fixedFeeCents: 30, passFeeToRegistrant: true },
      sections: [
        { id: "wr_contact", title: "Primary contact", description: "Confirmation and emergency contact details.", fields: [
          templateField("wr_contact_first", "primary_contact_first_name", "Primary contact first name", "TEXT", true),
          templateField("wr_contact_last", "primary_contact_last_name", "Primary contact last name", "TEXT", true),
          templateField("wr_email", "email", "Primary contact email", "EMAIL", true),
          templateField("wr_phone", "phone", "Primary contact phone", "PHONE", true),
          templateField("wr_church", "church", "Church", "SELECT", true, imsdaChurchOptions),
          templateField("wr_church_other", "church_other", "Church — other or notes", "TEXT", true, [], { conditional: { fieldKey: "church", operator: "EQUALS", value: "Other" } }),
          templateField("wr_emergency_name", "emergency_contact_name", "Emergency contact name", "TEXT", true),
          templateField("wr_emergency_phone", "emergency_contact_phone", "Emergency contact phone", "PHONE", true),
          templateField("wr_special", "special_needs", "Special needs / accessibility", "LONG_TEXT"),
        ] },
        { id: "wr_attendee", title: "Attendees", description: "Add each person once. Meal, childcare, and seminar answers stay with that attendee.", fields: [
          templateField("wr_attendee_first", "first_name", "First name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("wr_attendee_last", "last_name", "Last name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("wr_attendee_phone", "attendee_phone", "Phone", "PHONE", false, [], { scope: "ATTENDEE" }),
          templateField("wr_type", "attendee_type", "Attendee type", "RADIO", true, ["Adult", "Teen", "Child"], { scope: "ATTENDEE" }),
          templateField("wr_meal", "meal_preference", "Meal preference", "SELECT", true, ["Standard", "Vegetarian", "Vegan", "Gluten-free", "Other"], { scope: "ATTENDEE" }),
          templateField("wr_dietary", "dietary_needs", "Dietary needs / allergies", "LONG_TEXT", false, [], { scope: "ATTENDEE" }),
          templateField("wr_childcare", "childcare_needed", "Childcare needed?", "RADIO", false, ["No", "Yes"], { scope: "ATTENDEE" }),
          templateField("wr_childcare_details", "childcare_details", "Childcare ages and notes", "LONG_TEXT", false, [], { scope: "ATTENDEE", conditional: { fieldKey: "childcare_needed", operator: "EQUALS", value: "Yes" } }),
          templateField("wr_session_1", "session_1_preferences", "Friday 4:00–5:00 PM — rank both choices", "RANKED_CHOICE", true, ["Color Me Golden: Embracing Life in Every Season", "Refined by Fire, Revealed in Beauty"], { scope: "ATTENDEE", minSelections: 2, maxSelections: 2, availabilityMode: "RANKED_INTEREST", choiceLimits: {} }),
          templateField("wr_session_2", "session_2_preferences", "Sabbath 2:00–3:15 PM — rank two choices", "RANKED_CHOICE", true, ["Repainted by Grace", "Color Me Open", "Nourished by Color", "Color Me Prayerful"], { scope: "ATTENDEE", minSelections: 2, maxSelections: 2, availabilityMode: "RANKED_INTEREST", choiceLimits: {} }),
          templateField("wr_session_3", "session_3_preferences", "Sabbath 4:15–5:30 PM — rank two choices", "RANKED_CHOICE", true, ["Shades of Peace", "Coloring Through the Chaos", "Broken Crayons Still Color"], { scope: "ATTENDEE", minSelections: 2, maxSelections: 2, availabilityMode: "RANKED_INTEREST", choiceLimits: {} }),
          templateField("wr_session_4", "session_4_attendance", "Sunday 8:15–9:15 AM — Brushstrokes of Leadership", "RADIO", true, ["Attending", "Not attending"], { scope: "ATTENDEE" }),
          templateField("wr_fee", "registration_fee", "Registration fee", "CALCULATED", false, [], { scope: "ATTENDEE", priceCents: 12500, latePricing: { startsOn: "2026-08-15", label: "Regular registration pricing", priceCents: 14500 } }),
        ] },
        { id: "wr_payment", title: "Payment & acknowledgment", description: "Choose how you would like to pay and review the final amount.", fields: [
          templateField("wr_payment_method", "payment_method", "Payment method", "RADIO", true, ["Pay later", "Credit / debit card"]),
          templateField("wr_promo", "promo_code", "Promo code", "TEXT", false, [], { helpText: "Enter a code supplied by the event team, then select Apply." }),
          templateField("wr_notes", "attendee_notes", "Additional notes", "LONG_TEXT", false),
          templateField("wr_ack", "acknowledgment", "Acknowledgment", "CHECKBOX", true, [], { placeholder: "Yes, I understand payment and edit details will be sent by email." }),
        ] },
      ],
    },
  },
  {
    key: "man_camp_export",
    name: "Man Camp 2026",
    description: "Contact and address, party roster, lodging packages, minors and guardians, apparel, dietary needs, and payment.",
    audience: "Camp",
    definition: {
      title: "Man Camp 2026 registration",
      description: "Register everyone in your party, choose each person’s lodging package, and review the total before payment.",
      confirmationMessage: "Your Man Camp registration has been received. A confirmation and payment summary will be sent by email.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 20, attendeeLabel: "Attendee", addButtonLabel: "Add another attendee" },
      payment: { enabled: true, currency: "USD", paymentMethodFieldKey: "payment_method", cardOptionValue: "Credit / debit card", percentageBasisPoints: 290, fixedFeeCents: 30, passFeeToRegistrant: true },
      sections: [
        { id: "mc_contact", title: "Primary contact & address", description: "The person who will receive the party confirmation and payment summary.", fields: [
          templateField("mc_primary_first", "primary_first_name", "First name", "TEXT", true),
          templateField("mc_primary_last", "primary_last_name", "Last name", "TEXT", true),
          templateField("mc_email", "email", "Email", "EMAIL", true),
          templateField("mc_phone", "phone", "Mobile phone", "PHONE", true),
          templateField("mc_address_1", "address_line_1", "Address line 1", "TEXT", true),
          templateField("mc_address_2", "address_line_2", "Address line 2", "TEXT"),
          templateField("mc_city", "city", "City", "TEXT", true),
          templateField("mc_state", "state", "State / province", "TEXT", true),
          templateField("mc_zip", "zip", "ZIP / postal code", "TEXT", true),
          templateField("mc_country", "country", "Country", "SELECT", true, ["United States", "Canada", "Other"]),
          templateField("mc_church", "church", "Church", "SELECT", true, imsdaChurchOptions),
          templateField("mc_church_other", "church_other", "Church — other", "TEXT", true, [], { conditional: { fieldKey: "church", operator: "EQUALS", value: "Other" } }),
          templateField("mc_primary_age", "primary_age", "Primary contact age", "NUMBER", true),
          templateField("mc_primary_accommodations", "primary_accommodations", "Accessibility or accommodation needs", "LONG_TEXT"),
        ] },
        { id: "mc_attendees", title: "Attendee roster", description: "Add every person, including yourself and volunteers. Young Men’s Program is for ages 10–14.", fields: [
          templateField("mc_first", "first_name", "First name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("mc_last", "last_name", "Last name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("mc_age", "attendee_age", "Age", "NUMBER", true, [], { scope: "ATTENDEE" }),
          templateField("mc_program", "program_selection", "Program", "SELECT", true, ["Adult program", "Young Men’s Program (ages 10–14)", "Child / family attendee", "Volunteer / event worker"], { scope: "ATTENDEE" }),
          templateField("mc_package", "registration_package", "Registration / lodging category", "RADIO", true, manCampRegistrationPackages, {
            scope: "ATTENDEE",
            helpText: "Choose the party’s lodging rate for paid attendees. Volunteers are not charged.",
            availabilityMode: "CAPACITY",
            choiceLimits: {},
            choicePricesCents: {
              "Shared cabin — connected restroom": 12000,
              "Shared cabin — detached restroom": 10000,
              "RV hookup": 9000,
              "Tent camping": 8000,
              "Sabbath attendance only": 7000,
              "Volunteer — no registration fee": 0,
            },
          }),
          templateField("mc_shirt", "shirt_size", "Shirt size", "SELECT", false, ["Youth S", "Youth M", "Youth L", "Adult S", "Adult M", "Adult L", "Adult XL", "Adult 2XL", "Adult 3XL"], { scope: "ATTENDEE", helpText: "Shirts are available for attendees registered by the event’s shirt deadline." }),
          templateField("mc_minor", "is_minor", "Is this attendee under 18?", "RADIO", true, ["No", "Yes"], { scope: "ATTENDEE" }),
          templateField("mc_guardian", "guardian_name", "Guardian attending at camp", "TEXT", true, [], { scope: "ATTENDEE", conditional: { fieldKey: "is_minor", operator: "EQUALS", value: "Yes" } }),
          templateField("mc_rv_amp", "rv_amp_service", "RV amp service", "RADIO", true, ["30 amp", "50 amp", "Either / not sure"], { scope: "ATTENDEE", conditional: { fieldKey: "registration_package", operator: "EQUALS", value: "RV hookup" } }),
          templateField("mc_rv_length", "rv_length", "RV length and type", "TEXT", true, [], { scope: "ATTENDEE", conditional: { fieldKey: "registration_package", operator: "EQUALS", value: "RV hookup" } }),
          templateField("mc_dietary", "dietary_needs", "Vegan, gluten-free, or food-allergy needs", "LONG_TEXT", false, [], { scope: "ATTENDEE", helpText: "All meals are vegetarian. Note vegan, gluten-free, and allergy needs." }),
          templateField("mc_accommodations", "accommodations", "Other accommodations", "LONG_TEXT", false, [], { scope: "ATTENDEE" }),
        ] },
        { id: "mc_payment", title: "Review & payment", description: "Card payments include the configured processing fee; cash or check does not.", fields: [
          templateField("mc_pay", "payment_method", "Payment option", "RADIO", true, ["Cash or check", "Credit / debit card"]),
          templateField("mc_notes", "registration_notes", "Party notes", "LONG_TEXT"),
        ] },
      ],
    },
  },
  {
    key: "spring_camporee_export",
    name: "Spring Camporee 2026",
    description: "Club contact, campsite footprint, complete roster, duties, activities, meal sponsorship, milestones, and late pricing.",
    audience: "Club / group",
    definition: {
      title: "Spring Camporee 2026 registration",
      description: "Register the club once, add every attendee, and choose duties and activities for the weekend.",
      confirmationMessage: "Your Spring Camporee registration has been received. The calculated registration amount will be invoiced.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Club member", addButtonLabel: "Add another club member" },
      sections: [
        { id: "sc_club", title: "Club & contact", description: "Select the Pathfinder club and enter the director’s contact information.", fields: [
          templateField("sc_club_name", "club_name", "Pathfinder club", "SELECT", true, pathfinderClubOptions),
          templateField("sc_club_other", "club_name_other", "Club name — other", "TEXT", true, [], { conditional: { fieldKey: "club_name", operator: "EQUALS", value: "Other" } }),
          templateField("sc_director", "director_name", "Club director", "TEXT", true),
          templateField("sc_church", "church_name", "Church", "SELECT", false, imsdaChurchOptions),
          templateField("sc_email", "email", "Email", "EMAIL", true),
          templateField("sc_phone", "phone", "Mobile phone", "PHONE", true),
        ] },
        { id: "sc_camping", title: "Camping", description: "Describe the full campsite footprint. No generators or pets; hookups require a medical need.", fields: [
          templateField("sc_tents", "tents", "Number of tents and sizes", "TEXT", true),
          templateField("sc_trailers", "trailers", "Trailers", "TEXT", true),
          templateField("sc_canopy", "kitchen_canopy", "Kitchen canopy and size", "TEXT", true),
          templateField("sc_sqft", "total_sqft", "Total square feet needed", "NUMBER", true),
          templateField("sc_neighbor", "camp_next_to", "Club you would like to camp next to", "TEXT"),
        ] },
        { id: "sc_roster", title: "Club roster", description: "Add Pathfinders, TLTs, staff, and children using full first and last names.", fields: [
          templateField("sc_member_first", "first_name", "First name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("sc_member_last", "last_name", "Last name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("sc_member_age", "attendee_age", "Age", "NUMBER", true, [], { scope: "ATTENDEE" }),
          templateField("sc_member_gender", "gender", "Gender", "SELECT", false, ["Female", "Male", "Prefer not to answer"], { scope: "ATTENDEE" }),
          templateField("sc_member_role", "attendee_type", "Roster role", "RADIO", true, ["Pathfinder", "TLT", "Staff", "Child"], { scope: "ATTENDEE" }),
          templateField("sc_member_medical_personnel", "medical_personnel", "Medical personnel?", "CHECKBOX", false, [], { scope: "ATTENDEE", conditional: { fieldKey: "attendee_type", operator: "EQUALS", value: "Staff" } }),
          templateField("sc_member_master_guide", "master_guide_investiture", "Master Guide investiture?", "CHECKBOX", false, [], { scope: "ATTENDEE", conditional: { fieldKey: "attendee_type", operator: "EQUALS", value: "Staff" } }),
          templateField("sc_member_dietary", "dietary_needs", "Dietary restrictions", "LONG_TEXT", false, [], { scope: "ATTENDEE" }),
          templateField("sc_member_medical", "medical_or_accessibility_notes", "Medical or accessibility notes", "LONG_TEXT", false, [], { scope: "ATTENDEE" }),
          templateField("sc_member_fee", "registration_fee", "Registration fee", "CALCULATED", false, [], { scope: "ATTENDEE", priceCents: 900, latePricing: { startsOn: "2026-04-11", label: "Late registration pricing", priceCents: 1400 } }),
        ] },
        { id: "sc_activities", title: "Schedule & activities", description: "Choose the club’s duties and activities. Duty choices can be given limits as assignments fill.", fields: [
          templateField("sc_duties", "duty_areas", "Required duty area", "MULTISELECT", true, ["Flag raising / lowering", "Bathroom clean-up"], { minSelections: 1, maxSelections: 2 }),
          templateField("sc_flag_slots", "flag_slots", "Flag raising / lowering times", "MULTISELECT", true, ["Thursday evening", "Friday morning", "Friday evening", "Saturday morning — TLTs", "Saturday evening"], { minSelections: 1, maxSelections: 5, availabilityMode: "CAPACITY", choiceLimits: {}, conditional: { fieldKey: "duty_areas", operator: "INCLUDES", value: "Flag raising / lowering" } }),
          templateField("sc_bathroom_days", "bathroom_days", "Bathroom clean-up days", "MULTISELECT", true, ["Thursday", "Friday", "Saturday", "Sunday morning"], { minSelections: 1, maxSelections: 4, availabilityMode: "CAPACITY", choiceLimits: {}, conditional: { fieldKey: "duty_areas", operator: "INCLUDES", value: "Bathroom clean-up" } }),
          templateField("sc_special_activities", "special_activities", "Club activities — choose at least one", "MULTISELECT", true, ["Lead mixer Thursday night at vespers", "Special music, poem or skit — Friday vespers", "Adult assist with Oregon Trail Friday afternoon", "Set up chairs in pavilion Friday 4 PM", "Lead singing around campfire at your campsite", "Special music, poem or skit — church or Sabbath School", "Bring a game and/or lead a game Saturday night"], { minSelections: 1, maxSelections: 5 }),
          templateField("sc_friday_type", "friday_special_type", "Friday vespers contribution", "RADIO", true, ["Special music", "Poem", "Skit"], { conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Special music, poem or skit — Friday vespers" } }),
          templateField("sc_friday_name", "friday_special_name", "Name of Friday special, poem, or skit", "TEXT", true, [], { conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Special music, poem or skit — Friday vespers" } }),
          templateField("sc_friday_av", "friday_av_equipment", "Friday AV equipment", "MULTISELECT", false, ["CD", "Apple device", "Computer", "AUX"], { maxSelections: 4, conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Special music, poem or skit — Friday vespers" } }),
          templateField("sc_church_type", "church_special_type", "Church / Sabbath School contribution", "RADIO", true, ["Special music", "Poem", "Skit"], { conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Special music, poem or skit — church or Sabbath School" } }),
          templateField("sc_church_name_special", "church_special_name", "Name of church or Sabbath School special", "TEXT", true, [], { conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Special music, poem or skit — church or Sabbath School" } }),
          templateField("sc_church_av", "church_av_equipment", "Church / Sabbath School AV equipment", "MULTISELECT", false, ["CD", "Apple device", "Computer", "AUX"], { maxSelections: 4, conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Special music, poem or skit — church or Sabbath School" } }),
          templateField("sc_campfire", "campfire_night", "Campfire singing night", "RADIO", true, ["Friday", "Saturday"], { conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Lead singing around campfire at your campsite" } }),
          templateField("sc_game_support", "game_support", "Saturday night game help", "MULTISELECT", true, ["Bring a game", "Lead a game"], { minSelections: 1, maxSelections: 2, conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Bring a game and/or lead a game Saturday night" } }),
          templateField("sc_game", "game_name", "Game name", "TEXT", true, [], { conditional: { fieldKey: "game_support", operator: "INCLUDES", value: "Bring a game" } }),
          templateField("sc_oregon", "oregon_trail_adult", "Adult assisting with Oregon Trail", "TEXT", true, [], { conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Adult assist with Oregon Trail Friday afternoon" } }),
          templateField("sc_sponsor", "sponsoring_meals", "Will the club sponsor meals?", "RADIO", true, ["No", "Yes"], { helpText: "A $5 per-person, per-meal credit is applied to the event invoice." }),
          templateField("sc_sponsor_count", "meal_sponsorship_count", "People sponsored per meal", "NUMBER", true, [], { conditional: { fieldKey: "sponsoring_meals", operator: "EQUALS", value: "Yes" } }),
          templateField("sc_meal_times", "meal_times", "Sponsored meal times", "MULTISELECT", true, ["Friday lunch", "Friday lunch — delivered to office", "Friday supper", "Friday supper — delivered to office", "Sabbath lunch", "Sabbath supper"], { minSelections: 1, maxSelections: 6, conditional: { fieldKey: "sponsoring_meals", operator: "EQUALS", value: "Yes" } }),
          templateField("sc_partner", "partner_club", "Partner club for events", "TEXT"),
          templateField("sc_ribbons", "event_ribbons", "Would your club like event ribbons?", "RADIO", true, ["Yes", "No"]),
          templateField("sc_skit", "sabbath_skit", "Name of the club’s Sabbath afternoon skit", "TEXT", true),
        ] },
        { id: "sc_milestones", title: "Spiritual milestones", description: "Optional names for pastoral and recognition follow-up.", fields: [
          templateField("sc_baptism", "baptism_names", "Names interested in baptism", "LONG_TEXT"),
          templateField("sc_bible", "bible_names", "Names who read the Bible through in a year", "LONG_TEXT"),
        ] },
      ],
    },
  },
  {
    key: "camp_meeting_export",
    name: "Camp Meeting 2026",
    description: "Household contact, capacity-aware housing by night, guest roster, adult and child meal tickets, and payment.",
    audience: "Household / camp",
    definition: {
      title: "Camp Meeting 2026 registration",
      description: "Choose housing and nights, add every guest, order meal tickets, and review the complete total.",
      confirmationMessage: "Your Camp Meeting registration has been received. Watch for an email with confirmation, payment, and check-in details.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 20, attendeeLabel: "Guest", addButtonLabel: "Add another guest" },
      payment: { enabled: true, currency: "USD", paymentMethodFieldKey: "payment_method", cardOptionValue: "Credit / debit card", percentageBasisPoints: 290, fixedFeeCents: 30, passFeeToRegistrant: true },
      sections: [
        { id: "cm_contact", title: "Contact information", description: "Primary household contact and mailing address.", fields: [
          templateField("cm_first", "primary_first_name", "First name", "TEXT", true),
          templateField("cm_middle", "primary_middle_name", "Middle name", "TEXT"),
          templateField("cm_last", "primary_last_name", "Last name", "TEXT", true),
          templateField("cm_address_1", "address_line_1", "Address line 1", "TEXT", true),
          templateField("cm_address_2", "address_line_2", "Address line 2", "TEXT"),
          templateField("cm_city", "city", "City", "TEXT", true),
          templateField("cm_state", "state", "State / province", "TEXT", true),
          templateField("cm_zip", "zip", "ZIP / postal code", "TEXT", true),
          templateField("cm_country", "country", "Country", "SELECT", true, ["United States", "Canada", "Other"]),
          templateField("cm_email", "email", "Email", "EMAIL", true),
          templateField("cm_phone", "phone", "Mobile phone", "PHONE", true),
          templateField("cm_church", "church_name", "Home church", "SELECT", false, imsdaChurchOptions),
          templateField("cm_church_other", "church_other", "Home church — other", "TEXT", true, [], { conditional: { fieldKey: "church_name", operator: "EQUALS", value: "Other" } }),
        ] },
        { id: "cm_housing", title: "Housing selection", description: "Pricing is per night. RV capacity begins at 16 spots and every housing limit can be adjusted.", fields: [
          templateField("cm_housing_choice", "housing_selection", "Housing", "RADIO", true, campMeetingHousingOptions, { availabilityMode: "CAPACITY", choiceLimits: { "RV / camper hookup": 16 } }),
          templateField("cm_dorm_nights", "dorm_nights", "Dorm nights — $25 per night", "MULTISELECT", true, campMeetingNights, { minSelections: 4, maxSelections: 5, choicePricesCents: Object.fromEntries(campMeetingNights.map((night) => [night, 2500])), conditional: { fieldKey: "housing_selection", operator: "EQUALS", value: "Dorm room" }, helpText: "Dorm rooms require at least four nights. Each room has two twin beds; bring linens." }),
          templateField("cm_rv_nights", "rv_nights", "RV / camper nights — $15 per night", "MULTISELECT", true, campMeetingNights, { minSelections: 1, maxSelections: 5, choicePricesCents: Object.fromEntries(campMeetingNights.map((night) => [night, 1500])), conditional: { fieldKey: "housing_selection", operator: "EQUALS", value: "RV / camper hookup" } }),
          templateField("cm_tent_nights", "tent_nights", "Tent campsite nights — $5 per night", "MULTISELECT", true, campMeetingNights, { minSelections: 1, maxSelections: 5, choicePricesCents: Object.fromEntries(campMeetingNights.map((night) => [night, 500])), conditional: { fieldKey: "housing_selection", operator: "EQUALS", value: "Tent campsite" }, helpText: "Primitive camping; no hookups or campfires." }),
          templateField("cm_floor", "first_floor_needed", "First-floor room needed for health or medical reasons?", "RADIO", true, ["No", "Yes"], { conditional: { fieldKey: "housing_selection", operator: "EQUALS", value: "Dorm room" } }),
          templateField("cm_rv", "rv_details", "RV / camper length and type", "TEXT", true, [], { conditional: { fieldKey: "housing_selection", operator: "EQUALS", value: "RV / camper hookup" } }),
        ] },
        { id: "cm_guests", title: "Guest information", description: "Enter the party totals, then add every adult and child—including yourself—to the guest roster.", fields: [
          templateField("cm_adults", "num_adults", "Number of adults (18 and older)", "NUMBER", true),
          templateField("cm_children", "num_children", "Number of children", "NUMBER", true),
          templateField("cm_guest_first", "first_name", "First name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("cm_guest_last", "last_name", "Last name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("cm_guest_age", "guest_age", "Age", "NUMBER", true, [], { scope: "ATTENDEE", helpText: "Children’s ages are used for Sabbath School class placement." }),
        ] },
        { id: "cm_meals", title: "Meal tickets", description: "Enter combined ticket totals for everyone. Sabbath lunch is donation-only and needs no ticket.", fields: [
          templateField("cm_bf_adult", "breakfast_adult_qty", "Adult breakfast tickets — $7 each", "NUMBER", false, [], { priceCents: 700, helpText: "Available Wednesday through Saturday." }),
          templateField("cm_bf_child", "breakfast_child_qty", "Child breakfast tickets — $6 each", "NUMBER", false, [], { priceCents: 600, helpText: "Available Wednesday through Saturday." }),
          templateField("cm_lunch_adult", "lunch_adult_qty", "Adult lunch tickets — $8 each", "NUMBER", false, [], { priceCents: 800, helpText: "Available Wednesday through Friday." }),
          templateField("cm_lunch_child", "lunch_child_qty", "Child lunch tickets — $7 each", "NUMBER", false, [], { priceCents: 700, helpText: "Available Wednesday through Friday." }),
          templateField("cm_supper_adult", "supper_adult_qty", "Adult supper tickets — $8 each", "NUMBER", false, [], { priceCents: 800, helpText: "Available Tuesday through Saturday." }),
          templateField("cm_supper_child", "supper_child_qty", "Child supper tickets — $7 each", "NUMBER", false, [], { priceCents: 700, helpText: "Available Tuesday through Saturday." }),
          templateField("cm_dietary", "dietary_restrictions", "Dietary restrictions or allergies", "LONG_TEXT"),
        ] },
        { id: "cm_payment", title: "Review & payment", description: "Card payments include the processing fee. Checks require a $65 deposit to hold the reservation.", fields: [
          templateField("cm_pay", "payment_method", "Payment method", "RADIO", true, ["Pay by check", "Credit / debit card"]),
          templateField("cm_deposit", "check_deposit_acknowledgment", "Check deposit acknowledgment", "CHECKBOX", true, [], { conditional: { fieldKey: "payment_method", operator: "EQUALS", value: "Pay by check" }, placeholder: "I understand a $65 mailed deposit is required to hold this reservation." }),
          templateField("cm_comments", "comments", "Comments", "LONG_TEXT"),
        ] },
      ],
    },
  },
];

export function getFormTemplate(key: string) {
  return formTemplates.find((template) => template.key === key) ?? null;
}

function hasValue(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

export function isFieldVisible(field: RegistrationFormField, responses: Record<string, unknown>) {
  if (!field.conditional) return true;
  const actual = responses[field.conditional.fieldKey];
  const expected = field.conditional.value;
  if (field.conditional.operator === "NOT_EMPTY") return hasValue(actual);
  if (field.conditional.operator === "INCLUDES") return Array.isArray(actual) ? actual.map(String).includes(expected) : String(actual ?? "").includes(expected);
  if (field.conditional.operator === "NOT_EQUALS") return String(actual ?? "") !== expected;
  return String(actual ?? "") === expected;
}

export function getAttendeeRosterConfig(definition: RegistrationFormDefinition): AttendeeRosterConfig {
  return definition.attendeeRoster ?? {
    enabled: false,
    minAttendees: 1,
    maxAttendees: 1,
    attendeeLabel: "Attendee",
    addButtonLabel: "Add another attendee",
  };
}

export function localCalendarDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isLatePricingActive(field: RegistrationFormField, pricingDate = localCalendarDate()) {
  return Boolean(field.latePricing && pricingDate >= field.latePricing.startsOn);
}

function attendeeDisplayName(responses: Record<string, unknown>, index: number, attendeeLabel: string) {
  const firstName = typeof responses.first_name === "string" ? responses.first_name.trim() : "";
  const lastName = typeof responses.last_name === "string" ? responses.last_name.trim() : "";
  const splitName = `${firstName} ${lastName}`.trim();
  if (splitName) return splitName;
  for (const key of attendeeNameKeys) {
    const value = responses[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return `${attendeeLabel} ${index + 1}`;
}

function pricedLineItem(
  field: RegistrationFormField,
  responses: Record<string, unknown>,
  pricingDate: string,
  attendee?: { index: number; label: string },
): FormCalculation["lineItems"][number] | null {
  if (!isFieldVisible(field, responses)) return null;
  const value = responses[field.key];
  const latePricingActive = isLatePricingActive(field, pricingDate);
  const priceCents = latePricingActive ? field.latePricing?.priceCents ?? field.priceCents : field.priceCents;
  const hasChoicePrices = field.choicePricesCents !== undefined || (latePricingActive && field.latePricing?.choicePricesCents !== undefined);
  const choicePricesCents = hasChoicePrices ? { ...(field.choicePricesCents ?? {}), ...(latePricingActive ? field.latePricing?.choicePricesCents ?? {} : {}) } : undefined;
  let amountCents = 0;
  if (choicePricesCents) {
    const selections = Array.isArray(value) ? value.map(String) : hasValue(value) ? [String(value)] : [];
    amountCents = selections.reduce((total, selection) => total + (choicePricesCents[selection] ?? 0), 0);
  } else if (priceCents !== undefined && field.type === "CALCULATED") amountCents = priceCents;
  else if (priceCents && field.type === "NUMBER") amountCents = Math.max(0, Number(value) || 0) * priceCents;
  else if (priceCents && hasValue(value)) amountCents = priceCents;
  if (amountCents <= 0) return null;
  return {
    key: attendee ? `attendees.${attendee.index}.${field.key}` : field.key,
    label: attendee ? `${field.label} — ${attendee.label}` : field.label,
    amountCents: Math.round(amountCents),
    ...(latePricingActive ? { pricingLabel: field.latePricing?.label } : {}),
    ...(attendee ? { attendeeIndex: attendee.index, attendeeLabel: attendee.label } : {}),
  };
}

function finalizeCalculation(
  definition: RegistrationFormDefinition,
  registrationResponses: Record<string, unknown>,
  lineItems: FormCalculation["lineItems"],
) {
  const subtotalCents = lineItems.reduce((total, item) => total + item.amountCents, 0);
  const payment = definition.payment;
  const cardSelected = Boolean(payment?.enabled && registrationResponses[payment.paymentMethodFieldKey] === payment.cardOptionValue);
  const processingFeeCents = processingFeeForSubtotal(
    payment,
    subtotalCents,
    cardSelected,
  );
  return { subtotalCents, processingFeeCents, totalCents: subtotalCents + processingFeeCents, lineItems };
}

export function processingFeeForSubtotal(
  payment: RegistrationFormDefinition["payment"],
  subtotalCents: number,
  cardSelected = true,
) {
  if (
    !payment?.enabled
    || !payment.passFeeToRegistrant
    || !cardSelected
    || !Number.isSafeInteger(subtotalCents)
    || subtotalCents <= 0
  ) {
    return 0;
  }
  const rate = payment.percentageBasisPoints / 10_000;
  const grossTotal = Math.ceil(
    (subtotalCents + payment.fixedFeeCents) / (1 - rate),
  );
  return Math.max(0, grossTotal - subtotalCents);
}

export function calculateFormTotal(definition: RegistrationFormDefinition, responses: Record<string, unknown>, pricingDate = localCalendarDate()): FormCalculation {
  const lineItems = definition.sections
    .flatMap((section) => section.fields)
    .map((field) => pricedLineItem(field, responses, pricingDate))
    .filter((item): item is NonNullable<typeof item> => item !== null);
  return finalizeCalculation(definition, responses, lineItems);
}

export function calculateRosterTotal(
  definition: RegistrationFormDefinition,
  registrationResponses: Record<string, unknown>,
  attendeeResponses: Array<Record<string, unknown>>,
  pricingDate = localCalendarDate(),
): FormCalculation {
  const fields = definition.sections.flatMap((section) => section.fields);
  const lineItems: FormCalculation["lineItems"] = fields
    .filter((field) => field.scope === "REGISTRATION")
    .map((field) => pricedLineItem(field, registrationResponses, pricingDate))
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const roster = getAttendeeRosterConfig(definition);
  attendeeResponses.forEach((responses, index) => {
    const mergedResponses = { ...registrationResponses, ...responses };
    const label = attendeeDisplayName(responses, index, roster.attendeeLabel);
    for (const field of fields) {
      if (field.scope !== "ATTENDEE") continue;
      const item = pricedLineItem(field, mergedResponses, pricingDate, { index, label });
      if (item) lineItems.push(item);
    }
  });
  return finalizeCalculation(definition, registrationResponses, lineItems);
}

export function summarizeChoiceUsage(definition: RegistrationFormDefinition, responseSets: Array<Record<string, unknown>>): ChoiceUsage {
  const usage: ChoiceUsage = {};
  for (const section of definition.sections) {
    for (const field of section.fields) {
      if (!isChoiceFieldType(field.type) || getAvailabilityMode(field) === "NONE") continue;
      usage[field.key] = Object.fromEntries(field.options.map((option) => [option, { total: 0, first: 0, second: 0 }]));
    }
  }
  for (const responses of responseSets) {
    for (const [fieldKey, choices] of Object.entries(usage)) {
      const value = responses[fieldKey];
      const selected = Array.isArray(value) ? value.map(String) : hasValue(value) ? [String(value)] : [];
      selected.forEach((option, index) => {
        const stats = choices[option];
        if (!stats) return;
        stats.total += 1;
        if (index === 0) stats.first += 1;
        if (index === 1) stats.second += 1;
      });
    }
  }
  return usage;
}

export function validateTestResponses(
  definition: RegistrationFormDefinition,
  responses: Record<string, unknown>,
  usage: ChoiceUsage = {},
  scope?: RegistrationFormField["scope"],
  options: {
    ignoreAvailability?: boolean;
    ignoredFieldKeys?: readonly string[];
  } = {},
) {
  const ignoredFieldKeys = new Set(options.ignoredFieldKeys ?? []);
  const issues: Array<{ fieldId: string; key: string; message: string }> = [];
  for (const section of definition.sections) {
    for (const field of section.fields) {
      if (scope && field.scope !== scope) continue;
      if (ignoredFieldKeys.has(field.key)) continue;
      if (!isFieldVisible(field, responses)) continue;
      const value = responses[field.key];
      if (field.required && !hasValue(value)) {
        issues.push({ fieldId: field.id, key: field.key, message: `${field.label} is required.` });
        continue;
      }
      if (!hasValue(value)) continue;
      if ((field.type === "TEXT" || field.type === "LONG_TEXT" || field.type === "EMAIL" || field.type === "PHONE" || field.type === "DATE") && typeof value !== "string") {
        issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be text.` });
        continue;
      }
      if (field.type === "TEXT" && String(value).length > 500) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be 500 characters or fewer.` });
      if (field.type === "LONG_TEXT" && String(value).length > 5000) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be 5,000 characters or fewer.` });
      if (field.type === "EMAIL" && (String(value).length > 160 || !z.email().safeParse(value).success)) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be a valid email address.` });
      if (field.type === "PHONE" && String(value).length > 80) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be 80 characters or fewer.` });
      if (field.type === "DATE") {
        const date = String(value);
        const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
        if (!parsed || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be a valid date.` });
      }
      if (field.type === "NUMBER") {
        const numeric = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
        if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100000) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be a number from 0 to 100,000.` });
      }
      if (field.type === "CHECKBOX" && typeof value !== "boolean") issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be checked or unchecked.` });
      if ((field.type === "SELECT" || field.type === "RADIO") && !field.options.includes(String(value))) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must use one of its configured choices.` });
      if (field.type === "MULTISELECT" || field.type === "RANKED_CHOICE") {
        const selections = Array.isArray(value) ? value.map(String) : [];
        const maximum = field.maxSelections ?? (field.type === "RANKED_CHOICE" ? 2 : field.options.length);
        const minimum = field.minSelections ?? (field.required ? (field.type === "RANKED_CHOICE" ? Math.min(2, maximum) : 1) : 0);
        if (!Array.isArray(value) || selections.some((selection) => !field.options.includes(selection))) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} contains an invalid choice.` });
        else if (new Set(selections).size !== selections.length) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} cannot contain duplicate choices.` });
        else if (selections.length < minimum) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} requires ${minimum} choices.` });
        else if (selections.length > maximum) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} allows up to ${maximum} choices.` });
      }
      if (
        !options.ignoreAvailability
        && isChoiceFieldType(field.type)
        && getAvailabilityMode(field) === "CAPACITY"
      ) {
        const selections = Array.isArray(value) ? value.map(String) : [String(value)];
        for (const selection of selections) {
          const limit = field.choiceLimits?.[selection];
          const current = usage[field.key]?.[selection]?.total ?? 0;
          if (limit && current >= limit) issues.push({ fieldId: field.id, key: field.key, message: `${selection} has reached its limit of ${limit}.` });
        }
      }
    }
  }
  return { isValid: issues.length === 0, issues };
}

export const createFormSchema = z.object({ templateKey: z.string().trim().min(1).max(80) });
export const updateFormSchema = z.object({
  definition: registrationFormDefinitionSchema,
  expectedUpdatedAt: z.iso.datetime(),
});
export const testSubmissionSchema = z.object({
  versionId: z.string().trim().min(1),
  responses: z.record(z.string(), z.unknown()),
  attendees: z.array(z.object({
    clientId: z.string().trim().min(1).max(80),
    responses: z.record(z.string(), z.unknown()),
  }).strict()).max(50).optional(),
});
