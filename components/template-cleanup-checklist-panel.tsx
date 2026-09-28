"use client";

import { useMemo, useState } from "react";
import { ListChecks, X } from "lucide-react";
import {
  buildTemplateCleanupChecklistItems,
  readTemplateCleanupCreatedFormIds,
  readTemplateCleanupDismissedFormIds,
  readTemplateCleanupStorage,
  shouldShowTemplateCleanupChecklist,
  withTemplateCleanupDismissed,
  writeTemplateCleanupDismissedFormIds,
} from "@/components/template-cleanup-checklist";
import type { RegistrationFormDefinition } from "@/modules/forms/definition";

type TemplateCleanupChecklistPanelProps = {
  formId: string;
  definition: RegistrationFormDefinition;
};

/**
 * Inline, dismissible checklist shown in the registration builder right
 * after a draft is created from a template (#484). It lists the sections and
 * fields the template brought in so the builder can confirm or remove the
 * ones that don't belong on this event's form. Checking an item off is
 * purely a personal review aid — nothing here blocks saving or publishing,
 * and removing an item from the form (with the builder's existing remove
 * controls) simply drops it from this list on the next render.
 *
 * The caller renders this with `key={formId}` (as the registration builder
 * does), so switching forms remounts it: its storage reads run fresh for the
 * newly selected form instead of needing an effect to re-sync them.
 */
export function TemplateCleanupChecklistPanel({ formId, definition }: TemplateCleanupChecklistPanelProps) {
  const [dismissedFormIds, setDismissedFormIds] = useState<string[]>(
    () => readTemplateCleanupDismissedFormIds(readTemplateCleanupStorage()),
  );
  const [confirmedIds, setConfirmedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [createdFormIds] = useState<string[]>(
    () => readTemplateCleanupCreatedFormIds(readTemplateCleanupStorage()),
  );

  const visible = shouldShowTemplateCleanupChecklist(createdFormIds, dismissedFormIds, formId);
  const items = useMemo(() => (visible ? buildTemplateCleanupChecklistItems(definition) : []), [visible, definition]);

  if (!visible || items.length === 0) return null;

  function dismiss() {
    const storage = readTemplateCleanupStorage();
    const next = withTemplateCleanupDismissed(dismissedFormIds, formId);
    setDismissedFormIds(next);
    writeTemplateCleanupDismissedFormIds(storage, next);
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
