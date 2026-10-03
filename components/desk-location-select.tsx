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

/**
 * Keys that change a closed select's value one step at a time (arrows, Home,
 * End, paging, type-ahead letters). Each fires `change`, so they must not
 * navigate; Enter or Apply does.
 */
export function isSelectStepKey(key: string) {
  return ["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(key) || (key.length === 1 && key !== " ");
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
  const steppedByKeyboard = useRef(false);
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
        key={selectedId ?? "all"}
        name="location"
        onChange={() => {
          // Pointer and picker choices navigate at once; keyboard steps wait for Enter or Apply.
          const keyboard = steppedByKeyboard.current;
          steppedByKeyboard.current = false;
          if (enhanced && !keyboard) selectRef.current?.form?.requestSubmit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            steppedByKeyboard.current = false;
            selectRef.current?.form?.requestSubmit();
          } else steppedByKeyboard.current = isSelectStepKey(event.key);
        }}
        onPointerDown={() => { steppedByKeyboard.current = false; }}
        ref={selectRef}
      >
        <option value="">All locations</option>
        {locations.map((location) => <option key={location.id} value={location.id}>{deskLocationLabel(location)}</option>)}
      </select>
      <button className={enhanced ? "secondary-button desk-location-go desk-location-go-hidden" : "secondary-button desk-location-go"} type="submit">Apply</button>
    </form>
  );
}
