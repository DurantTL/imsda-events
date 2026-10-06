"use client";

import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { PermissionDecision, PermissionStatus } from "@/modules/club-teams/permission-domain";
import type { TeamPermissionRow } from "@/modules/club-teams/permission-repository";

const statusText: Record<PermissionStatus, string> = { PENDING: "Waiting for a decision", GRANTED: "Permission granted", DECLINED: "Declined" };

/**
 * Team members who are 18 or older on the age date and need the Area Coordinator's permission (#809). Pending ones come
 * first and are called out; the Area Coordinator (on their own page) and staff who manage registrations can grant or
 * decline. A declined person has to become a coach or leave the team, which the director sees on their team page.
 */
export function TeamPermissionPanel({ rows: initial, endpointBase, canDecide, showEvent = false }: {
  rows: TeamPermissionRow[];
  /** The route that records a decision; the request id is added to it. */
  endpointBase: string;
  canDecide: boolean;
  showEvent?: boolean;
}) {
  const [rows, setRows] = useState(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = rows.filter((row) => row.status === "PENDING").length;

  async function decide(row: TeamPermissionRow, decision: PermissionDecision) {
    setBusyId(row.id);
    setError(null);
    try {
      const response = await fetch(`${endpointBase}/${encodeURIComponent(row.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
      const body = await response.json().catch(() => ({})) as { permission?: TeamPermissionRow; message?: string };
      if (!response.ok || !body.permission) {
        setError(body.message ?? "That decision couldn't be saved.");
        return;
      }
      const saved = body.permission;
      setRows((current) => current.map((entry) => (entry.id === saved.id ? saved : entry)));
    } catch {
      setError("We couldn't reach the server. Nothing was changed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="public-manage-card team-permission-panel" aria-labelledby="team-permission-heading">
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Area Coordinator permission</p>
        <h2 id="team-permission-heading"><ShieldAlert size={20} aria-hidden="true" /> Team members 18 and over</h2>
      </div>
      {rows.length === 0 ? (
        <p className="field-help">No team has a team member of 18 or older.</p>
      ) : (
        <>
          {pending > 0 && <p className="inline-notice warning" role="status"><strong>{pending} {pending === 1 ? "person is" : "people are"} waiting for permission.</strong> The teams are registered either way.</p>}
          <ul className="team-permission-list">
            {rows.map((row) => (
              <li className={`team-permission-item team-permission-${row.status.toLowerCase()}`} key={row.id}>
                <div>
                  <strong translate="no">{row.name}</strong> is {row.age}
                  {" · "}<span translate="no">{row.teamLabel}</span>
                  {showEvent && <> · <span translate="no">{row.eventName}</span></>}
                  {row.locationName && <> · <span translate="no">{row.locationName}</span></>}
                  <p className="field-help">
                    {statusText[row.status]}
                    {row.decidedBy && row.decidedAt ? ` by ${row.decidedBy}` : ""}
                  </p>
                </div>
                {canDecide && (
                  <div className="team-permission-actions">
                    <button className="secondary-button" disabled={busyId === row.id || row.status === "GRANTED"} onClick={() => void decide(row, "GRANTED")} type="button">Grant</button>
                    <button className="secondary-button" disabled={busyId === row.id || row.status === "DECLINED"} onClick={() => void decide(row, "DECLINED")} type="button">Decline</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="inline-notice error" role="alert">{error}</p>}
    </section>
  );
}
