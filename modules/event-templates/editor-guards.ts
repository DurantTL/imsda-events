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
