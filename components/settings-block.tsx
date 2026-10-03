"use client";

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { settingsBlockDomId, type SettingsBlockId } from "@/modules/events/settings-layout";

/**
 * A collapsible settings block (#743). It is a native `<details>`, so closing it
 * hides its fields without unmounting them: typed values and validation state
 * live on in the DOM and in the parent's draft. The parent owns `open` so a
 * jump link or a field error can open it.
 */
export function SettingsBlock({
  blockId,
  eyebrow,
  title,
  summary,
  open,
  onOpenChange,
  hasError = false,
  children,
  className = "panel event-settings-panel",
}: {
  /** The block's id (see `settingsBlockIds`); the DOM id is derived from it. */
  blockId: SettingsBlockId;
  eyebrow?: string;
  title: string;
  /** The one line shown while the block is collapsed. */
  summary: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasError?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details
      className={`settings-block ${className}${hasError ? " has-error" : ""}`}
      data-settings-block={blockId}
      id={settingsBlockDomId(blockId)}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
      open={open}
    >
      <summary>
        <span className="settings-block-heading">
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h2 className="settings-block-title">{title}</h2>
          <small className="settings-block-summary">{summary}</small>
        </span>
        <ChevronDown aria-hidden="true" className="settings-block-chevron" size={18} />
      </summary>
      <div className="settings-block-body form-stack">{children}</div>
    </details>
  );
}
