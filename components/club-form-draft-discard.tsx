"use client";

import { useState } from "react";

/** Throws away a stored draft the builder cannot read (#712), so the form can be edited again. */
export function ClubFormDraftDiscard({ templateKey }: { templateKey: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function discard() {
    if (!window.confirm("Discard this draft? The published version is not changed.")) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/club-forms/${encodeURIComponent(templateKey)}/draft`, { method: "DELETE" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { message?: string };
        setError(result.message ?? "The draft could not be discarded.");
        return;
      }
      window.location.reload();
    } catch {
      setError("The draft could not be discarded. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-notice error" role="alert">
      <p>The saved draft of this form can&apos;t be read, so it can&apos;t be edited or published. The published version is not affected.</p>
      <button className="secondary-button" disabled={busy} onClick={() => void discard()} type="button">Discard draft</button>
      {error && <small className="club-report-problem">{error}</small>}
    </div>
  );
}
