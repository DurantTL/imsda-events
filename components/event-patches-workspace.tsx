"use client";

import { useState } from "react";
import { AlertTriangle, Link2, Unlink } from "lucide-react";
import styles from "@/components/club-supplies.module.css";
import { clubSupplySectionLabels, type ClubSupplySection } from "@/modules/club-supplies/domain";
import type { EventAwardItemRow } from "@/modules/earned-awards/event-items";

type Payload = { linked: EventAwardItemRow[]; choices: EventAwardItemRow[]; isClubEvent: boolean };
type ApiResult = Partial<Payload> & { message?: string; issues?: Array<{ message?: string }> };

/**
 * Staff page for an event's patch or pin (#532): link catalog items to a club
 * event so club directors are *suggested* them for every member who attended.
 * Linking orders nothing. Camporee patches are conference-made and may have no
 * AdventSource number; they link the same and are flagged on the order screen.
 */
export function EventPatchesWorkspace({ eventId, eventName, initial }: { eventId: string; eventName: string; initial: Payload }) {
  const [data, setData] = useState(initial);
  const [itemId, setItemId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `/api/events/${encodeURIComponent(eventId)}/award-items`;

  async function call(url: string, method: "POST" | "DELETE", body: unknown, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const result = await response.json().catch(() => ({})) as ApiResult;
      if (!response.ok || !result.linked || !result.choices) throw new Error(result.message ?? result.issues?.[0]?.message ?? "That could not be saved.");
      setData({ linked: result.linked, choices: result.choices, isClubEvent: result.isClubEvent ?? data.isClubEvent });
      setNotice(success);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const linkedIds = new Set(data.linked.map((item) => item.itemId));
  const available = data.choices.filter((item) => !linkedIds.has(item.itemId));
  const sections = [...new Set(available.map((item) => item.section))];

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Club ministries</p>
          <h2>Event patches</h2>
          <p>
            Link the patch or pin for <span translate="no">{eventName}</span>. Club directors are then suggested it for every
            member who attended, and confirm before anything is ordered.
          </p>
        </div>
      </div>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      {!data.isClubEvent && (
        <p className="inline-notice" role="status">This isn&apos;t a club event, so patches can&apos;t be linked to it.</p>
      )}

      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">Link</p><h2>Add a patch or pin</h2></div></div>
        <div className={styles.filters}>
          <label htmlFor="event-patch-item">
            Catalog item
            <select disabled={!data.isClubEvent} id="event-patch-item" onChange={(event) => setItemId(event.target.value)} value={itemId}>
              <option value="">Choose an item</option>
              {sections.map((section) => (
                <optgroup key={section} label={clubSupplySectionLabels[section as ClubSupplySection]}>
                  {available.filter((item) => item.section === section).map((item) => (
                    <option key={item.itemId} value={item.itemId}>{item.name}{item.catalogNumber ? "" : " (no AdventSource number)"}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
        <div className={styles.actions}>
          <button
            className="primary-button"
            disabled={busy || !itemId || !data.isClubEvent}
            onClick={async () => { if (await call(base, "POST", { itemId }, "Linked. Directors will see it as a suggestion for attendees.")) setItemId(""); }}
            type="button"
          >
            <Link2 aria-hidden="true" size={16} /> Link to this event
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">Linked</p><h2>Patches and pins for this event ({data.linked.length})</h2></div></div>
        {data.linked.length === 0 ? (
          <p className="quiet-copy">Nothing is linked yet.</p>
        ) : (
          <ul className={styles.itemList}>
            {data.linked.map((item) => (
              <li className={styles.itemRow} key={item.itemId}>
                <span className={styles.itemText}>
                  <strong translate="no">{item.name}</strong>
                  <small>
                    {clubSupplySectionLabels[item.section as ClubSupplySection]}
                    {" · "}
                    {item.catalogNumber ? <>No. <code>{item.catalogNumber}</code></> : (
                      <span><AlertTriangle aria-hidden="true" size={12} /> No AdventSource number (conference-made)</span>
                    )}
                  </small>
                </span>
                <span className={styles.itemControls}>
                  <button className="secondary-button" disabled={busy} onClick={() => call(`${base}/${encodeURIComponent(item.itemId)}`, "DELETE", null, "Unlinked. Items clubs already added stay on their order lists.")} type="button">
                    <Unlink aria-hidden="true" size={14} /> Unlink
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
