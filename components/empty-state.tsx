import Link from "next/link";
import type { ReactNode } from "react";

export type EmptyStateAction = { label: string; href?: string; onClick?: () => void };

/**
 * The create action an empty state may offer (#743). Only an authorized viewer
 * gets one: without permission the state still explains what is missing, but
 * offers nothing the server would refuse. The server decides again either way.
 */
export function emptyStateAction(canCreate: boolean, action: EmptyStateAction | undefined): EmptyStateAction | null {
  return canCreate && action ? action : null;
}

/** What is missing, why, and (when allowed) how to add it. */
export function EmptyState({
  icon,
  title,
  children,
  action,
  canCreate = false,
  hint,
  actionClass = "primary-button",
  className = "empty-state",
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: EmptyStateAction;
  /** Whether the viewer may create what is missing. Defaults to false: no action. */
  canCreate?: boolean;
  /** Shown instead of the action to a viewer who cannot create. */
  hint?: string;
  /** "secondary-button" when the page already has its one filled primary action. */
  actionClass?: "primary-button" | "secondary-button";
  className?: string;
}) {
  const offered = emptyStateAction(canCreate, action);
  return (
    <div className={className} role="status">
      {icon}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {offered && (offered.href
        ? <Link className={actionClass} href={offered.href}>{offered.label}</Link>
        : <button className={actionClass} onClick={offered.onClick} type="button">{offered.label}</button>)}
      {!offered && hint && <p className="empty-state-hint">{hint}</p>}
    </div>
  );
}
