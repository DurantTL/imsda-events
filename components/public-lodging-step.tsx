"use client";

import { useState } from "react";
import { describeRate, lodgingCategoryLabels } from "@/modules/lodging/domain";
import { beddingNote, extraBeddingNote } from "@/modules/lodging/preferences-domain";
import {
  categoryIsFull,
  chosenNights,
  clampedRoomCount,
  lodgingStepLine,
  roomQuestion,
  type LodgingChoice,
  type LodgingStepOffer,
} from "@/modules/lodging/form-step";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The lodging step of the registration form (#199). It is a step like the form's others: its answers travel with the
 * submission, the server checks them again under the unit locks, and the price joins the registration total. Types that
 * are full for the chosen nights are shown as Full and cannot be picked. Accessibility is two yes/no boxes: please do
 * not enter medical detail here.
 */
export function PublicLodgingStep({ offer, choice, attendees, issues, ignoreFull = false, onChange }: {
  offer: LodgingStepOffer;
  choice: LodgingChoice;
  attendees: ReadonlyArray<{ clientId: string; name: string }>;
  issues: ReadonlyArray<{ message: string }>;
  /** The registration is joining the waitlist: a full type can still be named, as an unpriced request. */
  ignoreFull?: boolean;
  onChange: (next: LodgingChoice) => void;
}) {
  const nights = chosenNights(choice);
  const line = lodgingStepLine(offer, choice);
  // A change of type, nights or party keeps the room count within what is allowed, and the extra-bedding box only
  // stays ticked while the note applies.
  const set = (patch: Partial<LodgingChoice>) => {
    const next = { ...choice, ...patch };
    const rooms = clampedRoomCount(offer, next);
    const question = roomQuestion(offer, { ...next, roomCount: rooms }, ignoreFull);
    onChange({ ...next, roomCount: rooms, bringsExtraBedding: question.extraBeddingNeeded ? next.bringsExtraBedding : false });
  };
  const rooms = roomQuestion(offer, choice, ignoreFull);
  // Nearly every room is bring-your-own-bedding: a general note for any chosen type unless every unit of it provides linens.
  const chosenEntry = choice.category === "" ? undefined : offer.categories.find((option) => option.category === choice.category);
  const bedding = chosenEntry ? beddingNote(chosenEntry.linens) : null;
  const maxParty = Math.max(1, attendees.length);
  return (
    <div className="public-registration-lodging" data-testid="lodging-step">
      {issues.length > 0 ? <div role="alert" className="public-registration-field-error">{issues.map((issue) => <p key={issue.message}>{issue.message}</p>)}</div> : null}
      <fieldset>
        <legend>Lodging type</legend>
        <label>
          <input type="radio" name="lodging_category" checked={choice.category === ""} onChange={() => set({ category: "" })} /> No preference
        </label>
        {offer.categories.map((option) => {
          const full = !ignoreFull && categoryIsFull(offer, option.category, nights.length > 0 ? nights : offer.nights, choice.partySize);
          return (
            <label key={option.category}>
              <input type="radio" name="lodging_category" checked={choice.category === option.category} disabled={full && choice.category !== option.category} onChange={() => set({ category: option.category })} />
              {" "}{lodgingCategoryLabels[option.category]}{full ? " — Full" : ""}
              {option.rate ? ` — ${describeRate(option.rate)}` : " — included"}
            </label>
          );
        })}
        {ignoreFull ? <p>This registration is joining the waitlist. Your lodging choice is saved with it; the event team will confirm it if a place opens, and nothing is charged for lodging now.</p> : null}
        {offer.fullBehavior === "WAITLIST" && offer.categories.some((option) => categoryIsFull(offer, option.category, offer.nights, choice.partySize)) ? <p>A waitlist for full types will open later.</p> : null}
      </fieldset>

      <fieldset>
        <legend>Nights</legend>
        <label>First night
          <select value={choice.firstNight} onChange={(event) => set({ firstNight: event.target.value })}>{offer.nights.map((night) => <option key={night} value={night}>{night}</option>)}</select>
        </label>
        <label>Last night
          <select value={choice.lastNight} onChange={(event) => set({ lastNight: event.target.value })}>{offer.nights.map((night) => <option key={night} value={night}>{night}</option>)}</select>
        </label>
        <p>{nights.length === 0 ? "The last night cannot be before the first night." : `${nights.length} night${nights.length === 1 ? "" : "s"}.`}</p>
      </fieldset>

      <fieldset>
        <legend>Who is staying</legend>
        <label>People in this lodging
          <select value={choice.partySize} onChange={(event) => set({ partySize: Number(event.target.value) })}>
            {Array.from({ length: maxParty }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        {bedding ? <p data-testid="lodging-bedding">{bedding}</p> : null}
        {rooms.asked ? (
          <label>How many rooms?
            <select value={choice.roomCount} onChange={(event) => set({ roomCount: Number(event.target.value) })} data-testid="lodging-room-count">
              {Array.from({ length: rooms.highest }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}
            </select>
          </label>
        ) : null}
        {rooms.asked && rooms.extraBeddingNeeded ? (
          <p role="note" data-testid="lodging-extra-bedding">
            {extraBeddingNote}{" "}
            <label><input type="checkbox" checked={choice.bringsExtraBedding} onChange={(event) => set({ bringsExtraBedding: event.target.checked })} /> We will bring sleeping bags or air mattresses</label>
          </p>
        ) : null}
        <label>Everyone on this registration
          <select value={choice.householdPreference} onChange={(event) => set({ householdPreference: event.target.value as LodgingChoice["householdPreference"] })}>
            <option value="TOGETHER">stays together</option>
            <option value="FLEXIBLE">can be placed in more than one room</option>
          </select>
        </label>
        <label><input type="checkbox" checked={choice.privateRoomRequested} onChange={(event) => set({ privateRoomRequested: event.target.checked })} /> I would like a private room if one is available</label>
      </fieldset>

      <fieldset>
        <legend>Accessibility</legend>
        <label><input type="checkbox" checked={choice.groundFloorNeeded} onChange={(event) => set({ groundFloorNeeded: event.target.checked })} /> A ground floor is needed</label>
        <label><input type="checkbox" checked={choice.accessibleRoomNeeded} onChange={(event) => set({ accessibleRoomNeeded: event.target.checked })} /> An accessible room is needed</label>
        <p>These are yes or no only. Please do not enter medical details; if the event team needs to know more, they will ask you privately. After you register, changing these goes through the event team.</p>
      </fieldset>

      <fieldset>
        <legend>Rooming with someone</legend>
        <p>Ask to room with another registration using their name and confirmation code. It counts as a match only when they ask for you too, or the event team approves it. We never show anyone else&apos;s contact details.</p>
        {choice.roommates.map((row, index) => (
          <div key={index}>
            <label>Their full name <input value={row.name} maxLength={120} autoComplete="off" onChange={(event) => set({ roommates: choice.roommates.map((entry, position) => (position === index ? { ...entry, name: event.target.value } : entry)) })} /></label>
            <label>Their confirmation code <input value={row.confirmationCode} maxLength={40} autoComplete="off" onChange={(event) => set({ roommates: choice.roommates.map((entry, position) => (position === index ? { ...entry, confirmationCode: event.target.value } : entry)) })} /></label>
            {attendees.length > 1 ? (
              <label>Who is asking
                <select value={row.fromClientId} onChange={(event) => set({ roommates: choice.roommates.map((entry, position) => (position === index ? { ...entry, fromClientId: event.target.value } : entry)) })}>
                  <option value="">Everyone</option>
                  {attendees.map((attendee) => <option key={attendee.clientId} value={attendee.clientId}>{attendee.name}</option>)}
                </select>
              </label>
            ) : null}
            <button type="button" onClick={() => set({ roommates: choice.roommates.filter((_, position) => position !== index) })}>Remove</button>
          </div>
        ))}
        {choice.roommates.length < 3 ? <button type="button" onClick={() => set({ roommates: [...choice.roommates, { name: "", confirmationCode: "", fromClientId: "" }] })}>Ask someone to room with me</button> : null}
        {attendees.length > 1 ? (
          <div>
            {choice.within.map((pair, index) => (
              <p key={index}>
                {attendees.find((attendee) => attendee.clientId === pair.fromClientId)?.name ?? "Someone"} and {attendees.find((attendee) => attendee.clientId === pair.targetClientId)?.name ?? "someone"} room together{" "}
                <button type="button" onClick={() => set({ within: choice.within.filter((_, position) => position !== index) })}>Remove</button>
              </p>
            ))}
            <WithinPicker attendees={attendees} onAdd={(pair) => set({ within: [...choice.within, pair] })} />
          </div>
        ) : null}
      </fieldset>

      <p role="status">
        {ignoreFull ? "Nothing is charged for lodging while this registration is on the waitlist." : line ? `Lodging: ${money(line.amountCents)} (${line.pricingLabel}). This is added to your registration total.` : choice.category === "" ? "No lodging type chosen." : "Lodging for this choice is included in your registration."}
      </p>
    </div>
  );
}


function WithinPicker({ attendees, onAdd }: { attendees: ReadonlyArray<{ clientId: string; name: string }>; onAdd: (pair: { fromClientId: string; targetClientId: string }) => void }) {
  const [from, setFrom] = useState(attendees[0]?.clientId ?? "");
  const [target, setTarget] = useState(attendees[1]?.clientId ?? "");
  return (
    <div>
      <label>Room together: <select value={from} onChange={(event) => setFrom(event.target.value)}>{attendees.map((attendee) => <option key={attendee.clientId} value={attendee.clientId}>{attendee.name}</option>)}</select></label>
      <label>and <select value={target} onChange={(event) => setTarget(event.target.value)}>{attendees.map((attendee) => <option key={attendee.clientId} value={attendee.clientId}>{attendee.name}</option>)}</select></label>
      <button type="button" disabled={!from || !target || from === target} onClick={() => onAdd({ fromClientId: from, targetClientId: target })}>Add (people on my registration)</button>
    </div>
  );
}
