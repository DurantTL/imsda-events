"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { waitlistOfferHoursMax, waitlistOfferHoursMin } from "@/modules/honors/waitlist-domain";

/**
 * How long a club director has to accept a seat offered from a full Honors
 * Weekend class's waitlist (#831), for this event. An offer not accepted in
 * time passes to the next youth in line.
 */
export function HonorWaitlistSettings({ eventId, initialHours }: { eventId: string; initialHours: number }) {
  const [hours, setHours] = useState(String(initialHours));
  const [saved, setSaved] = useState(initialHours);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save() {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/honors/waitlist`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerHours: Number(hours) }),
      });
      const result = await response.json().catch(() => ({})) as { offerHours?: number; message?: string };
      if (!response.ok || typeof result.offerHours !== "number") throw new Error(result.message ?? "The window could not be saved.");
      setSaved(result.offerHours);
      setHours(String(result.offerHours));
      setMessage("Saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The window could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const valid = Number.isInteger(Number(hours)) && Number(hours) >= waitlistOfferHoursMin && Number(hours) <= waitlistOfferHoursMax;
  return (
    <section className="panel" aria-labelledby="honor-waitlist-settings-heading">
      <h2 id="honor-waitlist-settings-heading">Class waitlist offers</h2>
      <p className="field-help">
        When a seat opens in a full class, the next youth on its waitlist is offered it and their club director is emailed. They have this long to accept
        before the seat is offered to the next youth. Offers stop when the site&apos;s class-change deadline passes.
      </p>
      <label>
        Hours to accept an offered seat
        <input
          inputMode="numeric"
          max={waitlistOfferHoursMax}
          min={waitlistOfferHoursMin}
          onChange={(event) => setHours(event.target.value)}
          type="number"
          value={hours}
        />
      </label>
      {message && <div className="inline-notice success" role="status">{message}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <button className="secondary-button" disabled={saving || !valid || Number(hours) === saved} onClick={save} type="button">
        <Save aria-hidden="true" size={16} /> {saving ? "Saving…" : "Save window"}
      </button>
    </section>
  );
}
