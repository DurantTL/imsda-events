"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { forgetLauncherPosition } from "@/components/more-launcher-model";

export function SignOutButton({ className = "text-button", label = "Sign out" }: { className?: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    // A shared tab must not carry this person's More position to the next sign-in.
    forgetLauncherPosition();
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return <button className={className} type="button" onClick={signOut} disabled={busy}><LogOut aria-hidden="true" size={16} /> {busy ? "Signing out…" : label}</button>;
}
