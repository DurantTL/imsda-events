import type { HTMLAttributes } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

/**
 * The staff sidebar's collapse button (#446). The label changes with the state
 * ("Collapse sidebar" / "Expand sidebar") and `aria-expanded` is left off, so a
 * screen reader does not announce the state twice.
 */
export function SidebarToggle({
  collapsed,
  onToggle,
  tipProps = {},
}: {
  collapsed: boolean;
  onToggle: () => void;
  tipProps?: HTMLAttributes<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      className="sidebar-toggle"
      aria-controls="primary-navigation"
      {...tipProps}
      onClick={onToggle}
    >
      {collapsed ? <PanelLeftOpen aria-hidden="true" size={18} /> : <PanelLeftClose aria-hidden="true" size={18} />}
      <span>{collapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
    </button>
  );
}
