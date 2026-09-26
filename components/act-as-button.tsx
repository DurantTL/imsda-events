"use client";

import { useState } from "react";
import { ArrowRight, UserRoundCog } from "lucide-react";

/**
 * "Act as" for system administrators (#442): acts inside the current staff
 * session for a couple of hours, never touching the staff member's own
 * attendee account. Audited, ends by itself, and "Stop acting" (shown while
 * it's active) ends it early.
 */
export function ActAsButton({ endpoint, label, confirmText }: { endpoint: string; label: string; confirmText: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ message: string; href: string } | null>(null);

  async function act() {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await response.json().catch(() => ({})) as { message?: string; href?: string };
      if (!response.ok || !body.href) throw new Error(body.message ?? "That didn't work. Try again.");
      setResult({ message: body.message ?? "", href: body.href });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="act-as">
      {result ? (
        <p className="inline-notice success" role="status">
          {result.message}{" "}
          <a href={result.href}>Open it <ArrowRight aria-hidden="true" size={13} /></a>.
        </p>
      ) : (
        <button className="secondary-button" disabled={busy} onClick={() => void act()} type="button">
          <UserRoundCog aria-hidden="true" size={14} /> {busy ? "Setting up…" : label}
        </button>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
