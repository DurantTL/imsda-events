"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function SignOutButton({ className = "text-button" }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return <button className={className} type="button" onClick={signOut} disabled={busy}><LogOut aria-hidden="true" size={16} /> {busy ? "Signing out…" : "Sign out"}</button>;
}
