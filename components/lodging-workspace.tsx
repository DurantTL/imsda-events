"use client";

import { useState } from "react";
import { staffPageTitles } from "@/components/staff-navigation";
import {
  lodgingCategories,
  lodgingCategoryLabels,
  lodgingRateBases,
  lodgingRateBasisLabels,
  type LodgingCategory,
  type LodgingRateBasis,
} from "@/modules/lodging/domain";
import type { LodgingUnitView, LodgingView } from "@/modules/lodging/service";

async function call(url: string, method: string, body: unknown): Promise<{ lodging: LodgingView }> {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(json.message ?? "That could not be saved.");
  return json;
}

function nightsInService(unit: LodgingUnitView) {
  return unit.nightStatuses.filter((status) => status === "AVAILABLE").length;
}

function describeUnit(unit: LodgingUnitView) {
  const parts = [unit.beds || (unit.isArea ? "counted area" : "no beds listed")];
  if (unit.floor) parts.push(`floor ${unit.floor}`);
  if (unit.bathroom === "PRIVATE") parts.push("private bath");
  if (unit.bathroom === "SHARED") parts.push("shared bath");
  if (unit.bathroom === "BATHHOUSE") parts.push("bathhouse");
  if (unit.specialUse) parts.push("special use");
  if (!unit.assignable) parts.push("not assignable");
  return parts.join(", ");
}

export function LodgingWorkspace({ eventName, initialView, canSetRates }: { eventName: string; initialView: LodgingView; canSetRates: boolean }) {
  const [view, setView] = useState(initialView);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/events/${view.eventId}/lodging`;

  async function run(action: () => Promise<{ lodging: LodgingView }>, success: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await action();
      setView(result.lodging);
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That could not be saved.");
    } finally { setBusy(false); }
  }

  return <div className="settings-stack">
    <div className="page-intro"><div>
      <p className="eyebrow">Event configuration</p>
      <h2 className="duplicate-page-title">{staffPageTitles.lodging}</h2>
      <p>Rooms, beds and sites for {eventName}, night by night. This is inventory only: nobody is assigned here. Hotel details on the event settings page are separate and never counted as on-site lodging. What guests asked for is on the <a href={`/more/lodging/requests?event=${encodeURIComponent(view.eventId)}`}>Lodging requests</a> page.</p>
    </div></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p className="usage-note" role="status">{notice}</p> : null}

    {!view.property ? <section className="panel">
      <h3>Choose a property</h3>
      <form onSubmit={(event) => {
        event.preventDefault();
        const key = new FormData(event.currentTarget).get("propertyKey");
        void run(() => call(base, "POST", { propertyKey: key }), "Property chosen.");
      }}>
        {view.availableProperties.length === 0
          ? <p>No properties are set up yet. An operator runs <code>npm run lodging:sync</code>.</p>
          : <>
            <label>Property <select name="propertyKey" required>{view.availableProperties.map((property) => <option key={property.key} value={property.key}>{property.name}</option>)}</select></label>
            <button className="primary-button" type="submit" disabled={busy}>Use this property</button>
          </>}
      </form>
    </section> : <>
      <section className="panel">
        <h3>{view.property.name}</h3>
        <p>Inventory version {view.property.templateVersion}{view.property.currentTemplateVersion !== view.property.templateVersion ? ` (version ${view.property.currentTemplateVersion} is available)` : ""}.{" "}
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(() => call(base, "POST", { propertyKey: view.property!.key }), "Inventory updated from the property template.")}>Add any new units from the template</button></p>
        {view.nights.length === 0 ? <p>This event has no bookable nights.</p> : <div className="table-wrap"><table>
          <caption>People the inventory takes, by night</caption>
          <thead><tr><th scope="col">Night</th><th scope="col">Capacity in service</th></tr></thead>
          <tbody>{view.totalsByNight.map((row) => <tr key={row.night}><td>{row.night}</td><td>{row.capacity}{row.unlimited ? " plus tent camping (no fixed limit)" : ""}</td></tr>)}</tbody>
        </table></div>}
      </section>

      {view.buildings.map((building) => <section className="panel" key={building.key}>
        <h3>{building.name}</h3>
        <div className="table-wrap"><table>
          <thead><tr><th scope="col">Unit</th><th scope="col">Details</th><th scope="col">Sleeps up to</th><th scope="col">Nights in service</th><th scope="col">Unavailable</th><th scope="col">Holds</th></tr></thead>
          <tbody>{building.units.map((unit) => <UnitRow key={unit.eventUnitId} unit={unit} nights={view.nights} base={base} busy={busy} run={run} />)}</tbody>
        </table></div>
      </section>)}

      <section className="panel">
        <h3>Lodging rates</h3>
        <p>No rate means lodging is included or free. A tent with power uses the tent rate unless it has its own.</p>
        {canSetRates ? <table>
          <thead><tr><th scope="col">Category</th><th scope="col">Current rate</th><th scope="col">Set</th></tr></thead>
          <tbody>{lodgingCategories.map((category) => <RateRow key={category} category={category} view={view} base={base} busy={busy} run={run} />)}</tbody>
        </table> : <p>Only staff who manage finance can set rates.{" "}
          {Object.keys(view.rates).length === 0 ? "None are set." : lodgingCategories.filter((category) => view.rates[category]).map((category) => `${lodgingCategoryLabels[category]}: ${formatRate(view.rates[category]!)}`).join("; ")}</p>}
      </section>
    </>}
  </div>;
}

function formatRate(rate: { amountCents: number; basis: LodgingRateBasis; minimumNights: number | null }) {
  return `$${(rate.amountCents / 100).toFixed(2)} ${lodgingRateBasisLabels[rate.basis]}${rate.minimumNights ? `, ${rate.minimumNights}+ nights` : ""}`;
}

function UnitRow({ unit, nights, base, busy, run }: {
  unit: LodgingUnitView;
  nights: string[];
  base: string;
  busy: boolean;
  run: (action: () => Promise<{ lodging: LodgingView }>, success: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const activeHolds = unit.holds.filter((hold) => hold.active);
  return <>
    <tr>
      <th scope="row">{unit.name}</th>
      <td>{describeUnit(unit)}{unit.notes ? ` (${unit.notes})` : ""}</td>
      <td>
        <form onSubmit={(event) => {
          event.preventDefault();
          const raw = String(new FormData(event.currentTarget).get("capacity") ?? "").trim();
          void run(() => call(`${base}/units/${unit.eventUnitId}`, "PATCH", { capacityOverride: raw === "" ? null : Number(raw) }), `Capacity for ${unit.name} saved.`);
        }}>
          <label className="visually-hidden" htmlFor={`cap-${unit.eventUnitId}`}>Sleeps up to for {unit.name}</label>
          <input id={`cap-${unit.eventUnitId}`} name="capacity" type="number" min={0} max={500} defaultValue={unit.capacityOverride ?? ""} placeholder={unit.defaultCapacity === null ? "no limit" : String(unit.defaultCapacity)} />
          <button type="submit" disabled={busy}>Save</button>
        </form>
      </td>
      <td>{nightsInService(unit)} of {nights.length}</td>
      <td>
        <label><input type="checkbox" checked={unit.unavailable} disabled={busy} onChange={(event) => void run(() => call(`${base}/units/${unit.eventUnitId}`, "PATCH", { unavailable: event.target.checked }), `${unit.name} updated.`)} /> Unavailable</label>
      </td>
      <td><button type="button" className="secondary-button" aria-expanded={open} onClick={() => setOpen(!open)}>{activeHolds.length} active, {unit.holds.length} total</button></td>
    </tr>
    {open ? <tr><td colSpan={6}>
      {unit.holds.length === 0 ? <p>No holds yet.</p> : <ul>{unit.holds.map((hold) => <li key={hold.id}>
        <strong>{hold.kind === "STAFF" ? "Staff hold" : "Maintenance"}</strong>: {hold.reason}, {hold.firstNight} to {hold.lastNight}{hold.active ? "" : ` (released: ${hold.releaseReason})`}
        <ul>{hold.history.map((entry, index) => <li key={index}>{entry.type.toLowerCase().replace("_", " ")} on {entry.at.slice(0, 10)}{entry.reason ? `: ${entry.reason}` : ""}{entry.firstNight ? ` (${entry.firstNight} to ${entry.lastNight})` : ""}</li>)}</ul>
        {hold.active ? <form onSubmit={(event) => {
          event.preventDefault();
          const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
          void run(() => call(`${base}/holds/${hold.id}`, "PATCH", { action: "release", reason }), "Hold released.");
        }}>
          <label>Reason for releasing <input name="reason" required maxLength={300} /></label>
          <button type="submit" disabled={busy}>Release hold</button>
        </form> : null}
      </li>)}</ul>}
      <form onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void run(() => call(`${base}/units/${unit.eventUnitId}/holds`, "POST", {
          kind: form.get("kind"), reason: form.get("reason"), firstNight: form.get("firstNight"), lastNight: form.get("lastNight"),
        }), `Hold placed on ${unit.name}.`);
      }}>
        <label>Kind <select name="kind"><option value="STAFF">Staff hold</option><option value="MAINTENANCE">Maintenance</option></select></label>
        <label>Reason <input name="reason" required maxLength={300} /></label>
        <label>First night <input name="firstNight" type="date" required defaultValue={nights[0]} /></label>
        <label>Last night <input name="lastNight" type="date" required defaultValue={nights[nights.length - 1]} /></label>
        <button type="submit" disabled={busy || nights.length === 0}>Place hold</button>
      </form>
    </td></tr> : null}
  </>;
}

function RateRow({ category, view, base, busy, run }: {
  category: LodgingCategory;
  view: LodgingView;
  base: string;
  busy: boolean;
  run: (action: () => Promise<{ lodging: LodgingView }>, success: string) => Promise<void>;
}) {
  const rate = view.rates[category];
  return <tr>
    <th scope="row">{lodgingCategoryLabels[category]}</th>
    <td>{rate ? formatRate(rate) : category === "TENT_WITH_POWER" && view.rates.TENT ? "Uses the tent rate" : "Included or free"}</td>
    <td><form onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const dollars = Number(form.get("amount"));
      const minimum = String(form.get("minimumNights") ?? "").trim();
      void run(() => call(`${base}/rates`, "PUT", {
        category,
        rate: { amountCents: Math.round(dollars * 100), basis: form.get("basis"), minimumNights: minimum === "" ? null : Number(minimum) },
      }), `${lodgingCategoryLabels[category]} rate saved.`);
    }}>
      <label>Amount ($) <input name="amount" type="number" min={0} step="0.01" required defaultValue={rate ? (rate.amountCents / 100).toFixed(2) : ""} /></label>
      <label>Basis <select name="basis" defaultValue={rate?.basis ?? "PER_UNIT_NIGHT"}>{lodgingRateBases.map((basis) => <option key={basis} value={basis}>{lodgingRateBasisLabels[basis]}</option>)}</select></label>
      <label>Minimum nights <input name="minimumNights" type="number" min={1} max={30} defaultValue={rate?.minimumNights ?? ""} /></label>
      <button type="submit" disabled={busy}>Save rate</button>
      {rate ? <button type="button" disabled={busy} onClick={() => void run(() => call(`${base}/rates`, "PUT", { category, rate: null }), `${lodgingCategoryLabels[category]} rate removed.`)}>Remove rate</button> : null}
    </form></td>
  </tr>;
}
