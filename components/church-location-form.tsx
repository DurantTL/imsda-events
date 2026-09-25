"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import type { ChurchLocationRecord } from "@/modules/organizations/church-location-repository";

type LocationResponse = { location?: ChurchLocationRecord; message?: string; issues?: Array<{ message?: string }> };

function numberOrNull(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : text;
}

/**
 * A church's town and hand-entered map coordinates (#437), for conference
 * staff. Coordinates place the church's listed clubs on the public club
 * map; nothing here is geocoded, so staff type them in from a source they
 * trust (or leave them blank and the church just won't have a pin).
 */
export function ChurchLocationForm({
  endpoint,
  initialLocation,
}: {
  endpoint: string;
  initialLocation: ChurchLocationRecord;
}) {
  const [location, setLocation] = useState(initialLocation);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city: String(form.get("city") ?? ""),
          state: String(form.get("state") ?? ""),
          zip: String(form.get("zip") ?? ""),
          latitude: numberOrNull(form.get("latitude")),
          longitude: numberOrNull(form.get("longitude")),
        }),
      });
      const result = await response.json().catch(() => ({})) as LocationResponse;
      if (!response.ok || !result.location) {
        throw new Error(result.message ?? result.issues?.[0]?.message ?? "The church location could not be saved.");
      }
      setLocation(result.location);
      setNotice("Church location saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The church location could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="panel form-stack" key={location.updatedAt ?? "new"} onSubmit={save}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">{location.name}</p>
          <h2>Church location</h2>
        </div>
      </div>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <div className="form-grid two-column">
        <label>
          City or town
          <input defaultValue={location.city} maxLength={120} name="city" placeholder="e.g. Des Moines" />
        </label>
        <label>
          State
          <input defaultValue={location.state} maxLength={2} name="state" placeholder="e.g. IA" />
        </label>
        <label>
          ZIP code
          <input defaultValue={location.zip} maxLength={10} name="zip" placeholder="e.g. 50309 or 50309-1234" />
        </label>
      </div>
      <div className="form-grid two-column">
        <label>
          Latitude
          <input defaultValue={location.latitude ?? ""} inputMode="decimal" name="latitude" placeholder="e.g. 41.5868" />
        </label>
        <label>
          Longitude
          <input defaultValue={location.longitude ?? ""} inputMode="decimal" name="longitude" placeholder="e.g. -93.6250" />
        </label>
      </div>
      <p className="field-help">
        Latitude and longitude are typed in by hand, from a source you trust — nothing here looks an address
        up automatically. Give both or leave both blank. A church without coordinates still lists its clubs;
        it just won&apos;t have a pin on the map.
      </p>
      <div>
        <button className="primary-button" disabled={saving} type="submit">
          <Save aria-hidden="true" size={16} /> Save location
        </button>
      </div>
    </form>
  );
}
