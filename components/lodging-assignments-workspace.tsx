"use client";

import { useMemo, useState, type DragEvent, type FormEvent } from "react";
import {
  ExceptionsPanel,
  DisplayPanel,
  PlanPanel,
  ReportsPanel,
  WaitlistPanel,
  callLodging,
  type Run,
} from "@/components/lodging-assignments-panels";
import { lodgingCategoryLabels } from "@/modules/lodging/domain";
import type { AssignmentWorkspaceView, OccupantCard, PersonCard, UnitCard, UnitStatusWord } from "@/modules/lodging/assignment-view";

/**
 * The staff assignment workspace (#200), rebuilt on the server from the legacy CM26 housing tool: building and floor
 * tabs and a hall layout, room status, drag and drop with tap-to-assign and keyboard alternatives, "assign the next
 * person", fill a room, place a household, move a person, a colour per household, expected guests, alternate housing,
 * search and filters, and a warning before special rooms. Capacity and exclusivity are decided by the server night by
 * night; this screen only asks, and shows what the server answers.
 *
 * Accessibility: every drag and drop action has a button (select a person, then "Assign here"), nothing depends on
 * colour alone (status and household are also words), controls are real buttons and fields with labels, results are
 * announced in a live region, and the layout reflows to one column on a phone.
 */

type Tab = "rooms" | "plan" | "waitlist" | "attention" | "reports" | "display";

const statusLabels: Record<UnitStatusWord, string> = {
  AVAILABLE: "Available",
  PARTIAL: "Partly filled",
  FULL: "Full",
  OVER: "Over capacity",
  HELD: "Held",
  UNAVAILABLE: "Unavailable",
  NOT_ASSIGNABLE: "Not assignable",
};

const shortNight = (night: string) => new Date(`${night}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const range = (first: string, last: string) => (first === last ? shortNight(first) : `${shortNight(first)} to ${shortNight(last)}`);

function freeBeds(unit: UnitCard): number | null {
  let free: number | null = null;
  for (const [index, status] of unit.nightStatuses.entries()) {
    if (status !== "AVAILABLE") continue;
    const capacity = unit.nightCapacities[index];
    if (capacity === null || capacity === undefined) continue;
    const left = Math.max(0, capacity - (unit.nightOccupied[index] ?? 0));
    free = free === null ? left : Math.min(free, left);
  }
  return free;
}

function roomNumber(name: string) {
  const match = /(\d+)\s*[A-Za-z]?$/.exec(name);
  return match ? Number(match[1]) : null;
}

function wantedRange(person: PersonCard, nights: readonly string[]) {
  return { first: person.wantedFirstNight ?? nights[0]!, last: person.wantedLastNight ?? nights[nights.length - 1]! };
}

export function LodgingAssignmentsWorkspace({ eventName, initialView, canConfigure, canExport }: {
  eventName: string;
  initialView: AssignmentWorkspaceView;
  canConfigure: boolean;
  canExport: boolean;
}) {
  const [view, setView] = useState(initialView);
  const [tab, setTab] = useState<Tab>("rooms");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<{ occupantKey: string; moveAssignmentId?: string } | null>(null);
  const [moveReason, setMoveReason] = useState("Moved by staff");
  const [pendingSpecial, setPendingSpecial] = useState<{ unit: UnitCard; personKeys: string[] } | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "unassigned" | "assigned">("unassigned");
  const [buildingKey, setBuildingKey] = useState(view.buildings[0]?.key ?? "");
  const [floorLabel, setFloorLabel] = useState("all");
  const [layout, setLayout] = useState<"list" | "hall">("list");
  const base = `/api/events/${view.eventId}/lodging`;

  const run: Run = async (action, success) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await action();
      if (result.workspace) setView(result.workspace);
      // A party placed above a room's beds is allowed, with a warning: they are bringing extra bedding (#803).
      const warnings = (result.result as { warnings?: Array<{ unitName: string; beds: number; people: number }> } | undefined)?.warnings ?? [];
      setNotice(warnings.length === 0 ? success : `${success} Warning: ${warnings.map((warning) => `${warning.unitName} has ${warning.people} people for ${warning.beds} bed${warning.beds === 1 ? "" : "s"}; the party is bringing extra bedding`).join("; ")}.`);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That could not be saved.");
      return false;
    } finally { setBusy(false); }
  };

  const peopleByKey = useMemo(() => new Map(view.people.map((person) => [person.occupantKey, person])), [view.people]);
  const nights = view.nights;
  const selectedPerson = selected ? peopleByKey.get(selected.occupantKey) ?? null : null;
  const unplacedActive = view.people.filter((person) => person.active && person.asksForLodging && person.uncoveredNights > 0 && person.placements.length === 0);

  const matches = (person: PersonCard) => {
    const text = search.trim().toLowerCase();
    if (text && !`${person.name} ${person.registrationCode ?? ""}`.toLowerCase().includes(text)) return false;
    if (filter === "unassigned") return person.active && person.asksForLodging && person.uncoveredNights > 0;
    if (filter === "assigned") return person.placements.length > 0;
    return true;
  };
  const shownPeople = view.people.filter(matches);

  // --- actions -------------------------------------------------------------

  const placementFor = (person: PersonCard, place: { kind: "UNIT"; eventUnitId: string } | { kind: "BUCKET"; bucketId: string }, mode: "ASSIGN" | "MOVE", confirmSpecialUse: boolean, override?: { first: string; last: string }) => {
    const wanted = override ?? wantedRange(person, nights);
    return { occupant: { kind: person.kind, id: person.occupantId }, place, firstNight: wanted.first, lastNight: wanted.last, mode, confirmSpecialUse };
  };

  /** A keep-together member placed somewhere other than where this person is (or not placed at all). */
  function householdIsSplit(person: PersonCard) {
    const first = person.placements[0];
    if (!first) return false;
    return person.householdKeys.some((key) => {
      const member = peopleByKey.get(key);
      return Boolean(member && member.active && member.asksForLodging && (member.placements.length === 0 || member.placements[0]!.label !== first.label));
    });
  }

  function householdOf(person: PersonCard) {
    return [person, ...person.householdKeys.map((key) => peopleByKey.get(key)).filter((member): member is PersonCard => Boolean(member && member.active && member.asksForLodging && member.placements.length === 0))];
  }

  async function placeMany(people: PersonCard[], target: { kind: "UNIT"; unit: UnitCard } | { kind: "BUCKET"; bucketId: string; label: string }, confirmSpecialUse = false) {
    if (target.kind === "UNIT" && target.unit.specialUse && !confirmSpecialUse) {
      setPendingSpecial({ unit: target.unit, personKeys: people.map((person) => person.occupantKey) });
      return;
    }
    setPendingSpecial(null);
    const place = target.kind === "UNIT" ? { kind: "UNIT" as const, eventUnitId: target.unit.eventUnitId } : { kind: "BUCKET" as const, bucketId: target.bucketId };
    const where = target.kind === "UNIT" ? target.unit.name : target.label;
    const moving = selected?.moveAssignmentId ? people.length === 1 : false;
    const move = selected?.moveAssignmentId ? selectedMovePlacement() : null;
    const ok = await run(() => callLodging(`${base}/assignments`, "POST", {
      action: "place",
      reason: moving ? moveReason : "Assigned by staff",
      placements: people.map((person) => placementFor(person, place, moving ? "MOVE" : "ASSIGN", confirmSpecialUse, moving && move ? { first: move.firstNight, last: move.lastNight } : undefined)),
    }), people.length === 1 ? `${people[0]!.name} placed in ${where}.` : `${people.length} people placed in ${where}.`);
    if (ok) setSelected(null);
  }

  function selectedMovePlacement() {
    if (!selected?.moveAssignmentId) return null;
    for (const person of view.people) {
      const found = person.placements.find((placement) => placement.assignmentId === selected.moveAssignmentId);
      if (found) return found;
    }
    return null;
  }

  function assignHere(target: { kind: "UNIT"; unit: UnitCard } | { kind: "BUCKET"; bucketId: string; label: string }) {
    if (!selectedPerson) return;
    void placeMany([selectedPerson], target);
  }

  function placeHousehold(target: { kind: "UNIT"; unit: UnitCard }) {
    if (!selectedPerson) return;
    void placeMany(householdOf(selectedPerson), target);
  }

  function fillRoom(unit: UnitCard) {
    let free = freeBeds(unit);
    const chosen: PersonCard[] = [];
    const taken = new Set<string>();
    for (const person of unplacedActive) {
      if (taken.has(person.occupantKey)) continue;
      const group = householdOf(person).filter((member) => !taken.has(member.occupantKey));
      const size = group.reduce((total, member) => total + member.people, 0);
      if (free !== null && size > free) continue;
      for (const member of group) { chosen.push(member); taken.add(member.occupantKey); }
      if (free !== null) free -= size;
      if (free !== null && free <= 0) break;
    }
    if (chosen.length === 0) { setError("Nobody who is not placed yet fits this room."); return; }
    void placeMany(chosen, { kind: "UNIT", unit });
  }

  function onDragStart(event: DragEvent, payload: string) {
    event.dataTransfer.setData("text/plain", payload);
    event.dataTransfer.effectAllowed = "move";
  }

  function onDrop(event: DragEvent, target: { kind: "UNIT"; unit: UnitCard } | { kind: "BUCKET"; bucketId: string; label: string }) {
    event.preventDefault();
    const payload = event.dataTransfer.getData("text/plain");
    if (payload.startsWith("move:")) {
      const [, assignmentId, occupantKey] = payload.split(":");
      setSelected({ occupantKey: occupantKey!, moveAssignmentId: assignmentId });
      const person = peopleByKey.get(occupantKey!);
      const placement = person?.placements.find((entry) => entry.assignmentId === assignmentId);
      if (person && placement) {
        void (async () => {
          const place = target.kind === "UNIT" ? { kind: "UNIT" as const, eventUnitId: target.unit.eventUnitId } : { kind: "BUCKET" as const, bucketId: target.bucketId };
          if (target.kind === "UNIT" && target.unit.specialUse) { setPendingSpecial({ unit: target.unit, personKeys: [person.occupantKey] }); return; }
          await run(() => callLodging(`${base}/assignments`, "POST", { action: "place", reason: moveReason, placements: [placementFor(person, place, "MOVE", false, { first: placement.firstNight, last: placement.lastNight })] }), `${person.name} moved.`);
          setSelected(null);
        })();
      }
      return;
    }
    const person = peopleByKey.get(payload);
    if (person) void placeMany([person], target);
  }

  const buildingsToShow = view.buildings.filter((building) => building.key === buildingKey);
  const building = buildingsToShow[0];
  const floors = building?.floors ?? [];

  // --- room card -------------------------------------------------------------

  function renderRoom(unit: UnitCard) {
    const free = freeBeds(unit);
    const blocked = unit.status === "HELD" || unit.status === "UNAVAILABLE" || unit.status === "NOT_ASSIGNABLE";
    const headingId = `la-room-${unit.eventUnitId}`;
    return <article key={unit.eventUnitId} className={`lodging-assign-room is-${unit.status.toLowerCase().replace("_", "-")}`} aria-labelledby={headingId}
      onDragOver={(event) => { if (!blocked) event.preventDefault(); }} onDrop={(event) => onDrop(event, { kind: "UNIT", unit })}>
      <header>
        <h4 id={headingId}>{unit.name}</h4>
        <span className="lodging-assign-status">{statusLabels[unit.status]}{unit.extraBedding ? " (extra bedding)" : ""}</span>
      </header>
      <p className="lodging-assign-meta">
        {unit.beds || (unit.isArea ? "Counted area" : "No beds listed")}
        {unit.capacity !== null ? `, takes ${unit.capacity}` : ", no fixed limit"}
        {free !== null && unit.status !== "NOT_ASSIGNABLE" ? `, ${free} free` : ""}
        {unit.groundLevel && unit.kind === "ROOM" ? ", ground level" : ""}
        {unit.bathroom === "PRIVATE" ? ", private bath" : ""}
      </p>
      {unit.specialUse ? <p className="lodging-assign-warning" role="note">Special-use room: you will be asked to confirm.</p> : null}
      {unit.holdReasons.length > 0 ? <p className="lodging-assign-warning" role="note">Held: {unit.holdReasons.join("; ")}</p> : null}
      {unit.unavailableReason ? <p className="lodging-assign-warning" role="note">Unavailable: {unit.unavailableReason}</p> : null}
      <ul className="lodging-assign-occupants" aria-label={`Who is in ${unit.name}`}>
        {unit.occupants.map((occupant) => renderChip(occupant, unit.name))}
      </ul>
      <div className="lodging-assign-actions">
        {selectedPerson && !blocked ? <button type="button" className="primary-button" disabled={busy} onClick={() => assignHere({ kind: "UNIT", unit })}>
          {selected?.moveAssignmentId ? `Move ${selectedPerson.name} here` : `Assign ${selectedPerson.name} here`}
        </button> : null}
        {selectedPerson && !blocked && !selected?.moveAssignmentId && householdOf(selectedPerson).length > 1 ? <button type="button" className="secondary-button" disabled={busy} onClick={() => placeHousehold({ kind: "UNIT", unit })}>
          Place the whole household here ({householdOf(selectedPerson).length})
        </button> : null}
        {!blocked && unit.kind !== "TENT" ? <button type="button" className="secondary-button" disabled={busy || unplacedActive.length === 0} onClick={() => fillRoom(unit)}>Fill this room</button> : null}
      </div>
    </article>;
  }

  function renderChip(occupant: OccupantCard, unitName: string) {
    const person = peopleByKey.get(occupant.occupantKey);
    const whole = nights.length > 0 && occupant.firstNight === nights[0] && occupant.lastNight === nights[nights.length - 1];
    return <li key={occupant.assignmentId} className="lodging-assign-chip" style={{ ["--household" as string]: `var(--la-h${occupant.colorIndex})` }} draggable onDragStart={(event) => onDragStart(event, `move:${occupant.assignmentId}:${occupant.occupantKey}`)}>
      <span className="lodging-assign-chip-name">{occupant.name}{occupant.kind === "PLACEHOLDER" ? " (expected)" : ""}{occupant.people > 1 ? ` x${occupant.people}` : ""}</span>
      <span className="lodging-assign-chip-meta">{occupant.registrationCode ?? "no registration yet"}{whole ? "" : `, ${range(occupant.firstNight, occupant.lastNight)}`}{occupant.inactive ? ", registration not active" : ""}
        {occupant.groundFloorNeeded || occupant.accessibleRoomNeeded ? ", needs ground floor" : ""}</span>
      <details>
        <summary>Change {occupant.name}&apos;s place</summary>
        <div className="lodging-assign-chip-tools">
          <button type="button" className="secondary-button" onClick={() => setSelected({ occupantKey: occupant.occupantKey, moveAssignmentId: occupant.assignmentId })}>Move to another room</button>
          <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void run(() => callLodging(`${base}/assignments`, "POST", { action: "cancel", assignmentId: occupant.assignmentId, reason: String(form.get("reason")) }), `Cancelled ${occupant.name}'s place in ${unitName}.`);
          }}>
            <label>Reason <input name="reason" required maxLength={300} /></label>
            <button type="submit" disabled={busy}>Cancel this placement</button>
          </form>
          <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void run(() => callLodging(`${base}/assignments`, "POST", {
              action: "stay_change", occupant: { kind: occupant.kind, id: occupant.occupantId }, kind: String(form.get("kind")), night: String(form.get("night")),
              keepCapacity: form.get("keep") === "on", reason: String(form.get("reason")),
            }), "Stay changed.");
          }}>
            <fieldset><legend>Late arrival or early departure</legend>
              <label>Change <select name="kind"><option value="LATE_ARRIVAL">Arrives late (first night is)</option><option value="EARLY_DEPARTURE">Leaves early (last night is)</option></select></label>
              <label>Night <select name="night">{nights.map((night) => <option key={night} value={night}>{shortNight(night)}</option>)}</select></label>
              <label><input type="checkbox" name="keep" /> Keep the room held for the nights they give up</label>
              <label>Reason <input name="reason" required maxLength={300} /></label>
              <button type="submit" disabled={busy}>Record</button>
            </fieldset>
          </form>
          <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const to = peopleByKey.get(String(form.get("to")));
            if (!to) return;
            void run(() => callLodging(`${base}/assignments`, "POST", { action: "transfer", assignmentId: occupant.assignmentId, to: { kind: to.kind, id: to.occupantId }, reason: String(form.get("reason")) }), `Transferred the place to ${to.name}.`);
          }}>
            <fieldset><legend>Give this place to someone else</legend>
              <label>To <select name="to" required>{view.people.filter((candidate) => candidate.occupantKey !== occupant.occupantKey && candidate.active && candidate.placements.length === 0).map((candidate) => <option key={candidate.occupantKey} value={candidate.occupantKey}>{candidate.name}{candidate.registrationCode ? ` (${candidate.registrationCode})` : " (expected)"}</option>)}</select></label>
              <label>Reason <input name="reason" required maxLength={300} /></label>
              <button type="submit" disabled={busy}>Transfer</button>
            </fieldset>
          </form>
          {person?.kind === "PLACEHOLDER" ? renderPlaceholderLink(person) : null}
        </div>
      </details>
    </li>;
  }

  function renderPlaceholderLink(person: PersonCard) {
    const candidates = view.people.filter((candidate) => candidate.kind === "ATTENDEE" && candidate.active && candidate.placements.length === 0 && person.people === 1);
    if (candidates.length === 0) return <p key="link" className="field-hint">To link this expected guest, the registered attendee must not be placed yet, and a group cannot be linked.</p>;
    return <form key="link" onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      void run(() => callLodging(`${base}/assignments/placeholders`, "POST", { action: "link", placeholderId: person.occupantId, attendeeId: String(form.get("attendee")), reason: String(form.get("reason")) }), "Linked to the registration.");
    }}>
      <fieldset><legend>Link to their registration</legend>
        <label>Attendee <select name="attendee" required>{candidates.map((candidate) => <option key={candidate.occupantKey} value={candidate.occupantId}>{candidate.name} ({candidate.registrationCode})</option>)}</select></label>
        <label>Reason <input name="reason" required maxLength={300} defaultValue="Registered" /></label>
        <button type="submit" disabled={busy}>Link</button>
      </fieldset>
    </form>;
  }

  const renderUnits = (units: UnitCard[]) => {
    if (layout === "list") return <div className="lodging-assign-rooms">{units.map((unit) => renderRoom(unit))}</div>;
    const left = units.filter((unit) => { const n = roomNumber(unit.name); return n !== null && n % 2 === 1; });
    const right = units.filter((unit) => { const n = roomNumber(unit.name); return n !== null && n % 2 === 0; });
    const other = units.filter((unit) => roomNumber(unit.name) === null);
    return <>
      <div className="lodging-assign-hall">
        <div className="lodging-assign-hall-side">{left.map((unit) => renderRoom(unit))}</div>
        <div className="lodging-assign-corridor" aria-hidden="true">Hall</div>
        <div className="lodging-assign-hall-side">{right.map((unit) => renderRoom(unit))}</div>
      </div>
      {other.length > 0 ? <div className="lodging-assign-rooms">{other.map((unit) => renderRoom(unit))}</div> : null}
    </>;
  };

  const tabs: Array<[Tab, string]> = [
    ["rooms", "Rooms"], ["plan", "Proposal, import and export"], ["waitlist", `Waitlist (${view.counts.waitingOnList})`],
    ["attention", `Needs a look (${view.counts.exceptions})`], ["reports", "Reports"], ["display", "What attendees see"],
  ];

  return <div className="settings-stack lodging-assign">
    <div className="page-intro"><div>
      <p className="eyebrow">Lodging</p>
      <h2 className="duplicate-page-title">Lodging assignments</h2>
      <p>Place guests in rooms and sites at {eventName} ({view.propertyName}). The server checks every night, so two people cannot be given the last bed. Every move keeps who did it and why. Nothing here changes a registration&apos;s charge.</p>
      <p><strong>{view.counts.placed}</strong> placed, <strong>{view.counts.unplaced}</strong> not placed, <strong>{view.counts.waitingOnList}</strong> on the waitlist, <strong>{view.counts.exceptions}</strong> to look at.</p>
    </div></div>
    <div role="status" aria-live="polite" className="lodging-assign-live">
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p className="usage-note">{notice}</p> : null}
    </div>
    {pendingSpecial ? <div className="panel lodging-assign-confirm" role="alertdialog" aria-labelledby="la-special-title">
      <h3 id="la-special-title">{pendingSpecial.unit.name} is a special-use room</h3>
      <p>It is set aside for a particular group. Place {pendingSpecial.personKeys.map((key) => peopleByKey.get(key)?.name).filter(Boolean).join(", ")} there anyway?</p>
      <button type="button" className="primary-button" disabled={busy} onClick={() => {
        const people = pendingSpecial.personKeys.map((key) => peopleByKey.get(key)).filter((person): person is PersonCard => Boolean(person));
        void placeMany(people, { kind: "UNIT", unit: pendingSpecial.unit }, true);
      }}>Yes, place them there</button>
      <button type="button" className="secondary-button" onClick={() => setPendingSpecial(null)}>No, keep my selection</button>
    </div> : null}

    <nav aria-label="Lodging sections" className="lodging-assign-tabs">
      {tabs.map(([key, label]) => <button key={key} type="button" className={tab === key ? "primary-button" : "secondary-button"} aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key)}>{label}</button>)}
    </nav>

    {tab === "rooms" ? <div className="lodging-assign-board">
      <section className="panel lodging-assign-people" aria-labelledby="la-people">
        <h3 id="la-people">People ({shownPeople.length})</h3>
        <label>Search by name or confirmation code <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <div role="group" aria-label="Show">
          {(["unassigned", "assigned", "all"] as const).map((value) => <label key={value}><input type="radio" name="la-filter" checked={filter === value} onChange={() => setFilter(value)} /> {value === "unassigned" ? "Not placed" : value === "assigned" ? "Placed" : "Everyone"}</label>)}
        </div>
        <p><button type="button" className="secondary-button" disabled={unplacedActive.length === 0} onClick={() => { const next = unplacedActive[0]; if (next) setSelected({ occupantKey: next.occupantKey }); }}>Assign the next unplaced person</button></p>
        {selectedPerson ? <div className="usage-note" role="status">
          <span>{selected?.moveAssignmentId ? "Moving" : "Assigning"} <strong>{selectedPerson.name}</strong>. Choose a room, a housing choice below, or</span>
          {selected?.moveAssignmentId ? <label>Reason <input value={moveReason} onChange={(event) => setMoveReason(event.target.value)} maxLength={300} /></label> : null}
          <button type="button" className="secondary-button" onClick={() => setSelected(null)}>Clear my selection</button>
        </div> : <p className="field-hint">Select a person, then press &quot;Assign here&quot; on a room. You can also drag a person onto a room.</p>}
        <ul className="lodging-assign-peoplelist">
          {shownPeople.map((person) => <li key={person.occupantKey} className={selected?.occupantKey === person.occupantKey ? "is-selected" : undefined} style={{ ["--household" as string]: `var(--la-h${person.colorIndex})` }}
            draggable={person.active} onDragStart={(event) => onDragStart(event, person.occupantKey)}>
            <button type="button" aria-pressed={selected?.occupantKey === person.occupantKey && !selected?.moveAssignmentId} disabled={!person.active} onClick={() => setSelected(selected?.occupantKey === person.occupantKey && !selected?.moveAssignmentId ? null : { occupantKey: person.occupantKey })}>
              <span className="lodging-assign-chip-name">{person.name}{person.kind === "PLACEHOLDER" ? " (expected)" : ""}{person.people > 1 ? ` x${person.people}` : ""}</span>
              <span className="lodging-assign-chip-meta">
                {person.registrationCode ?? "not registered yet"}
                {person.category ? `, wants ${lodgingCategoryLabels[person.category]}` : ""}
                {person.category && person.roomCount > 0 && person.kind === "ATTENDEE" ? `, ${person.roomCount} ${person.roomCount === 1 ? "room" : "rooms"}` : ""}
                {person.bringsExtraBedding ? ", bringing extra bedding" : ""}
                {person.asksForLodging ? "" : ", not asking for lodging"}
                {person.wantedFirstNight && person.wantedLastNight && person.wantedFirstNight !== nights[0] ? `, ${range(person.wantedFirstNight, person.wantedLastNight)}` : ""}
                {!person.active ? ", registration not active" : ""}
                {person.waitlistStatus ? ", on the lodging waitlist" : ""}
                {person.groundFloorNeeded || person.accessibleRoomNeeded ? ", needs ground floor" : ""}
                {person.placements.length > 0 ? `; in ${person.placements.map((placement) => `${placement.label} (${range(placement.firstNight, placement.lastNight)})`).join(", ")}` : ""}
                {person.uncoveredNights > 0 && person.placements.length > 0 ? `; ${person.uncoveredNights} night(s) not placed` : ""}
                {householdIsSplit(person) ? "; warning: household split across rooms" : ""}
              </span>
            </button>
          </li>)}
        </ul>
        <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          void run(() => callLodging(`${base}/assignments/placeholders`, "POST", { action: "create", displayName: String(data.get("name")), headcount: Number(data.get("headcount")) || 1, note: String(data.get("note") ?? "") }), "Expected guest added.").then((ok) => { if (ok) form.reset(); });
        }}>
          <fieldset><legend>Add an expected guest</legend>
            <label>Name <input name="name" required maxLength={120} /></label>
            <label>People it stands for <input type="number" name="headcount" min={1} max={500} defaultValue={1} /></label>
            <label>Note <input name="note" maxLength={300} /></label>
            <span className="field-hint">Staff or pastors not registered yet, or a club. No medical details.</span>
            <button type="submit" className="secondary-button" disabled={busy}>Add</button>
          </fieldset>
        </form>
      </section>

      <div className="lodging-assign-main">
        <section className="panel" aria-labelledby="la-elsewhere">
          <h3 id="la-elsewhere">Housing arranged elsewhere</h3>
          <p className="field-hint">These count as placed but use no rooms or sites here.</p>
          <div className="lodging-assign-buckets">{view.buckets.map((bucket) => <article key={bucket.id} className="lodging-assign-room" aria-label={bucket.label}
            onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDrop(event, { kind: "BUCKET", bucketId: bucket.id, label: bucket.label })}>
            <header><h4>{bucket.label}</h4><span className="lodging-assign-status">{bucket.people} placed</span></header>
            <ul className="lodging-assign-occupants">{bucket.occupants.map((occupant) => renderChip(occupant, bucket.label))}</ul>
            <div className="lodging-assign-actions">
              {selectedPerson ? <button type="button" className="primary-button" disabled={busy} onClick={() => assignHere({ kind: "BUCKET", bucketId: bucket.id, label: bucket.label })}>{selected?.moveAssignmentId ? "Move" : "Assign"} {selectedPerson.name} to {bucket.label}</button> : null}
            </div>
            <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              void run(() => callLodging(`${base}/assignments/buckets`, "PATCH", { bucketId: bucket.id, label: String(new FormData(event.currentTarget).get("label")) }), "Renamed.");
            }}>
              <label>Rename <input name="label" defaultValue={bucket.label} required maxLength={60} /></label>
              <button type="submit" className="secondary-button" disabled={busy}>Save name</button>
            </form>
          </article>)}</div>
        </section>

        <section className="panel" aria-labelledby="la-board">
          <h3 id="la-board">Rooms</h3>
          <div className="lodging-assign-controls">
            <label>Building <select value={buildingKey} onChange={(event) => { setBuildingKey(event.target.value); setFloorLabel("all"); }}>{view.buildings.map((entry) => <option key={entry.key} value={entry.key}>{entry.name}</option>)}</select></label>
            <label>Floor <select value={floorLabel} onChange={(event) => setFloorLabel(event.target.value)}><option value="all">All floors</option>{floors.map((floor) => <option key={floor.label} value={floor.label}>{floor.label}</option>)}</select></label>
            <div role="group" aria-label="Layout">
              <label><input type="radio" name="la-layout" checked={layout === "list"} onChange={() => setLayout("list")} /> Room list</label>
              <label><input type="radio" name="la-layout" checked={layout === "hall"} onChange={() => setLayout("hall")} /> Hall layout</label>
            </div>
          </div>
          {floors.filter((floor) => floorLabel === "all" || floor.label === floorLabel).map((floor) => <section key={floor.label} aria-label={`${building?.name} ${floor.label}`}>
            <h4>{floor.label}</h4>
            {renderUnits(floor.units)}
          </section>)}
          {floors.length === 0 ? <p>This building has no rooms in service.</p> : null}
        </section>
      </div>
    </div> : null}

    {tab === "plan" ? <PlanPanel view={view} base={base} run={run} busy={busy} canExport={canExport} /> : null}
    {tab === "waitlist" ? <WaitlistPanel view={view} base={base} run={run} busy={busy} canConfigure={canConfigure} /> : null}
    {tab === "attention" ? <ExceptionsPanel view={view} base={base} run={run} busy={busy} /> : null}
    {tab === "reports" ? <ReportsPanel eventId={view.eventId} /> : null}
    {tab === "display" ? <DisplayPanel view={view} base={base} run={run} busy={busy} canConfigure={canConfigure} /> : null}
  </div>;
}
