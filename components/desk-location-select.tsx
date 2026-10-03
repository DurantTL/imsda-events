"use client";

import { useRouter } from "next/navigation";
import { useRef, useSyncExternalStore } from "react";
import { MapPin } from "lucide-react";

const subscribeNever = () => () => {};

type DeskLocation = { id: string; name: string; isActive?: boolean };

/**
 * The URL the "All locations" / per-location links of LocationFilter produce
 * (#413): the page's other parameters are kept, `location` is set only for a
 * specific location.
 */
export function deskLocationHref(basePath: string, params: Record<string, string | undefined>, locationId: string | null) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value && key !== "location") query.set(key, value);
  if (locationId) query.set("location", locationId);
  const text = query.toString();
  return text ? `${basePath}?${text}` : basePath;
}

/** A location's name, with inactive ones marked the way LocationFilter marks them. */
export function deskLocationLabel(location: DeskLocation) {
  return `${location.name}${location.isActive === false ? " (inactive)" : ""}`;
}

/**
 * The check-in desk's compact location control: a label and a native select on
 * one line, so Search and Scan stay the first big controls. A GET form, so it
 * works without scripts (the Apply button shows). With scripts, choosing a
 * location navigates at once and the button is visually hidden but stays in
 * the keyboard order (it shows again when focused). Renders nothing for an
 * event with no locations.
 */
export function DeskLocationSelect({
  basePath,
  locations,
  params = {},
  selectedId,
}: {
  basePath: string;
  locations: DeskLocation[];
  params?: Record<string, string | undefined>;
  selectedId: string | null;
}) {
  const router = useRouter();
  // False on the server and during hydration, true once scripts run.
  const enhanced = useSyncExternalStore(subscribeNever, () => true, () => false);
  const selectRef = useRef<HTMLSelectElement>(null);
  if (locations.length === 0) return null;
  const hidden = Object.entries(params).filter(([key, value]) => value && key !== "location") as Array<[string, string]>;
  return (
    <form
      action={basePath}
      aria-label="Filter by location"
      className="desk-location"
      method="get"
      onSubmit={(event) => {
        if (!enhanced) return;
        event.preventDefault();
        router.push(deskLocationHref(basePath, params, selectRef.current?.value || null));
      }}
    >
      {hidden.map(([key, value]) => <input key={key} name={key} type="hidden" value={value} />)}
      <label className="desk-location-label" htmlFor="desk-location-select">
        <MapPin aria-hidden="true" size={14} /> Desk location
      </label>
      <select
        defaultValue={selectedId ?? ""}
        id="desk-location-select"
        name="location"
        onChange={() => { if (enhanced) selectRef.current?.form?.requestSubmit(); }}
        ref={selectRef}
      >
        <option value="">All locations</option>
        {locations.map((location) => <option key={location.id} value={location.id}>{deskLocationLabel(location)}</option>)}
      </select>
      <button className={enhanced ? "secondary-button desk-location-go desk-location-go-hidden" : "secondary-button desk-location-go"} type="submit">Apply</button>
    </form>
  );
}
