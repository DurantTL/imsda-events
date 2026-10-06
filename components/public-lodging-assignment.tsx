"use client";

import { useState, type FormEvent } from "react";
import { AlertCircle, BedDouble, CheckCircle2 } from "lucide-react";
import { lodgingCategoryLabels, type LodgingCategory } from "@/modules/lodging/domain";
import type { RegistrantAssignmentView } from "@/modules/lodging/assignment-view";
import type { RegistrantLodgingView } from "@/modules/lodging/preferences-service";
import type { RegistrantWaitlistView } from "@/modules/lodging/waitlist-service";

const shortNight = (night: string) => new Date(`${night}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const nightRange = (first: string, last: string) => (first === last ? shortNight(first) : `${shortNight(first)} to ${shortNight(last)}`);

type Status = { kind: "idle" | "saving" | "saved" | "error"; message: string };

/**
 * Lodging on the private registration page, after staff publish it (#200): the approved building, room, nights and
 * instructions for each person on this registration, roommates by first name only when staff turned that on, and the
 * lodging waitlist (join when a type is full, accept or decline a live offer). Never an email, phone, address or last
 * name of anyone else. The server decides everything; nothing here prices or charges anything.
 */
export function PublicLodgingAssignment({ token, initialAssignments, initialWaitlist, lodging }: {
  token: string;
  initialAssignments: RegistrantAssignmentView;
  initialWaitlist: RegistrantWaitlistView;
  lodging: RegistrantLodgingView | null;
}) {
  const [assignments, setAssignments] = useState(initialAssignments);
  const [waitlist, setWaitlist] = useState(initialWaitlist);
  const [status, setStatus] = useState<Status>({ kind: "idle", message: "" });
  const base = `/api/public/manage/${encodeURIComponent(token)}/lodging/waitlist`;

  async function send(body: unknown, success: string) {
    setStatus({ kind: "saving", message: "Saving..." });
    try {
      const response = await fetch(base, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null) as { message?: string; waitlist?: RegistrantWaitlistView; assignments?: RegistrantAssignmentView } | null;
      if (!response.ok || !payload?.waitlist) throw new Error(payload?.message ?? "That could not be saved. Try again.");
      setWaitlist(payload.waitlist);
      if (payload.assignments) setAssignments(payload.assignments);
      setStatus({ kind: "saved", message: success });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "That could not be saved. Try again." });
    }
  }

  const entry = waitlist.entry;
  const openEntry = entry && ["JOINED", "OFFERED", "ACCEPTED"].includes(entry.status);
  const fullCategories = lodging?.offered.filter((offered) => offered.full) ?? [];
  const canJoin = waitlist.enabled && lodging?.enabled && lodging.canEdit && !openEntry && fullCategories.length > 0;

  if (!assignments.published && !entry && !canJoin) return null;

  return <section className="public-manage-card" aria-labelledby="lodging-assignment-title">
    <h2 id="lodging-assignment-title"><BedDouble size={18} aria-hidden="true" /> Your lodging</h2>
    {assignments.published ? (assignments.stays.length === 0
      ? <p>Your room has not been assigned yet. The event team will place everyone before the event.</p>
      : <>
        <ul>{assignments.stays.map((stay, index) => <li key={`${stay.name}-${stay.firstNight}-${index}`}>
          <strong>{stay.name}</strong>: {stay.kind === "ROOM" ? `${stay.building ? `${stay.building}, ` : ""}${stay.room}` : `${stay.room} (arranged outside the property)`}, {nightRange(stay.firstNight, stay.lastNight)}.
          {stay.roommates.length > 0 ? ` Staying in the same room: ${stay.roommates.join(", ")}${stay.otherGuests > 0 ? ` and ${stay.otherGuests} other${stay.otherGuests === 1 ? "" : "s"}` : ""}.` : ""}
        </li>)}</ul>
        {assignments.instructions ? <p>{assignments.instructions}</p> : null}
        <p className="field-hint">Rooms can change. This page always shows the latest. Contact the event team if something looks wrong.</p>
      </>) : null}

    {entry ? <div>
      <h3>Lodging waitlist</h3>
      {entry.status === "JOINED" ? <p>You are on the lodging waitlist for {lodgingCategoryLabels[entry.category]} ({entry.partySize} {entry.partySize === 1 ? "person" : "people"}{entry.roomCount > 1 ? `, ${entry.roomCount} rooms` : ""}). The event team will contact you if a place opens. Nothing is charged by being on the list.</p> : null}
      {entry.status === "OFFERED" && !entry.lapsed ? <div role="status">
        <p><strong>A place may be available in {lodgingCategoryLabels[entry.category]} for {entry.partySize} {entry.partySize === 1 ? "person" : "people"}{entry.roomCount > 1 ? ` in ${entry.roomCount} rooms` : ""}.</strong> {entry.offerExpiresAt ? `Please answer by ${new Date(entry.offerExpiresAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}.` : ""} Accepting does not charge anything by itself; the event team confirms your room.</p>
        <button type="button" className="primary-button" disabled={status.kind === "saving"} onClick={() => void send({ action: "accept" }, "Thank you. The event team will confirm your room.")}>Accept the place</button>
        <button type="button" className="secondary-button" disabled={status.kind === "saving"} onClick={() => void send({ action: "decline" }, "Thank you. We have recorded that you do not need the place.")}>Decline</button>
      </div> : null}
      {(entry.status === "EXPIRED" || (entry.status === "OFFERED" && entry.lapsed)) ? <p>The offer has expired. Contact the event team if you still need a place.</p> : null}
      {entry.status === "ACCEPTED" ? <p>You accepted the place. The event team will confirm your room.</p> : null}
      {entry.status === "DECLINED" ? <p>You declined the offered place.</p> : null}
      {entry.status === "PROMOTED" ? <p>You have a place. Your room is shown above once the event team publishes it.</p> : null}
      {entry.status === "REMOVED" ? <p>You are no longer on the lodging waitlist. Contact the event team with any question.</p> : null}
    </div> : null}

    {canJoin && lodging ? <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const request = lodging.request;
      void send({
        action: "join", category: String(form.get("category")) as LodgingCategory,
        firstNight: request?.firstNight ?? null, lastNight: request?.lastNight ?? null,
        partySize: request?.partySize ?? Math.max(1, lodging.people.length),
      }, "You are on the lodging waitlist.");
    }}>
      <h3>Join the lodging waitlist</h3>
      <p>These types are full. Join the waitlist and the event team will contact you if a place opens. Nothing is charged by joining.</p>
      <label>Lodging type <select name="category">{fullCategories.map((offered) => <option key={offered.category} value={offered.category}>{offered.label}</option>)}</select></label>
      <button type="submit" className="secondary-button" disabled={status.kind === "saving"}>Join the waitlist</button>
    </form> : null}

    <p role={status.kind === "error" ? "alert" : "status"} aria-live="polite">
      {status.kind === "saved" && <CheckCircle2 size={16} aria-hidden="true" />}
      {status.kind === "error" && <AlertCircle size={16} aria-hidden="true" />}
      {status.message}
    </p>
  </section>;
}
