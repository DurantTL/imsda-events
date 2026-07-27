import type {
  RegistrationFormDefinition,
  RegistrationFormField,
} from "@/modules/forms/definition";

export type PublicRegistrationStepId = string;

export type PublicRegistrationStep = {
  id: PublicRegistrationStepId;
  shortLabel: string;
  title: string;
  description: string;
  fieldKeys: string[];
  sectionId: string | null;
  isReview: boolean;
  managesAttendees: boolean;
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

function fieldLooksLikeAttendeeIdentity(field: RegistrationFormField) {
  const searchText = `${field.key} ${field.label}`.toLowerCase();
  return attendeeIdentityTerms.some((term) => searchText.includes(term));
}

function legacyReviewSection(
  definition: RegistrationFormDefinition,
  section: RegistrationFormDefinition["sections"][number],
) {
  if (definition.sections.at(-1)?.id !== section.id) return false;
  const title = section.title.toLowerCase();
  if (["payment", "review", "checkout", "acknowledg"].some((term) => title.includes(term))) {
    return true;
  }
  return section.fields.some((field) => (
    field.key === definition.payment?.paymentMethodFieldKey
    || field.key === "promo_code"
  ));
}

export function isPublicReviewSection(
  definition: RegistrationFormDefinition,
  section: RegistrationFormDefinition["sections"][number],
) {
  const hasExplicitSetting = definition.sections.some((candidate) => (
    candidate.isReviewStep !== undefined
  ));
  if (hasExplicitSetting) return section.isReviewStep === true;
  return legacyReviewSection(definition, section);
}

export function getPublicRegistrationStepPlan(
  definition: RegistrationFormDefinition,
  visibleFieldKeys?: ReadonlySet<string>,
): PublicRegistrationStep[] {
  const sectionSteps = definition.sections.flatMap((section) => {
    const fieldKeys = section.fields
      .filter((field) => !visibleFieldKeys || visibleFieldKeys.has(field.key))
      .map((field) => field.key);
    const isReview = isPublicReviewSection(definition, section);
    if (fieldKeys.length === 0 && !isReview) return [];
    return [{
      id: section.id,
      shortLabel: section.stepLabel ?? section.title.slice(0, 40),
      title: section.title,
      description: section.description,
      fieldKeys,
      sectionId: section.id,
      isReview,
      managesAttendees: false,
    }];
  });

  const reviewStep = sectionSteps.find((step) => step.isReview);
  const orderedSteps = reviewStep
    ? [
        ...sectionSteps.filter((step) => step.id !== reviewStep.id),
        reviewStep,
      ]
    : [
        ...sectionSteps,
        {
          id: "__review",
          shortLabel: "Review",
          title: definition.payment?.enabled ? "Review & payment" : "Review & submit",
          description: "Check every answer before sending this registration.",
          fieldKeys: [],
          sectionId: null,
          isReview: true,
          managesAttendees: false,
        },
      ];

  const firstIdentityStepIndex = orderedSteps.findIndex((step) => {
    if (!step.sectionId) return false;
    const section = definition.sections.find((candidate) => candidate.id === step.sectionId);
    return section?.fields.some((field) => (
      field.scope === "ATTENDEE" && fieldLooksLikeAttendeeIdentity(field)
    ));
  });
  const firstAttendeeStepIndex = firstIdentityStepIndex >= 0
    ? firstIdentityStepIndex
    : orderedSteps.findIndex((step) => {
        if (!step.sectionId) return false;
        const section = definition.sections.find((candidate) => candidate.id === step.sectionId);
        return section?.fields.some((field) => field.scope === "ATTENDEE");
      });

  return orderedSteps.map((step, index) => ({
    ...step,
    managesAttendees: index === firstAttendeeStepIndex,
  }));
}

export function formatPublicRegistrationAnswer(
  value: string | boolean | string[] | null | undefined,
) {
  if (Array.isArray(value)) return value.length > 0 ? value.join(" → ") : null;
  if (typeof value === "boolean") return value ? "Accepted" : "Not accepted";
  if (typeof value === "string") return value.trim() || null;
  return null;
}
