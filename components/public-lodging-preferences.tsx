"use client";

import { useMemo, useState, type FormEvent } from "react";
import { AlertCircle, BedDouble, CheckCircle2 } from "lucide-react";
import { beddingNote, extraBeddingNote, heldRoomsFor, partyExceedsBeds } from "@/modules/lodging/preferences-domain";
import { describeRate, quoteStay, stayNights, addDays, type LodgingCategory } from "@/modules/lodging/domain";
import type { RegistrantLodgingView } from "@/modules/lodging/preferences-service";

type Status = { kind: "idle" | "saving" | "saved" | "error"; message: string };

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type Sent = { lodging: RegistrantLodgingView; changeRequested: boolean };

async function send(url: string, method: string, body: unknown): Promise<Sent> {
  const response = await fetch(url, { method, cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null) as { message?: string; lodging?: RegistrantLodgingView; result?: { changeRequested?: boolean } } | null;
  if (!response.ok || !payload?.lodging) throw new Error(payload?.message ?? "That could not be saved. Try again.");
  return { lodging: payload.lodging, changeRequested: payload.result?.changeRequested === true };
}

/**
 * Lodging on the private registration page (#199): choose a type, nights, and who stays together until the event's
 * deadline, and ask to room with someone. The price shown comes from the event's lodging rates; nothing is charged
 * here and no room is assigned. Accessibility is two yes/no boxes: no medical detail is collected.
 */
export function PublicLodgingPreferences({ token, initialView }: { token: string; initialView: RegistrantLodgingView }) {
  const [view, setView] = useState(initialView);
  const [status, setStatus] = useState<Status>({ kind: "idle", message: "" });
  const [category, setCategory] = useState<LodgingCategory | "">(initialView.request?.category ?? "");
  const [firstNight, setFirstNight] = useState(initialView.request?.firstNight ?? initialView.nights[0] ?? "");
  const [lastNight, setLastNight] = useState(initialView.request?.lastNight ?? initialView.nights[initialView.nights.length - 1] ?? "");
  const [partySize, setPartySize] = useState(initialView.request?.partySize ?? Math.max(1, initialView.people.length));
  const [roomCount, setRoomCount] = useState(initialView.request?.roomCount ?? 1);
  const [bringsExtraBedding, setBringsExtraBedding] = useState(initialView.request?.bringsExtraBedding ?? false);
  const base = `/api/public/manage/${encodeURIComponent(token)}/lodging`;
  const disabled = !view.canEdit || status.kind === "saving";

  const nightCount = lastNight >= firstNight && firstNight ? stayNights(firstNight, addDays(lastNight, 1)).length : 0;
  // "How many rooms?" (#803): asked for a room-type category only, from 1 up to the party and the rooms free.
  const chosenOffer = view.offered.find((entry) => entry.category === category);
  const roomBased = chosenOffer?.roomBased === true;
  // For the type already saved, the rooms already held are always allowed (an overbooked type may show fewer free), so an
  // edit that is not about rooms never lowers them.
  const heldRooms = heldRoomsFor(view.request, category, partySize);
  const highestRooms = Math.max(1, heldRooms, Math.min(partySize, chosenOffer?.roomsFree ?? partySize));
  const rooms = roomBased ? Math.min(Math.max(1, roomCount), highestRooms) : 1;
  const extraBeddingNeeded = roomBased && partyExceedsBeds({ roomBased: true, unitCapacity: chosenOffer?.unitCapacity ?? null, ...(chosenOffer?.roomBeds ? { roomBeds: chosenOffer.roomBeds } : {}) }, partySize, rooms, nightCount > 0 ? stayNights(firstNight, addDays(lastNight, 1)) : []);
  const bedding = chosenOffer ? beddingNote(chosenOffer.linens) : null;
  const quote = useMemo(() => {
    const chosen = view.offered.find((entry) => entry.category === category);
    if (!chosen || nightCount < 1) return null;
    return quoteStay({ rates: chosen.rate ? { [chosen.category]: chosen.rate } : {}, category: chosen.category, nights: nightCount, partySize, units: chosen.roomBased ? rooms : 1 });
  }, [view.offered, category, nightCount, partySize, rooms]);

  async function run(action: () => Promise<Sent>, success: string) {
    setStatus({ kind: "saving", message: "Saving…" });
    try {
      const sent = await action();
      setView(sent.lodging);
      setStatus({ kind: "saved", message: sent.changeRequested ? "Thank you. This change needs the event team, so it was sent to them and has not been applied yet." : success });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "That could not be saved. Try again." });
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const wholeEvent = firstNight === view.nights[0] && lastNight === view.nights[view.nights.length - 1];
    void run(() => send(base, "PUT", {
      category: category === "" ? null : category,
      firstNight: wholeEvent ? null : firstNight,
      lastNight: wholeEvent ? null : lastNight,
      partySize,
      ...(roomBased ? { roomCount: rooms, ...(extraBeddingNeeded ? { bringsExtraBedding } : {}) } : {}),
      privateRoomRequested: form.get("privateRoomRequested") === "on",
      householdPreference: form.get("householdPreference"),
      // After the first save these go through the event team, so a locked form does not send them.
      ...(view.flagsLocked ? {} : { groundFloorNeeded: form.get("groundFloorNeeded") === "on", accessibleRoomNeeded: form.get("accessibleRoomNeeded") === "on" }),
    }), "Saved. You can change this until the deadline.");
  }

  const request = view.request;
  return (
    <section className="public-manage-card" aria-labelledby="public_manage_lodging_title">
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Where you would like to stay</p>
        <h2 id="public_manage_lodging_title">Lodging</h2>
        <p>
          Tell us what you would like. This is a request, not a reservation: the event team assigns rooms and sites later.
          {view.canEdit ? ` You can change it through ${view.deadline}.` : view.closedReason === "DEADLINE_PASSED" ? ` Changes closed after ${view.deadline}. Contact the event team to change it.` : view.closedReason === "VERIFICATION_REQUIRED" ? " This event verifies every change. To change this, contact the event team." : ""}
          {view.changeRequested ? " A change you asked for is waiting for the event team." : ""}
        </p>
      </div>
      <form onSubmit={save}>
        <fieldset disabled={disabled}>
          <legend>Lodging type</legend>
          <label><input type="radio" name="category" checked={category === ""} onChange={() => setCategory("")} /> No preference</label>
          {view.offered.map((option) => {
            const selected = category === option.category;
            return (
              <label key={option.category}>
                <input type="radio" name="category" checked={selected} disabled={option.full && !selected} onChange={() => setCategory(option.category)} />
                {" "}{option.label}{option.full ? " — Full" : ""}
                {option.rate ? ` — ${describeRate(option.rate)}` : " — included"}
              </label>
            );
          })}
          {view.offered.some((option) => option.full) && view.fullBehavior === "WAITLIST" ? <p>A waitlist for full types will open later.</p> : null}
        </fieldset>

        <fieldset disabled={disabled}>
          <legend>Nights</legend>
          <label>First night
            <select value={firstNight} onChange={(event) => setFirstNight(event.target.value)}>{view.nights.map((night) => <option key={night} value={night}>{night}</option>)}</select>
          </label>
          <label>Last night
            <select value={lastNight} onChange={(event) => setLastNight(event.target.value)}>{view.nights.map((night) => <option key={night} value={night}>{night}</option>)}</select>
          </label>
          {nightCount < 1 ? <p role="alert">The last night cannot be before the first night.</p> : <p>{nightCount} night{nightCount === 1 ? "" : "s"}.</p>}
        </fieldset>

        <fieldset disabled={disabled}>
          <legend>Who is staying</legend>
          <label>People in this lodging
            <select value={partySize} onChange={(event) => setPartySize(Number(event.target.value))}>
              {Array.from({ length: Math.max(1, view.people.length) }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}
            </select>
          </label>
          {bedding ? <p data-testid="lodging-bedding">{bedding}</p> : null}
          {roomBased ? (
            <label>How many rooms?
              <select value={rooms} onChange={(event) => setRoomCount(Number(event.target.value))} data-testid="lodging-room-count">
                {Array.from({ length: highestRooms }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}
              </select>
            </label>
          ) : null}
          {extraBeddingNeeded ? (
            <p role="note" data-testid="lodging-extra-bedding">
              {extraBeddingNote}{" "}
              <label><input type="checkbox" checked={bringsExtraBedding} onChange={(event) => setBringsExtraBedding(event.target.checked)} /> We will bring sleeping bags or air mattresses</label>
            </p>
          ) : null}
          <label>Everyone on this registration
            <select name="householdPreference" defaultValue={request?.householdPreference ?? "TOGETHER"}>
              <option value="TOGETHER">stays together</option>
              <option value="FLEXIBLE">can be placed in more than one room</option>
            </select>
          </label>
          <label><input type="checkbox" name="privateRoomRequested" defaultChecked={request?.privateRoomRequested ?? false} /> I would like a private room if one is available</label>
        </fieldset>

        <fieldset disabled={disabled || view.flagsLocked}>
          <legend>Accessibility</legend>
          <label><input type="checkbox" name="groundFloorNeeded" defaultChecked={request?.groundFloorNeeded ?? false} /> A ground floor is needed</label>
          <label><input type="checkbox" name="accessibleRoomNeeded" defaultChecked={request?.accessibleRoomNeeded ?? false} /> An accessible room is needed</label>
          {view.flagsLocked ? <p>To change these after saving, contact the event team.</p> : null}
          <p>These are yes or no only. Please do not enter medical details here; if the event team needs to know more, they will ask you privately.</p>
        </fieldset>

        {quote ? <p role="status">
          {quote.kind === "INCLUDED" ? "Lodging for this choice is included in your registration." : null}
          {quote.kind === "CHARGE" ? `Estimated lodging: ${money(quote.totalCents)} for ${quote.nights} night${quote.nights === 1 ? "" : "s"}. This is part of your registration total.` : null}
          {quote.kind === "BELOW_MINIMUM_NIGHTS" ? `This type needs at least ${quote.minimumNights} nights.` : null}
        </p> : null}

        {view.canEdit && view.pricedChangeNeedsStaff && view.offered.some((option) => option.rate) ? <p>Your lodging charge was set when you registered. A change that alters it is sent to the event team instead of applying at once; nothing is charged or refunded automatically.</p> : null}
        {view.canEdit ? <button className="primary-button" type="submit" disabled={disabled || nightCount < 1}><BedDouble size={18} aria-hidden="true" /> Save lodging</button> : null}
        {request ? <p>Saved version {request.version}{view.earlierVersions > 0 ? `, ${view.earlierVersions} earlier version${view.earlierVersions === 1 ? "" : "s"} kept by the event team` : ""}.</p> : null}
      </form>

      <Roommates token={token} view={view} base={base} run={run} disabled={disabled} />

      <p role={status.kind === "error" ? "alert" : "status"} aria-live="polite">
        {status.kind === "saved" && <CheckCircle2 size={16} aria-hidden="true" />}
        {status.kind === "error" && <AlertCircle size={16} aria-hidden="true" />}
        {status.message}
      </p>
    </section>
  );
}

function Roommates({ view, base, run, disabled }: {
  token: string;
  view: RegistrantLodgingView;
  base: string;
  run: (action: () => Promise<Sent>, success: string) => Promise<void>;
  disabled: boolean;
}) {
  return (
    <div>
      <h3>Rooming with someone</h3>
      <p>Ask to room with another registration using their name and confirmation code. It counts as a match only when they ask for you too, or the event team approves it. We never show anyone else&apos;s contact details.</p>
      {view.roommates.length > 0 ? <ul>{view.roommates.map((row) => <li key={row.id}>
        {row.who}: {row.status === "MATCHED" ? "matched" : row.status === "WAITING" ? "waiting for them to ask for you too" : "not matched"}{" "}
        {view.canEdit ? <button type="button" disabled={disabled} onClick={() => void run(() => send(`${base}/roommates`, "POST", { action: "withdraw", requestId: row.id }), "Request withdrawn.")}>Withdraw</button> : null}
      </li>)}</ul> : null}
      {view.canEdit ? <>
        <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const fromPersonId = String(form.get("fromPersonId") ?? "");
          void run(() => send(`${base}/roommates`, "POST", {
            action: "add_by_code",
            name: form.get("name"),
            confirmationCode: form.get("confirmationCode"),
            ...(fromPersonId ? { fromPersonId } : {}),
          }), "Request sent. It stays private until they ask for you too.");
        }}>
          <label>Their full name <input name="name" required maxLength={120} autoComplete="off" /></label>
          <label>Their confirmation code <input name="confirmationCode" required maxLength={40} autoComplete="off" /></label>
          {view.people.length > 1 ? <label>Who on your registration is asking
            <select name="fromPersonId" defaultValue=""><option value="">Everyone</option>{view.people.map((person) => <option key={person.personId} value={person.personId}>{person.name}</option>)}</select>
          </label> : null}
          <button type="submit" disabled={disabled}>Ask to room together</button>
        </form>
        {view.people.length > 1 ? <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void run(() => send(`${base}/roommates`, "POST", { action: "add_in_registration", fromPersonId: form.get("fromPersonId"), targetPersonId: form.get("targetPersonId") }), "Added.");
        }}>
          <label>Room together: <select name="fromPersonId">{view.people.map((person) => <option key={person.personId} value={person.personId}>{person.name}</option>)}</select></label>
          <label>and <select name="targetPersonId" defaultValue={view.people[1]?.personId}>{view.people.map((person) => <option key={person.personId} value={person.personId}>{person.name}</option>)}</select></label>
          <button type="submit" disabled={disabled}>Add (people on my registration)</button>
        </form> : null}
      </> : null}
    </div>
  );
}
