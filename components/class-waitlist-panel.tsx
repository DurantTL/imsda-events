"use client";

import { useMemo, useState } from "react";
import { ListPlus } from "lucide-react";
import { classRequirementGaps, unavailableReason } from "@/modules/honors/class-picker-view";
import type { ClassSelectionWorkspace } from "@/modules/honors/enrollment-repository";

type Workspace = ClassSelectionWorkspace;
type Offering = Workspace["offerings"][number];
type Attendee = Workspace["attendees"][number];
type Waitlist = NonNullable<Workspace["waitlist"]>;

function formatDeadline(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso));
}

/**
 * Honors Weekend class waitlists on the director's class page (#831): seats
 * offered to youth (accept or decline), the places the club holds, and a form to
 * put a youth on a full class's waitlist. A waitlist spot uses no seat and
 * doesn't count toward the club's limit. These screens only guide; the server
 * checks every rule, in the same transaction that takes seats.
 */
export function ClassWaitlistPanel({
  canOverrideRequirements,
  endpoint,
  onWorkspace,
  workspace,
}: {
  canOverrideRequirements: boolean;
  /** The class waitlist route of this club and event, without a trailing slash. */
  endpoint: string;
  onWorkspace: (workspace: Workspace) => void;
  workspace: Workspace;
}) {
  const waitlist: Waitlist | null = workspace.waitlist;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attendeeId, setAttendeeId] = useState("");
  const [offeringId, setOffering] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");

  const offeringById = useMemo(() => new Map(workspace.offerings.map((offering) => [offering.id, offering])), [workspace.offerings]);
  const attendeeById = useMemo(() => new Map(workspace.attendees.map((attendee) => [attendee.id, attendee])), [workspace.attendees]);
  const entries = useMemo(() => waitlist?.entries ?? [], [waitlist]);

  const attendee = attendeeById.get(attendeeId) ?? null;
  const fullClasses = useMemo(
    () => workspace.offerings.filter((offering) => offering.isActive && offering.seatsTaken >= offering.capacity),
    [workspace.offerings],
  );
  // Full classes this youth could wait for: not already held or listed, and meeting every rule the director can't confirm.
  const choices = useMemo(() => {
    if (!attendee || !attendee.consumesSeat) return [];
    const held = new Set(workspace.selections[attendee.id] ?? []);
    const listed = new Set(entries.filter((entry) => entry.attendeeId === attendee.id).map((entry) => entry.offeringId));
    return fullClasses.filter((offering) => {
      if (held.has(offering.id) || listed.has(offering.id)) return false;
      const reasonBlocked = unavailableReason({ ...offering, seatsTaken: 0, clubSeatsTaken: 0 }, false, attendee, { canOverride: canOverrideRequirements, canConfirm: true });
      return !reasonBlocked;
    });
  }, [attendee, fullClasses, workspace.selections, entries, canOverrideRequirements]);
  const chosen: Offering | null = choices.find((offering) => offering.id === offeringId) ?? null;
  const gaps = chosen && attendee ? classRequirementGaps(chosen, attendee) : [];
  const needsConfirmation = gaps.some((gap) => gap.confirmable);
  const needsOverride = gaps.some((gap) => !gap.confirmable);

  async function call(url: string, init: RequestInit, done: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, init);
      const result = await response.json().catch(() => ({})) as { workspace?: Workspace; message?: string };
      if (!response.ok || !result.workspace) throw new Error(result.message ?? "That could not be saved.");
      onWorkspace(result.workspace);
      setNotice(done);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    if (!attendee || !chosen) return;
    const ok = await call(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attendeeId: attendee.id,
        offeringId: chosen.id,
        ...(needsConfirmation && confirmed ? { confirmed: true } : {}),
        ...(needsOverride && reason.trim() ? { overrideReason: reason.trim() } : {}),
      }),
    }, `${attendee.firstName} is on the waitlist for ${chosen.honorName}. No seat is used until one is offered and you accept it.`);
    if (ok) {
      setOffering("");
      setConfirmed(false);
      setReason("");
    }
  }

  if (!waitlist) return null;
  const canJoin = workspace.open && waitlist.open && fullClasses.length > 0 && workspace.attendees.some((person) => person.consumesSeat);
  if (entries.length === 0 && !canJoin) return null;

  const label = (entryAttendeeId: string, entryOfferingId: string) => {
    const person = attendeeById.get(entryAttendeeId);
    const offering = offeringById.get(entryOfferingId);
    return {
      name: person ? `${person.firstName} ${person.lastName}`.trim() : "A youth",
      className: offering?.honorName ?? "a class",
      sessionName: offering?.sessionName ?? null,
    };
  };

  return (
    <div className="class-waitlist" role="region" aria-label="Class waitlists">
      <h3>Class waitlists</h3>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      {entries.length > 0 && (
        <ul className="class-waitlist-entries">
          {entries.map((entry) => {
            const { name, className, sessionName } = label(entry.attendeeId, entry.offeringId);
            const where = sessionName ? `${className} (${sessionName})` : className;
            const offered = entry.status === "OFFERED" && !entry.expired;
            return (
              <li key={entry.id}>
                {offered ? (
                  <p>
                    <strong translate="no">{name}</strong>: a seat in <strong translate="no">{where}</strong> is being held for them.
                    {entry.offerExpiresAt ? ` Accept it by ${formatDeadline(entry.offerExpiresAt, waitlist.timezone)}, or it goes to the next youth in line.` : ""}
                  </p>
                ) : entry.status === "OFFERED" ? (
                  <p>
                    <strong translate="no">{name}</strong>: the time to accept a seat in <strong translate="no">{where}</strong> ran out. It is passing to the next youth in line.
                  </p>
                ) : (
                  <p>
                    <strong translate="no">{name}</strong> is waiting for <strong translate="no">{where}</strong>, number {entry.place} in line.
                  </p>
                )}
                {entry.note && <p className="field-help">{entry.note}</p>}
                <div className="class-waitlist-actions">
                  {offered && (
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={() => call(`${endpoint}/${encodeURIComponent(entry.id)}/accept`, { method: "POST" }, `${name} has a seat in ${className}.`)}
                      type="button"
                    >
                      Accept the seat
                    </button>
                  )}
                  {!(entry.status === "OFFERED" && entry.expired) && (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => call(`${endpoint}/${encodeURIComponent(entry.id)}`, { method: "DELETE" }, offered ? "The seat was declined and goes to the next youth in line." : `${name} is off the waitlist.`)}
                      type="button"
                    >
                      {offered ? "Decline the seat" : "Leave the waitlist"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {canJoin && (
        <fieldset className="class-waitlist-join" disabled={busy}>
          <legend>Join a full class&apos;s waitlist</legend>
          <p className="field-help">
            When a seat opens, the next youth in line is offered it and you have {waitlist.offerHours} hour{waitlist.offerHours === 1 ? "" : "s"} to accept. A place on the waitlist uses no seat and doesn&apos;t count toward your club&apos;s limit.
          </p>
          <label>
            Youth
            <select onChange={(event) => { setAttendeeId(event.target.value); setOffering(""); setConfirmed(false); setReason(""); }} value={attendeeId}>
              <option value="">Choose a youth</option>
              {workspace.attendees.filter((person) => person.consumesSeat).map((person: Attendee) => (
                <option key={person.id} value={person.id}>{person.lastName}, {person.firstName}</option>
              ))}
            </select>
          </label>
          <label>
            Full class
            <select disabled={!attendee} onChange={(event) => { setOffering(event.target.value); setConfirmed(false); setReason(""); }} value={offeringId}>
              <option value="">{attendee && choices.length === 0 ? "No full class to wait for" : "Choose a class"}</option>
              {choices.map((offering) => (
                <option key={offering.id} value={offering.id}>{offering.honorName}{offering.sessionName ? ` (${offering.sessionName})` : ""}</option>
              ))}
            </select>
          </label>
          {chosen && needsConfirmation && (
            <label className="checkbox-row">
              <input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
              <span>{gaps.filter((gap) => gap.confirmable).map((gap) => gap.message).join(" ")} I confirm they meet it.</span>
            </label>
          )}
          {chosen && needsOverride && (
            canOverrideRequirements ? (
              <label>
                Reason for placing them anyway
                <input maxLength={300} onChange={(event) => setReason(event.target.value)} type="text" value={reason} />
              </label>
            ) : null
          )}
          <button
            className="secondary-button"
            disabled={busy || !chosen || (needsConfirmation && !confirmed) || (needsOverride && reason.trim().length < 3)}
            onClick={join}
            type="button"
          >
            <ListPlus aria-hidden="true" size={16} /> Join the waitlist
          </button>
        </fieldset>
      )}
    </div>
  );
}
