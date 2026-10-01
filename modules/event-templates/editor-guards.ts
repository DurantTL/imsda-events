import { eventTemplateDescriptionSchema, eventTemplateNameSchema, eventTemplatePayloadSchema, type EventTemplatePayload } from "@/modules/event-templates/domain";

/**
 * Pure rules behind the template editor's Save and Publish buttons (#592),
 * kept out of the component so the unsaved-publish guard can be tested.
 */

export const UNSAVED_PUBLISH_MESSAGE = "Save your changes before publishing.";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** True when the editor's name, description, or payload text differs from the saved version. Unparseable JSON counts as edited. */
export function hasUnsavedTemplateEdits(
  edited: { name: string; description: string; payloadText: string },
  saved: { name: string; description: string; payload: unknown },
) {
  if (edited.name !== saved.name || edited.description !== saved.description) return true;
  try {
    return canonical(JSON.parse(edited.payloadText)) !== canonical(saved.payload ?? {});
  } catch {
    return true;
  }
}

/** Why "Save draft" / "Save as new draft" is disabled, or "" when it is available. */
export function saveDisabledReason(state: { isArchived: boolean; saving: boolean }) {
  if (state.isArchived) return "This template is archived and can no longer be edited.";
  if (state.saving) return "Saving is in progress.";
  return "";
}

/** Why "Publish" is disabled, or "" when it is available. Unsaved edits are not a disabled state: clicking Publish reports them. */
export function publishDisabledReason(state: { isArchived: boolean; isDraft: boolean; publishing: boolean }) {
  if (state.isArchived) return "This template is archived and can no longer be published.";
  if (!state.isDraft) return "Only a draft can be published. Use Save as new draft to start a new version first.";
  if (state.publishing) return "Publishing is in progress.";
  return "";
}

export type TemplateFieldError = { field: "name" | "description" | "payload"; path: string; message: string };

/**
 * Validates the editor's three inputs before a save request is made (#704):
 * malformed JSON and every payload field the server schema would reject come
 * back as field-level errors. The server validates again on save regardless.
 */
export function validateTemplateEdits(edited: { name: string; description: string; payloadText: string }):
  | { ok: true; payload: EventTemplatePayload }
  | { ok: false; errors: TemplateFieldError[] } {
  const errors: TemplateFieldError[] = [];
  const name = eventTemplateNameSchema.safeParse(edited.name);
  if (!name.success) errors.push({ field: "name", path: "name", message: name.error.issues[0]?.message ?? "Enter a valid name." });
  const description = eventTemplateDescriptionSchema.safeParse(edited.description);
  if (!description.success) errors.push({ field: "description", path: "description", message: description.error.issues[0]?.message ?? "The description is too long." });
  let parsed: unknown;
  let jsonOk = true;
  try {
    parsed = JSON.parse(edited.payloadText);
  } catch (error) {
    jsonOk = false;
    errors.push({ field: "payload", path: "payload", message: `The payload is not valid JSON${error instanceof Error ? ` (${error.message})` : ""}.` });
  }
  let payload: EventTemplatePayload | null = null;
  if (jsonOk) {
    const result = eventTemplatePayloadSchema.safeParse(parsed);
    if (result.success) payload = result.data;
    else {
      for (const issue of result.error.issues) {
        errors.push({ field: "payload", path: issue.path.length > 0 ? issue.path.join(".") : "payload", message: issue.message });
      }
    }
  }
  return errors.length === 0 && payload ? { ok: true, payload } : { ok: false, errors };
}
