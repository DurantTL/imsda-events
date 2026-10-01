"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** One-click active/inactive for a directory record (#649). */
export function OrganizationStatusButton({ organizationId, name, isActive }: { organizationId: string; name: string; isActive: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function toggle() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/organizations/${encodeURIComponent(organizationId)}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !isActive }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? "The status couldn't be changed.");
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The status couldn't be changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button aria-label={`${isActive ? "Mark inactive" : "Mark active"}: ${name}`} className="secondary-button org-status-button" disabled={busy} onClick={toggle} type="button">
        {busy ? "Saving…" : isActive ? "Mark inactive" : "Mark active"}
      </button>
      {error && <span className="field-error" role="alert"> {error}</span>}
    </>
  );
}
