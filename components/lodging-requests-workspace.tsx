"use client";

import { useState, type FormEvent } from "react";
import { describeRate, lodgingCategories, lodgingCategoryLabels } from "@/modules/lodging/domain";
import {
  CHURCH_SPONSOR_WARNING,
  chargeChangeSentence,
  fullBehaviors,
  lodgingRuleKindLabels,
  lodgingRuleKinds,
  reviewKindLabels,
} from "@/modules/lodging/preferences-domain";
import type { StaffLodgingRequestView, StaffLodgingRequestsView } from "@/modules/lodging/preferences-service";

type ChargeResult = { priceNeedsReview?: boolean; belowMinimumAfter?: boolean; churchSponsorReview?: boolean; chargeDeltaCents?: number; registrantDeltaCents?: number; sponsorDeltaCents?: number; originallyChargedCents?: number; requestNowCostsCents?: number; promo?: { code: string; coversLodging: boolean; sponsored: boolean } | null };
type Reply = { requests?: StaffLodgingRequestsView; result?: ChargeResult };
type Run = (action: () => Promise<Reply>, success: string) => Promise<void>;

async function call(url: string, method: string, body: unknown): Promise<Reply> {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(json.message ?? "That could not be saved.");
  return json;
}

const formatRate = describeRate;

/**
 * Staff review of lodging requests (#199): settings, the review queue, what each registration asked for, and the
 * keep-together and keep-apart rules. This screen assigns nobody; rooms are assigned on the Lodging assignments page. The accessibility columns
 * appear only when the server sent them, which it does for staff holding VIEW_SENSITIVE_DATA.
 */
export function LodgingRequestsWorkspace({ eventName, initialView, canConfigure, canExport }: {
  eventName: string;
  initialView: StaffLodgingRequestsView;
  canConfigure: boolean;
  canExport: boolean;
}) {
  const [view, setView] = useState(initialView);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [chargeChange, setChargeChange] = useState<ChargeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const base = `/api/events/${view.eventId}/lodging`;

  const run: Run = async (action, success) => {
    setBusy(true); setError(""); setNotice(""); setChargeChange(null);
    try {
      const result = await action();
      // The settings route sends the staff view only to someone who may read it; otherwise keep what is on screen.
      if (result.requests) setView(result.requests);
      setNotice(success);
      if (result.result?.priceNeedsReview || result.result?.churchSponsorReview) setChargeChange(result.result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That could not be saved.");
    } finally { setBusy(false); }
  };

  const queue = view.queue.filter((item) => showAcknowledged || !item.acknowledged);
  const activeRules = view.rules.filter((rule) => !rule.ended);

  return <div className="settings-stack">
    <div className="page-intro"><div>
      <p className="eyebrow">Registration</p>
      <h2 className="duplicate-page-title">Lodging requests</h2>
      <p>What guests asked for at {eventName}. A request is a preference, never an assignment: nobody is placed in a room here (use Lodging assignments for that). Roommate requests count as mutual only when both sides ask or staff approve, and no contact details are shown.</p>
      {canExport ? <p><a className="secondary-button" href={`/api/events/${view.eventId}/exports/lodging-requests`}>Download requests (CSV)</a></p> : null}
    </div></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p className="usage-note" role="status">{notice}</p> : null}
    {chargeChange !== null ? <p className="form-error" role="status" data-testid="charge-change">
      {chargeChangeSentence(chargeChange)}{" "}
      {chargeChange.churchSponsorReview ? "Nothing is charged or refunded automatically." : <>Record the difference as an adjustment in{" "}
      <a href={`/finance?event=${encodeURIComponent(view.eventId)}`}>Payments</a>; nothing is charged or refunded automatically.</>}
    </p> : null}

    <section className="panel" aria-labelledby="lodging-settings">
      <h3 id="lodging-settings">Preference settings</h3>
      {canConfigure ? <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const deadline = String(form.get("deadline") ?? "").trim();
        void run(() => call(`${base}/settings`, "PATCH", {
          collectsPreferences: form.get("collects") === "on",
          preferencesDeadline: deadline === "" ? null : deadline,
          fullBehavior: form.get("fullBehavior"),
        }), "Settings saved.");
      }}>
        <label><input type="checkbox" name="collects" defaultChecked={view.settings.collectsPreferences} /> Registrants choose a lodging type (turn off for club events, where staff assign)</label>
        <label>Last day to change <input type="date" name="deadline" defaultValue={view.settings.preferencesDeadline ?? ""} /></label>
        <p className="field-hint">Blank follows the registration close date. Right now registrants can change their choice through {view.settings.effectiveDeadline}{view.settings.deadlinePassed ? " (passed)" : ""}.</p>
        <label>When a type is full <select name="fullBehavior" defaultValue={view.settings.fullBehavior}>
          {fullBehaviors.map((value) => <option key={value} value={value}>{value === "SHOW_FULL" ? "Show \"Full\"" : "Show \"Full\" and let guests join a lodging waitlist"}</option>)}
        </select></label>
        <button className="primary-button" type="submit" disabled={busy}>Save settings</button>
      </form> : <p>{view.settings.collectsPreferences ? "Registrants choose a lodging type" : "Registrants do not choose lodging (staff assign)"}; changes close after {view.settings.effectiveDeadline}; a full type shows {view.settings.fullBehavior === "WAITLIST" ? "\"Full\" and guests can join a lodging waitlist" : "\"Full\""}. Event administrators change these.</p>}
      <table>
        <caption>Lodging types offered</caption>
        <thead><tr><th scope="col">Type</th><th scope="col">Units in service</th><th scope="col">Asking (rooms or people)</th><th scope="col">Rate</th></tr></thead>
        <tbody>{view.offered.map((row) => <tr key={row.category}><th scope="row">{row.label}</th><td>{row.unitsInService}</td><td>{row.requested} {row.inRooms ? (row.requested === 1 ? "room" : "rooms") : (row.requested === 1 ? "person" : "people")}</td><td>{row.rate ? formatRate(row.rate) : "Included or free"}</td></tr>)}</tbody>
      </table>
    </section>

    <section className="panel" aria-labelledby="lodging-queue">
      <h3 id="lodging-queue">Needs a look ({view.queue.filter((item) => !item.acknowledged).length})</h3>
      <label><input type="checkbox" checked={showAcknowledged} onChange={(event) => setShowAcknowledged(event.target.checked)} /> Show items already acknowledged</label>
      {queue.length === 0 ? <p>Nothing needs review.</p> : <ul>{queue.map((item) => <li key={`${item.key}:${item.fingerprint}`}>
        <strong>{reviewKindLabels[item.kind]}</strong>{item.sensitive ? " (restricted)" : ""}{item.acknowledged ? " (acknowledged)" : ""}
        <p>{item.title}. {item.detail}</p>
        {item.flags?.includes("CHURCH_SPONSOR_REVIEW") ? <p role="note"><strong>Church sponsorship needs review.</strong> {CHURCH_SPONSOR_WARNING}</p> : null}
        {item.roommateRequestId && !item.acknowledged ? <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
          const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
          void run(() => call(`${base}/roommates`, "POST", { action: submitter?.value ?? "decline", requestId: item.roommateRequestId, reason }), "Roommate request updated.");
        }}>
          <label>Reason <input name="reason" required maxLength={300} /></label>
          <span className="field-hint">No medical details.</span>
          <button type="submit" value="approve" disabled={busy || item.kind !== "ONE_SIDED_ROOMMATE"}>Approve as mutual</button>
          <button type="submit" value="decline" disabled={busy}>Decline</button>
        </form> : null}
        {!item.acknowledged ? <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          // A restricted item keeps no typed note.
          const note = item.sensitive ? "Acknowledged" : String(new FormData(event.currentTarget).get("note") ?? "");
          void run(() => call(`${base}/requests`, "POST", { action: "acknowledge", itemKey: item.key, fingerprint: item.fingerprint, note }), "Acknowledged.");
        }}>
          {item.sensitive ? null : <><label>Note <input name="note" required maxLength={300} /></label><span className="field-hint">No medical details.</span></>}
          <button type="submit" disabled={busy}>Acknowledge</button>
        </form> : null}
      </li>)}</ul>}
    </section>

    <section className="panel" aria-labelledby="lodging-requests-table">
      <h3 id="lodging-requests-table">Requests ({view.requests.length})</h3>
      {view.requests.length === 0 ? <p>No one has asked for lodging yet.</p> : <div className="table-wrap"><table>
        <thead><tr>
          <th scope="col">Registration</th><th scope="col">Type</th><th scope="col">Nights</th><th scope="col">People</th><th scope="col">Rooms</th>
          {view.canSeeSensitive ? <th scope="col">Ground floor</th> : null}{view.canSeeSensitive ? <th scope="col">Accessible room</th> : null}
          <th scope="col">Private room</th><th scope="col">Household</th><th scope="col">Roommates</th><th scope="col">Version</th><th scope="col">Change</th>
        </tr></thead>
        <tbody>{view.requests.map((request) => <RequestRow key={request.requestId} request={request} view={view} base={base} busy={busy} run={run} />)}</tbody>
      </table></div>}
    </section>

    <section className="panel" aria-labelledby="lodging-rules">
      <h3 id="lodging-rules">Keep together, split and keep apart</h3>
      <p>Everyone on one registration is kept together by default. A minor is kept with their declared responsible adult automatically. Staff rules below add to that; each keeps who made it, why, and when it applied.</p>
      {view.derivedGroups.length > 0 ? <ul>{view.derivedGroups.map((group, index) => <li key={index}>{group.minor} is kept with {group.adult} (responsible adult, system rule, since {group.since.slice(0, 10)}).</li>)}</ul> : null}
      {activeRules.length === 0 ? <p>No staff rules.</p> : <ul>{activeRules.map((rule) => <li key={rule.id}>
        <strong>{lodgingRuleKindLabels[rule.kind]}</strong>: {rule.personA}{rule.personB ? ` and ${rule.personB}` : ""}
        {rule.effectiveFrom || rule.effectiveUntil ? ` (${rule.effectiveFrom ?? "start"} to ${rule.effectiveUntil ?? "end"})` : ""}. Reason: {rule.reason}. Added {rule.createdAt.slice(0, 10)}.
        <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
          void run(() => call(`${base}/rules`, "POST", { action: "end", ruleId: rule.id, reason }), "Rule ended.");
        }}>
          <label>Reason for ending <input name="reason" required maxLength={300} /></label>
          <span className="field-hint">No medical details.</span>
          <button type="submit" disabled={busy}>End rule</button>
        </form>
      </li>)}</ul>}
      {view.rules.some((rule) => rule.ended) ? <details>
        <summary>Ended rules ({view.rules.filter((rule) => rule.ended).length})</summary>
        <ul>{view.rules.filter((rule) => rule.ended).map((rule) => <li key={rule.id}>{lodgingRuleKindLabels[rule.kind]}: {rule.personA}{rule.personB ? ` and ${rule.personB}` : ""}. Reason: {rule.reason}. Ended: {rule.endReason}.</li>)}</ul>
      </details> : null}
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const text = (name: string) => { const value = String(form.get(name) ?? "").trim(); return value === "" ? null : value; };
        const kind = String(form.get("kind"));
        void run(() => call(`${base}/rules`, "POST", {
          action: "create",
          rule: { kind, personAId: text("personAId"), personBId: kind === "SPLIT_HOUSEHOLD" ? null : text("personBId"), reason: text("reason") ?? "", effectiveFrom: text("effectiveFrom"), effectiveUntil: text("effectiveUntil") },
        }), "Rule added.");
      }}>
        <label>Rule <select name="kind">{lodgingRuleKinds.map((kind) => <option key={kind} value={kind}>{lodgingRuleKindLabels[kind]}</option>)}</select></label>
        <label>Person <select name="personAId" required>{view.people.map((person) => <option key={person.personId} value={person.personId}>{person.name} ({person.registration})</option>)}</select></label>
        <label>Other person (not for a split) <select name="personBId"><option value="">None</option>{view.people.map((person) => <option key={person.personId} value={person.personId}>{person.name} ({person.registration})</option>)}</select></label>
        <label>First night <input type="date" name="effectiveFrom" /></label>
        <label>Last night <input type="date" name="effectiveUntil" /></label>
        <label>Reason <input name="reason" required maxLength={300} /></label>
        <span className="field-hint">No medical details.</span>
        <button className="primary-button" type="submit" disabled={busy || view.people.length === 0}>Add rule</button>
      </form>
    </section>
  </div>;
}

function RequestRow({ request, view, base, busy, run }: { request: StaffLodgingRequestView; view: StaffLodgingRequestsView; base: string; busy: boolean; run: Run }) {
  const [open, setOpen] = useState(false);
  const mutual = request.roommates.filter((row) => row.direction === "OUT" && row.status === "MUTUAL").length;
  const waiting = request.roommates.filter((row) => row.direction === "OUT" && row.status === "ONE_SIDED").length;
  return <>
    <tr>
      <th scope="row">{request.registration}{request.afterDeadline ? " (changed after the deadline)" : ""}</th>
      <td>{request.category ? lodgingCategoryLabels[request.category] : "No preference"}</td>
      <td>{request.firstNight ? `${request.firstNight} to ${request.lastNight}` : "Whole event"}</td>
      <td>{request.partySize}</td>
      <td>{request.category ? request.roomCount : "—"}{request.bringsExtraBedding ? " (bringing sleeping bags or air mattresses)" : ""}</td>
      {view.canSeeSensitive ? <td>{request.groundFloorNeeded ? "Yes" : "No"}</td> : null}
      {view.canSeeSensitive ? <td>{request.accessibleRoomNeeded ? "Yes" : "No"}</td> : null}
      <td>{request.privateRoomRequested ? "Yes" : "No"}</td>
      <td>{request.householdPreference === "TOGETHER" ? "Together" : "Flexible"}</td>
      <td>{mutual} mutual, {waiting} waiting</td>
      <td>{request.version}</td>
      <td><button type="button" className="secondary-button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close" : "Details"}</button></td>
    </tr>
    {open ? <tr><td colSpan={view.canSeeSensitive ? 12 : 10}>
      <h4>History ({request.history.length} version{request.history.length === 1 ? "" : "s"})</h4>
      <ul>{request.history.map((entry) => <li key={entry.version}>Version {entry.version}, {entry.at.slice(0, 10)}, by {entry.source.toLowerCase().replace("_", " ")}: {entry.category ? lodgingCategoryLabels[entry.category] : "no preference"}{entry.reason ? `. Reason: ${entry.reason}` : ""}{entry.afterDeadline ? " (after the deadline)" : ""}</li>)}</ul>
      {request.roommates.length > 0 ? <>
        <h4>Roommate requests</h4>
        <ul>{request.roommates.map((row) => <li key={row.id}>{row.direction === "OUT" ? "Asked to room with" : "Asked for by"} {row.other}{row.fromPerson || row.targetPerson ? ` (${[row.fromPerson, row.targetPerson].filter(Boolean).join(" and ")})` : ""}: {row.status === "MUTUAL" ? `mutual (${(row.basis ?? "").toLowerCase().replaceAll("_", " ")})` : row.status === "ONE_SIDED" ? "waiting for the other side" : row.status.toLowerCase()}.
          {row.status === "ONE_SIDED" || row.status === "MUTUAL" ? <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
            void run(() => call(`${base}/roommates`, "POST", { action: "withdraw", requestId: row.id, reason }), "Roommate request withdrawn.");
          }}>
            <label>Reason <input name="reason" required maxLength={300} /></label>
            <span className="field-hint">No medical details.</span>
            <button type="submit" disabled={busy}>Withdraw</button>
          </form> : null}
        </li>)}</ul>
      </> : null}
      {request.churchSponsored ? <p role="note" className="form-error"><strong>Church-sponsored registration.</strong> {CHURCH_SPONSOR_WARNING}</p> : null}
      <h4>Change this request (staff)</h4>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const text = (name: string) => { const value = String(form.get(name) ?? "").trim(); return value === "" ? null : value; };
        void run(() => call(`${base}/requests/${request.registrationId}`, "PUT", {
          category: text("category"),
          firstNight: text("firstNight"),
          lastNight: text("lastNight"),
          partySize: Number(form.get("partySize")),
          ...(Number(form.get("roomCount")) ? { roomCount: Number(form.get("roomCount")) } : {}),
          privateRoomRequested: form.get("privateRoomRequested") === "on",
          householdPreference: form.get("householdPreference"),
          ...(view.canSeeSensitive ? { groundFloorNeeded: form.get("groundFloorNeeded") === "on", accessibleRoomNeeded: form.get("accessibleRoomNeeded") === "on" } : {}),
          reason: text("reason") ?? "",
        }), "Request saved.");
      }}>
        <label>Type <select name="category" defaultValue={request.category ?? ""}><option value="">No preference</option>{lodgingCategories.map((category) => <option key={category} value={category}>{lodgingCategoryLabels[category]}</option>)}</select></label>
        <label>First night <input type="date" name="firstNight" defaultValue={request.firstNight ?? ""} /></label>
        <label>Last night <input type="date" name="lastNight" defaultValue={request.lastNight ?? ""} /></label>
        <label>People <input type="number" name="partySize" min={1} max={100} defaultValue={request.partySize} required /></label>
        <label>Rooms <input type="number" name="roomCount" min={1} max={100} defaultValue={request.roomCount} /></label>
        {request.openChange ? <p className="field-hint" role="note">The registrant asked for: {request.openChange.category ? lodgingCategoryLabels[request.openChange.category] : "no preference"}, {request.openChange.partySize} {request.openChange.partySize === 1 ? "person" : "people"}{request.openChange.category ? `, ${request.openChange.roomCount} ${request.openChange.roomCount === 1 ? "room" : "rooms"}` : ""}{request.openChange.bringsExtraBedding ? ", bringing sleeping bags or air mattresses" : ""}. The fields below start from the current request.</p> : null}
        <label><input type="checkbox" name="privateRoomRequested" defaultChecked={request.privateRoomRequested} /> Private room</label>
        <label>Household <select name="householdPreference" defaultValue={request.householdPreference}><option value="TOGETHER">Together</option><option value="FLEXIBLE">Flexible</option></select></label>
        {view.canSeeSensitive ? <>
          <label><input type="checkbox" name="groundFloorNeeded" defaultChecked={request.groundFloorNeeded} /> Ground floor needed</label>
          <label><input type="checkbox" name="accessibleRoomNeeded" defaultChecked={request.accessibleRoomNeeded} /> Accessible room needed</label>
        </> : null}
        <label>Reason <input name="reason" required maxLength={300} /></label>
        <span className="field-hint">No medical details.</span>
        <button className="primary-button" type="submit" disabled={busy}>Save change</button>
      </form>
    </td></tr> : null}
  </>;
}
