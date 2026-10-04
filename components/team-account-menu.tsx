"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

export type TeamMenuItemKey =
  | "send-password-reset"
  | "change-email"
  | "reset-two-step"
  | "toggle-sign-in";

export type TeamMenuItem = {
  key: TeamMenuItemKey;
  label: string;
  danger: boolean;
};

/**
 * Which "More actions" items a team row offers. Same rules the row's buttons
 * had before they moved into the menu: reset two-step only for someone else
 * who has started two-step, and the sign-in toggle never for yourself.
 */
export function teamMenuItems(member: {
  id: string;
  mfaStatus: string;
  signInDisabled: boolean;
}, currentUserId: string): TeamMenuItem[] {
  const items: TeamMenuItem[] = [
    { key: "send-password-reset", label: "Send password reset", danger: false },
    { key: "change-email", label: "Change email", danger: false },
  ];
  const isSelf = member.id === currentUserId;
  if (!isSelf && member.mfaStatus !== "NONE") {
    items.push({ key: "reset-two-step", label: "Reset two-step", danger: false });
  }
  if (!isSelf) {
    items.push({
      key: "toggle-sign-in",
      label: member.signInDisabled ? "Allow sign-in" : "Disable sign-in",
      danger: !member.signInDisabled,
    });
  }
  return items;
}

/** Menu keyboard model: the index to focus after a key, or null if unhandled. */
export function nextMenuIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export function TeamAccountMenu({
  memberName,
  items,
  disabled,
  onSelect,
}: {
  memberName: string;
  items: TeamMenuItem[];
  disabled: boolean;
  onSelect: (key: TeamMenuItemKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const menuId = useId();

  function itemButtons() {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  }

  function openMenu(focus: "first" | "last") {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setPosition({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
    }
    setOpen(true);
    requestAnimationFrame(() => {
      const buttons = itemButtons();
      (focus === "last" ? buttons[buttons.length - 1] : buttons[0])?.focus();
    });
  }

  function closeMenu(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    // The menu is fixed-positioned from the trigger's rect, so it would drift
    // if the page moved under it; closing is simpler than tracking.
    function dismiss() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const buttons = itemButtons();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = nextMenuIndex(event.key, current, buttons.length);
    if (next !== null) {
      event.preventDefault();
      buttons[next]?.focus();
    }
  }

  return (
    <div className="team-more-menu">
      <button
        ref={triggerRef}
        className="secondary-button"
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`More actions for ${memberName}`}
        onClick={() => (open ? closeMenu(false) : openMenu("first"))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openMenu("first");
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            openMenu("last");
          }
        }}
      >
        <MoreHorizontal size={14} aria-hidden="true" /> More actions
      </button>
      {open && (
        <ul
          ref={menuRef}
          id={menuId}
          className="team-more-menu-list"
          role="menu"
          aria-label={`More actions for ${memberName}`}
          style={position ? { top: position.top, right: position.right } : undefined}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item) => (
            <li role="none" key={item.key}>
              <button
                type="button"
                role="menuitem"
                className={item.danger ? "danger" : undefined}
                onClick={() => {
                  closeMenu(true);
                  onSelect(item.key);
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
