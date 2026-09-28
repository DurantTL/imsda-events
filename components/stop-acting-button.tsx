"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * "Stop acting" (#442): ends the staff session's active act-as, then
 * navigates to the safe staff page the API names (#466) instead of
 * `router.refresh()`-ing the current page in place. With the act-as gone,
 * the page it was shown on can belong to the attendee portal and redirect
 * to attendee sign-in, stranding the still-signed-in staff member there.
 */
export function StopActingButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function stop() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/act-as/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json().catch(() => ({})) as { message?: string; href?: string };
      if (!response.ok) throw new Error(body.message ?? "That didn't work. Try again.");
      router.replace(body.href ?? "/admin/organizations");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That didn't work. Try again.");
      setBusy(false);
    }
  }

  return (
    <span className="act-as-banner-actions">
      <button className="secondary-button" disabled={busy} onClick={() => void stop()} type="button">
        {busy ? "Stopping…" : "Stop acting"}
      </button>
      {error && <span className="form-error" role="alert">{error}</span>}
    </span>
  );
}
