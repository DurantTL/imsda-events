import { calendarDateSchema, eventNameSchema, eventSlugSchema } from "@/modules/events/schemas";

export type FromTemplateField = "templateId" | "name" | "slug" | "startsOn" | "endsOn";

export type FromTemplateErrors = Partial<Record<FromTemplateField, string>>;

/** Field order on the page, so focus goes to the first invalid field a person sees. */
export const fromTemplateFieldOrder: FromTemplateField[] = ["templateId", "name", "slug", "startsOn", "endsOn"];

export const fromTemplateFieldLabels: Record<FromTemplateField, string> = {
  templateId: "Template",
  name: "Event name",
  slug: "Web address",
  startsOn: "Starts on",
  endsOn: "Ends on",
};

/**
 * Client-side check of the create-from-template form (#704), using the same
 * field schemas the apply route validates with, so the page can name every
 * missing or invalid field instead of leaving a disabled button.
 */
export function validateFromTemplateForm(input: {
  templateId: string;
  name: string;
  slug: string;
  startsOn: string;
  endsOn: string;
}): FromTemplateErrors {
  const errors: FromTemplateErrors = {};
  if (!input.templateId) errors.templateId = "Choose a published template.";

  const name = eventNameSchema.safeParse(input.name);
  if (!name.success) errors.name = input.name.trim() === "" ? "Enter an event name." : (name.error.issues[0]?.message ?? "Enter an event name.");

  const slug = eventSlugSchema.safeParse(input.slug);
  if (!slug.success) errors.slug = input.slug.trim() === "" ? "Enter a short web address." : (slug.error.issues[0]?.message ?? "Enter a short web address.");

  const starts = calendarDateSchema.safeParse(input.startsOn);
  if (!starts.success) errors.startsOn = input.startsOn === "" ? "Choose the start date." : (starts.error.issues[0]?.message ?? "Choose the start date.");

  const ends = calendarDateSchema.safeParse(input.endsOn);
  if (!ends.success) errors.endsOn = input.endsOn === "" ? "Choose the end date." : (ends.error.issues[0]?.message ?? "Choose the end date.");
  else if (starts.success && input.endsOn < input.startsOn) errors.endsOn = "The event cannot end before it starts.";

  return errors;
}

export function orderedFromTemplateErrors(errors: FromTemplateErrors) {
  return fromTemplateFieldOrder
    .filter((field) => errors[field])
    .map((field) => ({ field, label: fromTemplateFieldLabels[field], message: errors[field] as string }));
}
