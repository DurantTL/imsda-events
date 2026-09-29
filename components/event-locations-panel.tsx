"use client";

import { useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, MapPin, Pencil, Plus, Power, Trash2, X } from "lucide-react";
import type { EventLocationRecord } from "@/modules/event-locations/repository";
import { getLocationDateWarnings } from "@/modules/events/readiness";

type Draft = {
  name: string;
  address: string;
  firstDay: string;
  lastDay: string;
  registrationClosesOn: string;
  capacity: string;
};

const emptyDraft: Draft = { name: "", address: "", firstDay: "", lastDay: "", registrationClosesOn: "", capacity: "" };

function draftFrom(location: EventLocationRecord): Draft {
  return {
    name: location.name,
    address: location.address ?? "",
    firstDay: location.firstDay ?? "",
    lastDay: location.lastDay ?? "",
    registrationClosesOn: location.registrationClosesOn ?? "",
    capacity: location.capacity === null ? "" : String(location.capacity),
  };
}

function bodyFrom(draft: Draft) {
  return {
    name: draft.name,
    address: draft.address.trim() || null,
    firstDay: draft.firstDay || null,
    lastDay: draft.lastDay || null,
    registrationClosesOn: draft.registrationClosesOn || null,
    capacity: draft.capacity.trim() ? Number(draft.capacity) : null,
  };
}

/**
 * Locations inside one event (#413): staff add, edit, reorder and deactivate
 * the event's sites. A location that registrations use can be deactivated but
 * not deleted. With no locations the event works as it always did; with
 * active locations every new club registration picks one.
 */
export function EventLocationsPanel({
  eventId,
  initialLocations,
}: {
  eventId: string;
  initialLocations: EventLocationRecord[];
}) {
  const [locations, setLocations] = useState(initialLocations);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `/api/events/${encodeURIComponent(eventId)}/locations`;

  async function call(url: string, method: string, body?: unknown, success = "Saved.") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json().catch(() => ({})) as { locations?: EventLocationRecord[]; message?: string };
      if (!response.ok) {
        setError(result.message ?? "That change couldn't be saved.");
        return false;
      }
      if (result.locations) setLocations(result.locations);
      setNotice(success);
      return true;
    } catch {
      setError("We couldn't reach the server. Nothing was changed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = editingId
      ? await call(`${base}/${encodeURIComponent(editingId)}`, "PATCH", bodyFrom(draft), "Location saved.")
      : await call(base, "POST", bodyFrom(draft), "Location added.");
    if (saved) {
      setAdding(false);
      setEditingId(null);
      setDraft(emptyDraft);
    }
  }

  async function move(index: number, offset: -1 | 1) {
    const ids = locations.map((location) => location.id);
    const target = index + offset;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    await call(`${base}/order`, "PUT", { orderedIds: ids }, "Order saved.");
  }

  const formOpen = adding || editingId !== null;

  return (
    <section aria-labelledby="event-locations-title" className="panel form-stack event-settings-panel" id="event-locations">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Sites</p>
          <h2 id="event-locations-title">Locations</h2>
          <p>
            For an event held at more than one site. With no locations the event works as usual. With one or more,
            every new club registration must pick one. Dates left blank use the event&apos;s own dates.
          </p>
        </div>
        <MapPin size={21} aria-hidden="true" />
      </div>
      {error && <div className="inline-notice error" role="alert"><AlertTriangle size={17} aria-hidden="true" /> {error}</div>}
      {notice && <div className="inline-notice success" role="status"><CheckCircle2 size={17} aria-hidden="true" /> {notice}</div>}
      {getLocationDateWarnings(locations).map((warning) => (
        <div className="inline-notice clone-warning" key={warning.id} role="status"><AlertTriangle size={17} aria-hidden="true" /> <span><strong>{warning.label}.</strong> {warning.detail}</span></div>
      ))}
      {locations.length === 0 && !formOpen && <p className="field-help">No locations yet.</p>}
      {locations.length > 0 && (
        <ul className="event-location-list">
          {locations.map((location, index) => (
            <li className={location.isActive ? undefined : "is-inactive"} key={location.id}>
              <span>
                <strong translate="no">{location.name}</strong>
                {!location.isActive && <small> · Inactive</small>}
                <small>
                  {location.address ? <>{location.address} · </> : ""}
                  {location.firstDay || location.lastDay
                    ? `${location.firstDay ?? "event start"} to ${location.lastDay ?? "event end"}`
                    : "Event dates"}
                  {location.registrationClosesOn ? ` · Registration closes ${location.registrationClosesOn}` : ""}
                </small>
                <small>
                  {location.occupied} registered{location.capacity !== null ? ` of ${location.capacity}` : " (no limit)"}
                  {" · "}{location.registrations} {location.registrations === 1 ? "registration" : "registrations"}
                </small>
              </span>
              <span className="event-location-actions">
                <button aria-label={`Move ${location.name} up`} className="secondary-button" disabled={busy || index === 0} onClick={() => void move(index, -1)} type="button"><ArrowUp aria-hidden="true" size={14} /></button>
                <button aria-label={`Move ${location.name} down`} className="secondary-button" disabled={busy || index === locations.length - 1} onClick={() => void move(index, 1)} type="button"><ArrowDown aria-hidden="true" size={14} /></button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => { setAdding(false); setEditingId(location.id); setDraft(draftFrom(location)); setError(""); setNotice(""); }}
                  type="button"
                ><Pencil aria-hidden="true" size={14} /> Edit</button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void call(`${base}/${encodeURIComponent(location.id)}`, "PATCH", { isActive: !location.isActive }, location.isActive ? "Location deactivated." : "Location activated.")}
                  type="button"
                ><Power aria-hidden="true" size={14} /> {location.isActive ? "Deactivate" : "Activate"}</button>
                <button
                  className="secondary-button"
                  disabled={busy || location.registrations > 0}
                  onClick={() => {
                    if (window.confirm(`Delete ${location.name}? This can't be undone.`)) {
                      void call(`${base}/${encodeURIComponent(location.id)}`, "DELETE", undefined, "Location deleted.");
                    }
                  }}
                  title={location.registrations > 0 ? "Registrations use this location. Deactivate it instead." : undefined}
                  type="button"
                ><Trash2 aria-hidden="true" size={14} /> Delete</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {formOpen ? (
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          <div className="form-grid two-column">
            <label>Name<input maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required value={draft.name} /></label>
            <label>Address or directions (optional)<input maxLength={500} onChange={(event) => setDraft({ ...draft, address: event.target.value })} value={draft.address} /></label>
            <label>First day (optional)<input onChange={(event) => setDraft({ ...draft, firstDay: event.target.value })} type="date" value={draft.firstDay} /></label>
            <label>Last day (optional)<input onChange={(event) => setDraft({ ...draft, lastDay: event.target.value })} type="date" value={draft.lastDay} /></label>
            <label>Registration closes (optional)<input onChange={(event) => setDraft({ ...draft, registrationClosesOn: event.target.value })} type="date" value={draft.registrationClosesOn} /></label>
            <label>
              Capacity (people, optional)
              <input inputMode="numeric" min={1} onChange={(event) => setDraft({ ...draft, capacity: event.target.value })} type="number" value={draft.capacity} />
              <small className="field-help">Counted like the event capacity. Blank means no limit.</small>
            </label>
          </div>
          <div className="club-registration-toolbar">
            <button className="secondary-button" onClick={() => { setAdding(false); setEditingId(null); setDraft(emptyDraft); }} type="button"><X aria-hidden="true" size={15} /> Cancel</button>
            <button className="primary-button" disabled={busy} type="submit">{editingId ? "Save location" : "Add location"}</button>
          </div>
        </form>
      ) : (
        <button className="secondary-button" onClick={() => { setDraft(emptyDraft); setAdding(true); setError(""); setNotice(""); }} type="button">
          <Plus aria-hidden="true" size={15} /> Add a location
        </button>
      )}
    </section>
  );
}
