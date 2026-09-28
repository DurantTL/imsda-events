"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRightLeft, CircleUserRound, Eye, Fingerprint, ShieldCheck, ShieldQuestion } from "lucide-react";
import { SignOutButton } from "@/components/sign-out-button";
import type { WorkspaceContext } from "@/modules/access/workspace-contexts";

/**
 * The staff account popover (#543): name and email, entry points to the
 * existing passkey and two-step settings on /more (no new security behavior),
 * the workspace switches decided by `otherWorkspaceContextsForStaff` (#108),
 * and Sign out. Escape and outside clicks close it; Escape returns focus to
 * the trigger.
 */
export function StaffAccountMenu({
  attendeePreviewHref,
  canSwitchToAttendee,
  defaultOpen = false,
  displayName,
  email,
  settingsHref,
  systemAdminContext,
}: {
  attendeePreviewHref: string;
  canSwitchToAttendee: boolean;
  /** Render the menu already open (used by render tests). */
  defaultOpen?: boolean;
  displayName: string;
  email: string;
  /** The Settings & activity page, carrying the event query. */
  settingsHref: string;
  systemAdminContext?: WorkspaceContext;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="menu-anchor" ref={anchorRef}>
      <button
        aria-controls="staff-account-menu"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Staff account"
        className="avatar"
        onClick={() => setOpen(!open)}
        ref={triggerRef}
        type="button"
      >
        <CircleUserRound aria-hidden="true" size={19} />
      </button>
      {open && (
        <div aria-label="Staff account menu" className="header-popover account-popover" id="staff-account-menu" role="group">
          <strong>{displayName}</strong><p>{email}</p><small>Database-backed staff session</small>
          <Link className="account-system-link" href={`${settingsHref}#passkeys`} onClick={close}>
            <Fingerprint aria-hidden="true" size={17} />
            Passkeys
          </Link>
          <Link className="account-system-link" href={`${settingsHref}#two-step-verification`} onClick={close}>
            <ShieldQuestion aria-hidden="true" size={17} />
            Two-step verification
          </Link>
          {systemAdminContext && (
            <Link className="account-system-link" href={systemAdminContext.href} onClick={close}>
              <ShieldCheck aria-hidden="true" size={17} />
              {systemAdminContext.label}
            </Link>
          )}
          {canSwitchToAttendee && (
            <form action="/api/auth/switch-to-attendee" className="account-switch-form" method="post">
              <button className="account-system-link account-switch-button" type="submit">
                <ArrowRightLeft aria-hidden="true" size={17} />
                Switch to my attendee account
              </button>
            </form>
          )}
          <Link className="account-system-link" href={attendeePreviewHref} onClick={close}>
            <Eye aria-hidden="true" size={17} />
            Preview attendee experience
          </Link>
          <SignOutButton />
        </div>
      )}
    </div>
  );
}
