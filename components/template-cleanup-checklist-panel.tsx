"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { ListChecks, X } from "lucide-react";
import {
  buildTemplateCleanupChecklistItems,
  parseTemplateCleanupCreatedRecords,
  parseTemplateCleanupIdList,
  readTemplateCleanupRaw,
  readTemplateCleanupStorage,
  shouldShowTemplateCleanupChecklist,
  subscribeTemplateCleanupChecklistChanges,
  templateCleanupCreatedFormIds,
  templateCleanupCreatedStorageKey,
  templateCleanupDismissedStorageKey,
  withTemplateCleanupDismissed,
  writeTemplateCleanupDismissedFormIds,
} from "@/components/template-cleanup-checklist";
import type { RegistrationFormDefinition } from "@/modules/forms/definition";

type TemplateCleanupChecklistPanelProps = {
  formId: string;
  definition: RegistrationFormDefinition;
};

function getCreatedRawSnapshot(): string | null {
  return readTemplateCleanupRaw(readTemplateCleanupStorage(), templateCleanupCreatedStorageKey);
}

function getDismissedRawSnapshot(): string | null {
  return readTemplateCleanupRaw(readTemplateCleanupStorage(), templateCleanupDismissedStorageKey);
}

// The server always renders as if nothing were created or dismissed yet
// (there's no localStorage to read), so the first client render must match
// that exactly (#484 N2) rather than reading real browser storage during
// that first render — otherwise React logs a hydration mismatch whenever a
// form actually has stored state. `useSyncExternalStore` is built for this:
// it renders `getServerSnapshot` (null, same as "no window") until the
// commit after hydration, then re-renders with the real client value.
function getServerSnapshot(): null {
  return null;
}

/** Cross-tab (native "storage" event) and same-tab (this module's own
 * pub-sub, since the tab that writes never gets its own "storage" event)
 * change notifications, combined into one `useSyncExternalStore` subscribe
 * function. */
function subscribe(onStoreChange: () => void): () => void {
  const unsubscribeInternal = subscribeTemplateCleanupChecklistChanges(onStoreChange);
  if (typeof window === "undefined") return unsubscribeInternal;
  window.addEventListener("storage", onStoreChange);
  return () => {
    unsubscribeInternal();
    window.removeEventListener("storage", onStoreChange);
  };
}

/**
 * Inline, dismissible checklist shown in the registration builder right
 * after a draft is created from a template (#484). It lists the sections and
 * fields the template brought in so the builder can confirm or remove the
 * ones that don't belong on this event's form. Checking an item off is
 * purely a personal review aid — nothing here blocks saving or publishing,
 * and removing an item from the form (with the builder's existing remove
 * controls) simply drops it from this list on the next render.
 *
 * Its created/dismissed state comes from `useSyncExternalStore` reading
 * localStorage directly (see `getServerSnapshot` above) rather than a
 * `useState` lazy initializer, so the very first client render matches the
 * server's storage-less render — a `useState` initializer that reads
 * localStorage would instead show real content on that first render,
 * mismatching the server-rendered empty markup.
 *
 * The caller renders this with `key={formId}` (as the registration builder
 * does) so `confirmedIds` — the per-item review checkmarks, which are
 * genuinely local and not persisted — resets cleanly on switching forms.
 */
export function TemplateCleanupChecklistPanel({ formId, definition }: TemplateCleanupChecklistPanelProps) {
  const createdRaw = useSyncExternalStore(subscribe, getCreatedRawSnapshot, getServerSnapshot);
  const dismissedRaw = useSyncExternalStore(subscribe, getDismissedRawSnapshot, getServerSnapshot);
  const createdRecords = useMemo(() => parseTemplateCleanupCreatedRecords(createdRaw), [createdRaw]);
  const createdFormIds = useMemo(() => templateCleanupCreatedFormIds(createdRecords), [createdRecords]);
  const snapshot = createdRecords.find((record) => record.formId === formId)?.snapshot;
  const dismissedFormIds = useMemo(() => parseTemplateCleanupIdList(dismissedRaw), [dismissedRaw]);
  const [confirmedIds, setConfirmedIds] = useState<ReadonlySet<string>>(() => new Set());

  const visible = shouldShowTemplateCleanupChecklist(createdFormIds, dismissedFormIds, formId);
  const items = useMemo(() => (visible ? buildTemplateCleanupChecklistItems(definition, snapshot) : []), [visible, definition, snapshot]);

  if (!visible || items.length === 0) return null;

  function dismiss() {
    const storage = readTemplateCleanupStorage();
    writeTemplateCleanupDismissedFormIds(storage, withTemplateCleanupDismissed(dismissedFormIds, formId));
  }

  function toggleConfirmed(itemId: string) {
    setConfirmedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  return (
    <section className="template-cleanup-checklist panel" role="region" aria-label="Template cleanup checklist" data-testid="template-cleanup-checklist">
      <div className="template-cleanup-checklist-head">
        <ListChecks size={20} aria-hidden="true" />
        <div>
          <p className="eyebrow">From a template</p>
          <h3>Review what this template brought in</h3>
          <p>Confirm or remove the inherited sections and fields that don&rsquo;t belong on this form. This is a review aid only — it never blocks saving or publishing.</p>
        </div>
        <button type="button" className="icon-button" onClick={dismiss} aria-label="Dismiss the template cleanup checklist">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <ul className="template-cleanup-checklist-items">
        {items.map((item) => (
          <li key={item.id} className={item.kind === "section" ? "is-section" : "is-field"}>
            <label>
              <input
                type="checkbox"
                checked={confirmedIds.has(item.id)}
                onChange={() => toggleConfirmed(item.id)}
              />
              <span>{item.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
