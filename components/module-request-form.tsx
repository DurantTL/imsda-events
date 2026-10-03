"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { MODULE_REQUEST_REASON_MAX } from "@/modules/event-modules/request-domain";

/**
 * "Request" for one event module (#741 slice 3), for an Event Admin. The route
 * and service check the role again, so hiding the form is never the protection.
 * A system administrator reviews the request; nothing turns on here.
 */
export function ModuleRequestForm({ eventId, moduleKey, title }: { eventId: string; moduleKey: string; title: string }) {
  const router = useRouter();
  const fieldId = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/module-requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ moduleKey, reason }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message ?? "The request could not be sent.");
      }
      setReason("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="module-request-form" onSubmit={submit}>
      <label htmlFor={fieldId}>Why does this event need it?</label>
      <textarea
        id={fieldId}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={MODULE_REQUEST_REASON_MAX}
        required
        rows={3}
      />
      <small>{reason.length} of {MODULE_REQUEST_REASON_MAX}</small>
      <button className="primary-button" type="submit" disabled={busy || reason.trim() === ""} aria-label={`Request ${title}`}>
        {busy ? "Sending…" : "Request"}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  );
}
