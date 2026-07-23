import type {
  RegistrationFormDefinition,
  RegistrationFormField,
} from "@/modules/forms/definition";

export type PublicRegistrationStepId =
  | "contact"
  | "attendees"
  | "choices"
  | "review";

export type PublicRegistrationStep = {
  id: PublicRegistrationStepId;
  shortLabel: string;
  title: string;
  description: string;
  fieldKeys: string[];
};

const attendeeIdentityTerms = [
  "attendee_name",
  "first_name",
  "last_name",
  "full_name",
  "guest_name",
  "member_name",
  "age",
  "birth",
  "gender",
  "attendee_type",
  "role",
  "guardian",
  "attendee_phone",
  "attendee_email",
];

const registrationContactTerms = [
  "email",
  "phone",
  "contact",
  "address",
  "city",
  "state",
  "postal",
  "zip",
  "church",
  "director",
  "household",
  "organization",
  "club",
  "emergency",
  "primary",
  "first_name",
  "last_name",
  "full_name",
];

const eventChoiceTerms = [
  "lodg",
  "housing",
  "room",
  "cabin",
  "hotel",
  "stay",
  "camping",
  "campsite",
  "tent",
  "trailer",
  "canopy",
  "meal",
  "diet",
  "seminar",
  "activity",
  "schedule",
  "program",
  "shirt",
  "apparel",
  "childcare",
  "accommodation",
  "accessibility",
  "special_need",
  "transport",
  "ticket",
  "preference",
  "selection",
  "quantity",
  "_qty",
  "num_",
  "party_size",
];

const eventChoiceSectionTerms = [
  "choice",
  "housing",
  "lodging",
  "stay",
  "camping",
  "accommodation",
  "meal",
  "seminar",
  "activity",
  "schedule",
  "program",
  "guest",
  "ticket",
  "apparel",
];

const acknowledgmentTerms = [
  "acknowledg",
  "agree",
  "consent",
  "terms",
  "waiver",
  "permission",
  "release",
  "certify",
  "understand",
];

function includesAny(value: string, terms: readonly string[]) {
  return terms.some((term) => value.includes(term));
}

function fieldSearchText(
  field: RegistrationFormField,
  sectionTitle: string,
) {
  return `${field.key} ${field.label} ${sectionTitle}`.toLowerCase();
}

function classifyField(
  definition: RegistrationFormDefinition,
  field: RegistrationFormField,
  sectionTitle: string,
): Exclude<PublicRegistrationStepId, "contact"> | "contact" {
  const searchText = fieldSearchText(field, sectionTitle);
  const fieldOnlyText = `${field.key} ${field.label}`.toLowerCase();
  if (
    field.key === definition.payment?.paymentMethodFieldKey
    || field.key === "promo_code"
    || field.type === "CALCULATED"
    || includesAny(searchText, acknowledgmentTerms)
    || sectionTitle.toLowerCase().includes("payment")
  ) {
    return "review";
  }

  if (field.scope === "ATTENDEE") {
    if (includesAny(fieldOnlyText, attendeeIdentityTerms)) return "attendees";
    if (
      field.type === "MULTISELECT"
      || field.type === "RANKED_CHOICE"
      || includesAny(searchText, eventChoiceTerms)
      || includesAny(sectionTitle.toLowerCase(), eventChoiceSectionTerms)
    ) {
      return "choices";
    }
    return "attendees";
  }

  if (includesAny(fieldOnlyText, registrationContactTerms)) return "contact";
  if (
    field.type === "MULTISELECT"
    || field.type === "RANKED_CHOICE"
    || includesAny(searchText, eventChoiceTerms)
    || includesAny(sectionTitle.toLowerCase(), eventChoiceSectionTerms)
  ) {
    return "choices";
  }
  return "contact";
}

export function getPublicRegistrationStepPlan(
  definition: RegistrationFormDefinition,
  visibleFieldKeys?: ReadonlySet<string>,
): PublicRegistrationStep[] {
  const grouped: Record<PublicRegistrationStepId, string[]> = {
    contact: [],
    attendees: [],
    choices: [],
    review: [],
  };

  for (const section of definition.sections) {
    for (const field of section.fields) {
      if (visibleFieldKeys && !visibleFieldKeys.has(field.key)) continue;
      grouped[classifyField(definition, field, section.title)].push(field.key);
    }
  }

  const allDefinedFields = definition.sections.flatMap((section) => section.fields);
  const compactDetails = !definition.attendeeRoster?.enabled
    && !definition.payment?.enabled
    && allDefinedFields.filter((field) => (
      classifyField(
        definition,
        field,
        definition.sections.find((section) => (
          section.fields.some((candidate) => candidate.id === field.id)
        ))?.title ?? "",
      ) !== "review"
    )).length <= 4;

  if (compactDetails) {
    grouped.contact = [
      ...grouped.contact,
      ...grouped.attendees,
      ...grouped.choices,
    ];
    grouped.attendees = [];
    grouped.choices = [];
  }

  const steps: PublicRegistrationStep[] = [];
  if (grouped.contact.length > 0) {
    steps.push({
      id: "contact",
      shortLabel: compactDetails ? "Details" : "Contact",
      title: compactDetails ? "Your details" : "Contact information",
      description: compactDetails
        ? "Tell us who is responding and how the event team can reach you."
        : "Share the primary contact information for this registration.",
      fieldKeys: grouped.contact,
    });
  }
  if (grouped.attendees.length > 0) {
    steps.push({
      id: "attendees",
      shortLabel: "Attendees",
      title: "Who is attending?",
      description: "Add each attendee and complete the details that belong to that person.",
      fieldKeys: grouped.attendees,
    });
  }
  if (grouped.choices.length > 0) {
    steps.push({
      id: "choices",
      shortLabel: "Choices",
      title: "Event choices & housing",
      description: "Choose lodging, meals, activities, programs, and other event options.",
      fieldKeys: grouped.choices,
    });
  }
  steps.push({
    id: "review",
    shortLabel: "Review",
    title: definition.payment?.enabled ? "Review & payment" : "Review & submit",
    description: "Check every answer before sending this registration.",
    fieldKeys: grouped.review,
  });
  return steps;
}

export function formatPublicRegistrationAnswer(
  value: string | boolean | string[] | null | undefined,
) {
  if (Array.isArray(value)) return value.length > 0 ? value.join(" → ") : null;
  if (typeof value === "boolean") return value ? "Accepted" : "Not accepted";
  if (typeof value === "string") return value.trim() || null;
  return null;
}
