"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { MapPin, Save } from "lucide-react";
import type { ChurchLocationRecord } from "@/modules/organizations/church-location-repository";
import { displayCoordinate, numberOrNull } from "@/components/church-location-coordinates";

const ChurchLocationMapPicker = dynamic(
  () => import("@/components/church-location-map-picker").then((mod) => mod.ChurchLocationMapPicker),
  { ssr: false, loading: () => <p className="field-help">Loading map…</p> },
);

type LocationResponse = { location?: ChurchLocationRecord; message?: string; issues?: Array<{ message?: string }> };

/**
 * A church's town and map coordinates (#437, #480), for conference staff.
 * Coordinates place the church's listed clubs on the public club map.
 * Staff can either drop a pin on a map (reusing the map library and CSP
 * scoping added for the public club map, #437) or, switching to manual
 * entry, type coordinates in from a source they trust. Address lookup
 * entered here is saved as set by hand (#724); finding a pin from a street
 * address is the separate "Find map locations" step on the directory.
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
  const [entryMode, setEntryMode] = useState<"manual" | "map">("manual");
  const [latitudeText, setLatitudeText] = useState(initialLocation.latitude !== null ? displayCoordinate(initialLocation.latitude) : "");
  const [longitudeText, setLongitudeText] = useState(initialLocation.longitude !== null ? displayCoordinate(initialLocation.longitude) : "");

  const parsedLatitude = numberOrNull(latitudeText);
  const parsedLongitude = numberOrNull(longitudeText);
  const pinLatitude = typeof parsedLatitude === "number" ? parsedLatitude : null;
  const pinLongitude = typeof parsedLongitude === "number" ? parsedLongitude : null;

  function handlePin(latitude: number, longitude: number) {
    setLatitudeText(displayCoordinate(latitude));
    setLongitudeText(displayCoordinate(longitude));
  }

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
          latitude: parsedLatitude,
          longitude: parsedLongitude,
        }),
      });
      const result = await response.json().catch(() => ({})) as LocationResponse;
      if (!response.ok || !result.location) {
        throw new Error(result.message ?? result.issues?.[0]?.message ?? "The church location could not be saved.");
      }
      setLocation(result.location);
      setLatitudeText(result.location.latitude !== null ? displayCoordinate(result.location.latitude) : "");
      setLongitudeText(result.location.longitude !== null ? displayCoordinate(result.location.longitude) : "");
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
          <input
            inputMode="decimal"
            name="latitude"
            onChange={(event) => setLatitudeText(event.target.value)}
            placeholder="e.g. 41.5868"
            readOnly={entryMode === "map"}
            value={latitudeText}
          />
        </label>
        <label>
          Longitude
          <input
            inputMode="decimal"
            name="longitude"
            onChange={(event) => setLongitudeText(event.target.value)}
            placeholder="e.g. -93.6250"
            readOnly={entryMode === "map"}
            value={longitudeText}
          />
        </label>
      </div>
      <div>
        <button
          className="secondary-button"
          onClick={() => setEntryMode((mode) => (mode === "map" ? "manual" : "map"))}
          type="button"
        >
          <MapPin aria-hidden="true" size={16} />
          {entryMode === "map" ? "Enter coordinates manually" : "Pick on map"}
        </button>
      </div>
      {entryMode === "map" && (
        <ChurchLocationMapPicker latitude={pinLatitude} longitude={pinLongitude} onChange={handlePin} />
      )}
      <p className="field-help">
        {entryMode === "map"
          ? "Click the map to place the church's pin, or drag an existing pin to adjust it. Coordinates fill in above; switch to manual entry to type them instead."
          : "Latitude and longitude are typed in by hand, from a source you trust. Give both or leave both blank, or use “Pick on map” instead."}
        {" "}Saving here marks this location as set by hand, so imports and “Find map locations” leave it alone.
        {location.source === "IMPORT" && " It currently comes from the eAdventist import."}
        {location.source === "GEOCODED" && " It currently comes from an accepted address lookup."}
        {" "}A church without coordinates still lists its clubs; it just won&apos;t have a pin on the map.
      </p>
      <div>
        <button className="primary-button" disabled={saving} type="submit">
          <Save aria-hidden="true" size={16} /> Save location
        </button>
      </div>
    </form>
  );
}
