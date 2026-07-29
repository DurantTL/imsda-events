"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The attendee counterpart of `SignOutButton`. It calls a different endpoint and
 * returns to a different sign-in page, because the two session types are
 * separate all the way down.
 */
export function AttendeeSignOutButton({ className = "text-button" }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/attendee/sign-out", { method: "POST" });
    } finally {
      router.replace("/account/sign-in");
      router.refresh();
    }
  }

  return (
    <button className={className} type="button" onClick={signOut} disabled={busy}>
      <LogOut aria-hidden="true" size={16} /> {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
