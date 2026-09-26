"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** "Stop acting" (#442): ends the staff session's active act-as, for both roles. */
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
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? "That didn't work. Try again.");
      }
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
