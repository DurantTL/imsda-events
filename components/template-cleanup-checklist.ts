import type { RegistrationFormDefinition } from "@/modules/forms/definition";

/**
 * Pure logic and best-effort storage for the "template cleanup" checklist
 * (#484): a dismissible, non-blocking nudge shown on a draft created from a
 * template, listing the sections and fields it inherited so the builder can
 * confirm or remove the ones that don't belong on this event's form.
 *
 * Whether a form was "created from a template" isn't recorded on the
 * `RegistrationForm` record itself (every form actually is created from one
 * of the local templates in `modules/forms/definition.ts` — there's no blank
 * option), so this follows the same signal the "Draft created" guide
 * (`components/draft-created-guide.ts`, #473) uses: the client records the
 * moment of creation itself, here as a remembered form id, rather than
 * requiring a schema change to persist it server-side.
 *
 * Known limitation of that choice, worth calling out explicitly: everything
 * here lives only in this one browser's `localStorage`.
 * - It's per browser/device, not per account: a director who starts a form
 *   on one computer and continues on another (or a co-worker who opens the
 *   same form) won't see the checklist there, and dismissing it on one
 *   device doesn't dismiss it on another.
 * - The "created" record also snapshots the section and field ids the
 *   template brought in, so only those are listed as inherited — a field
 *   the builder adds afterward never shows up here.
 * - The per-item checkmarks (`confirmedIds` in
 *   `template-cleanup-checklist-panel.tsx`) aren't persisted at all — they
 *   reset on reload, since they're a personal review aid, not the record of
 *   what was reviewed.
 * - Nothing about publishing clears the "created" record, so the checklist
 *   can still show after a form has been published — until it's dismissed,
 *   same as before publishing. That's intentional (it is never a publish
 *   gate), but worth knowing rather than assuming it disappears on its own.
 */

export const templateCleanupCreatedStorageKey = "imsda-events:template-cleanup-checklist:created";
export const templateCleanupDismissedStorageKey = "imsda-events:template-cleanup-checklist:dismissed";

// Bounds the remembered lists so a staff account that has created hundreds of
// forms over the years doesn't grow either value without limit.
const maxRememberedFormIds = 200;

export type TemplateCleanupStorageReader = Pick<Storage, "getItem">;
export type TemplateCleanupStorageWriter = Pick<Storage, "setItem">;

/**
 * Parses a raw stored value into an id list — exported so a
 * `useSyncExternalStore`-based reader (see `template-cleanup-checklist-panel.tsx`,
 * #484 N2) can read the same raw string it subscribes to and parse it the
 * same way this module does everywhere else, without going through a
 * `Storage`-shaped object of its own.
 */
export function parseTemplateCleanupIdList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    // Corrupt storage. The checklist just may show again, or not at all, for
    // a form whose earlier state lived only in that storage.
    return [];
  }
}

/** The raw stored string for `key`, or null for missing/inaccessible storage. */
export function readTemplateCleanupRaw(storage: TemplateCleanupStorageReader | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    // Private browsing or a policy that blocks storage access entirely.
    return null;
  }
}

function readIdList(storage: TemplateCleanupStorageReader | undefined, key: string): string[] {
  return parseTemplateCleanupIdList(readTemplateCleanupRaw(storage, key));
}

// Notified after every successful write, so a same-tab `useSyncExternalStore`
// subscriber re-reads immediately — the browser's own "storage" event only
// fires in *other* tabs/windows, never the one that made the write.
const changeListeners = new Set<() => void>();

export function subscribeTemplateCleanupChecklistChanges(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

function notifyTemplateCleanupChecklistChanged(): void {
  for (const listener of changeListeners) listener();
}

function writeIdList(storage: TemplateCleanupStorageWriter | undefined, key: string, ids: readonly string[]): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(ids));
    notifyTemplateCleanupChecklistChanged();
  } catch {
    // Best-effort only.
  }
}

function withRemembered(ids: readonly string[], formId: string): string[] {
  if (ids.includes(formId)) return [...ids];
  const next = [...ids, formId];
  return next.length > maxRememberedFormIds
    ? next.slice(next.length - maxRememberedFormIds)
    : next;
}

/** The section and field ids a form had at the moment it was created from a
 * template — what the checklist treats as "inherited". */
export type TemplateCleanupSnapshot = { sectionIds: string[]; fieldIds: string[] };

/** One remembered "created from a template" form. */
export type TemplateCleanupCreatedRecord = { formId: string; snapshot: TemplateCleanupSnapshot };

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : null;
}

function parseCreatedRecord(value: unknown): TemplateCleanupCreatedRecord | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.formId !== "string") return null;
  const sectionIds = stringList(candidate.sectionIds);
  const fieldIds = stringList(candidate.fieldIds);
  return sectionIds && fieldIds
    ? { formId: candidate.formId, snapshot: { sectionIds, fieldIds } }
    : null;
}

/** Parses the raw stored "created" value, dropping any malformed entry. */
export function parseTemplateCleanupCreatedRecords(raw: string | null): TemplateCleanupCreatedRecord[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      const record = parseCreatedRecord(value);
      return record ? [record] : [];
    });
  } catch {
    return [];
  }
}

export function readTemplateCleanupCreatedRecords(storage: TemplateCleanupStorageReader | undefined): TemplateCleanupCreatedRecord[] {
  return parseTemplateCleanupCreatedRecords(readTemplateCleanupRaw(storage, templateCleanupCreatedStorageKey));
}

export function writeTemplateCleanupCreatedRecords(storage: TemplateCleanupStorageWriter | undefined, records: readonly TemplateCleanupCreatedRecord[]): void {
  if (!storage) return;
  try {
    storage.setItem(templateCleanupCreatedStorageKey, JSON.stringify(records.map((record) => (
      ({ formId: record.formId, ...record.snapshot })
    ))));
    notifyTemplateCleanupChecklistChanged();
  } catch {
    // Best-effort only.
  }
}

/** The ids of every remembered created form. */
export function templateCleanupCreatedFormIds(records: readonly TemplateCleanupCreatedRecord[]): string[] {
  return records.map((record) => record.formId);
}

/** Returns a new array (bounded like the dismissed list), with `record`
 * replacing any earlier record for the same form; never mutates `records`. */
export function withTemplateCleanupCreated(
  records: readonly TemplateCleanupCreatedRecord[],
  record: TemplateCleanupCreatedRecord,
): TemplateCleanupCreatedRecord[] {
  const next = [...records.filter((candidate) => candidate.formId !== record.formId), record];
  return next.length > maxRememberedFormIds
    ? next.slice(next.length - maxRememberedFormIds)
    : next;
}

/** The section and field ids of `definition`, as the inherited snapshot. */
export function templateCleanupSnapshot(definition: RegistrationFormDefinition): TemplateCleanupSnapshot {
  return {
    sectionIds: definition.sections.map((section) => section.id),
    fieldIds: definition.sections.flatMap((section) => section.fields.map((field) => field.id)),
  };
}

export function readTemplateCleanupDismissedFormIds(storage: TemplateCleanupStorageReader | undefined): string[] {
  return readIdList(storage, templateCleanupDismissedStorageKey);
}

export function writeTemplateCleanupDismissedFormIds(storage: TemplateCleanupStorageWriter | undefined, formIds: readonly string[]): void {
  writeIdList(storage, templateCleanupDismissedStorageKey, formIds);
}

export function isTemplateCleanupDismissed(dismissedFormIds: readonly string[], formId: string): boolean {
  return dismissedFormIds.includes(formId);
}

/** Returns a new array; never mutates `dismissedFormIds`. */
export function withTemplateCleanupDismissed(dismissedFormIds: readonly string[], formId: string): string[] {
  return withRemembered(dismissedFormIds, formId);
}

/**
 * The checklist shows only for a form this browser recorded as created from
 * a template, and only until it's dismissed for that form. It is never a
 * publish gate — dismissing it (or never showing it) has no effect on
 * whether the form can be published.
 */
export function shouldShowTemplateCleanupChecklist(
  createdFormIds: readonly string[],
  dismissedFormIds: readonly string[],
  formId: string | null | undefined,
): boolean {
  if (!formId) return false;
  if (!createdFormIds.includes(formId)) return false;
  return !isTemplateCleanupDismissed(dismissedFormIds, formId);
}

export type TemplateCleanupChecklistItem = {
  id: string;
  kind: "section" | "field";
  label: string;
  sectionId: string;
};

/**
 * One checklist item per inherited section and per inherited field, built
 * fresh from the current definition every render — so once the builder
 * removes something that doesn't belong, it simply drops off the list on its
 * own, with no separate "removed" bookkeeping needed.
 *
 * "Inherited" means present in `snapshot` (the ids the form had when it was
 * created from its template): a section or field added afterward isn't
 * listed. An inherited field moved into a new section is still listed,
 * under that section's id.
 */
export function buildTemplateCleanupChecklistItems(
  definition: RegistrationFormDefinition,
  snapshot: TemplateCleanupSnapshot,
): TemplateCleanupChecklistItem[] {
  const sectionIds = new Set(snapshot.sectionIds);
  const fieldIds = new Set(snapshot.fieldIds);
  return definition.sections.flatMap((section) => [
    ...(sectionIds.has(section.id)
      ? [{ id: `section:${section.id}`, kind: "section" as const, label: section.title, sectionId: section.id }]
      : []),
    ...section.fields
      .filter((field) => fieldIds.has(field.id))
      .map((field) => ({
        id: `field:${field.id}`,
        kind: "field" as const,
        label: field.label,
        sectionId: section.id,
      })),
  ]);
}

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    // Private browsing or a policy that blocks storage access entirely.
    return undefined;
  }
}

/**
 * Convenience wrapper for the one real call site (creating a form from a
 * template): records that this browser just created `formId` from a
 * template, with the section and field ids `definition` arrived with, so the
 * checklist shows those for it until dismissed.
 */
export function recordTemplateCleanupCreated(formId: string, definition: RegistrationFormDefinition): void {
  const storage = browserStorage();
  writeTemplateCleanupCreatedRecords(
    storage,
    withTemplateCleanupCreated(readTemplateCleanupCreatedRecords(storage), { formId, snapshot: templateCleanupSnapshot(definition) }),
  );
}

export { browserStorage as readTemplateCleanupStorage };
