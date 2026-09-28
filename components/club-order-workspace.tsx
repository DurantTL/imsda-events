"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Eye, PackageCheck, ShoppingCart } from "lucide-react";
import styles from "@/components/club-orders.module.css";
import type { OrderLine } from "@/modules/club-orders/domain";
import type { AwardableNeed, OrderBatchSummary, UnmatchedNeed } from "@/modules/club-orders/repository";

export type ClubOrderWorkspaceData = {
  lines: OrderLine[];
  unmatched: UnmatchedNeed[];
  batches: OrderBatchSummary[];
  awardable: AwardableNeed[];
};

type ApiResult = Partial<ClubOrderWorkspaceData> & { error?: string; message?: string; issues?: Array<{ message?: string }>; awarded?: number };

const csvBase = (organizationId: string) => `/api/attendee/clubs/${encodeURIComponent(organizationId)}/orders`;

/**
 * A club's honor order screen (#487), one page: what's needed (with editable
 * extras, stock, and what to order), placing the order, past orders with
 * "Mark received", and marking received items awarded in bulk. Only names and
 * item names appear for people; no other personal field is ever loaded. A
 * registrar or Area Coordinator gets `readOnly`: the same lists, no controls.
 */
export function ClubOrderWorkspace({
  organizationId,
  initial,
  readOnly = false,
}: {
  organizationId: string;
  initial: ClubOrderWorkspaceData;
  readOnly?: boolean;
}) {
  const [data, setData] = useState(initial);
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const base = csvBase(organizationId);

  const lines = useMemo(() => data.lines.map((line) => {
    const raw = extras[line.item.itemId];
    const extra = raw === undefined ? 0 : Math.max(0, Math.trunc(Number(raw)) || 0);
    return { ...line, extra, toOrder: Math.max(0, line.needed + extra - line.inStock) };
  }), [data.lines, extras]);
  const totalToOrder = lines.reduce((sum, line) => sum + line.toOrder, 0);
  const awardGroups = useMemo(() => {
    const groups = new Map<string, { itemName: string; needs: AwardableNeed[] }>();
    for (const need of data.awardable) {
      const group = groups.get(need.itemId) ?? { itemName: need.itemName, needs: [] };
      group.needs.push(need);
      groups.set(need.itemId, group);
    }
    return [...groups.entries()];
  }, [data.awardable]);

  async function refresh() {
    const response = await fetch(base, { cache: "no-store" });
    const result = await response.json().catch(() => ({})) as ApiResult;
    if (response.ok && result.lines && result.batches && result.awardable && result.unmatched) {
      setData({ lines: result.lines, unmatched: result.unmatched, batches: result.batches, awardable: result.awardable });
    }
  }

  async function act(url: string, body: unknown, success: (result: ApiResult) => string) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({})) as ApiResult;
      if (!response.ok) {
        throw new Error(
          result.error === "MFA_UNLOCK_REQUIRED"
            ? "Confirm it's you again: reload this page and enter your authenticator code."
            : result.message ?? result.issues?.[0]?.message ?? "That could not be saved.",
        );
      }
      setNotice(success(result));
      await refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function placeOrder() {
    const payload = Object.fromEntries(lines.filter((line) => line.extra > 0).map((line) => [line.item.itemId, line.extra]));
    if (await act(base, { extras: payload }, () => "Order placed.")) setExtras({});
  }

  async function markAwarded() {
    const needIds = [...selected];
    if (needIds.length === 0) return;
    if (await act(`${base}/award`, { needIds }, (result) => `Marked ${result.awarded ?? 0} awarded.`)) setSelected(new Set());
  }

  function toggle(ids: string[], on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  const unmatchedCount = data.unmatched.length;
  const missingNumberLines = lines.filter((line) => line.missingCatalogNumber);

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="public-registration-eyebrow">Club supplies</p>
          <h2>Honor orders</h2>
        </div>
        <span className="count-badge">{lines.length} to review</span>
      </div>
      {readOnly ? (
        <p className="inline-notice" role="status"><Eye aria-hidden="true" size={14} /> View only. The club director or deputy places orders.</p>
      ) : (
        <p className="field-help">Completed honors that haven&apos;t been ordered yet. Add extras for spares, then place the order.</p>
      )}
      {notice && <p className="inline-notice success" role="status">{notice}</p>}
      {error && <p className="inline-notice error" role="alert">{error}</p>}

      <section className={styles.block}>
        <h3>To order</h3>
        {unmatchedCount > 0 && (
          <p className={styles.flag} role="status">
            <AlertTriangle aria-hidden="true" size={14} /> {unmatchedCount} completed {unmatchedCount === 1 ? "honor has" : "honors have"} no matching catalog item, so {unmatchedCount === 1 ? "it isn't" : "they aren't"} on this list. Conference staff can link the honor in the supply catalog.
          </p>
        )}
        {lines.length === 0 ? (
          <p className="quiet-copy">Nothing to order. New completed honors appear here on their own.</p>
        ) : (
          <ul className={styles.list}>
            {lines.map((line) => {
              const inputId = `club-order-extra-${line.item.itemId}`;
              return (
                <li className={styles.row} key={line.item.itemId}>
                  <span className={styles.text}>
                    <strong translate="no">{line.item.name}</strong>
                    <small>
                      {line.item.catalogNumber ? <>No. <code>{line.item.catalogNumber}</code></> : (
                        <span className={styles.flagInline}><AlertTriangle aria-hidden="true" size={12} /> No AdventSource number</span>
                      )}
                    </small>
                  </span>
                  <dl className={styles.numbers}>
                    <div><dt>Needed</dt><dd>{line.needed}</dd></div>
                    <div>
                      <dt>Extras</dt>
                      <dd>
                        {readOnly ? line.extra : (
                          <>
                            <label className="sr-only" htmlFor={inputId}>Extras: {line.item.name}</label>
                            <input
                              className={styles.number}
                              id={inputId}
                              inputMode="numeric"
                              min={0}
                              onChange={(event) => setExtras((current) => ({ ...current, [line.item.itemId]: event.target.value }))}
                              type="number"
                              value={extras[line.item.itemId] ?? "0"}
                            />
                          </>
                        )}
                      </dd>
                    </div>
                    <div><dt>In stock</dt><dd>{line.inStock}</dd></div>
                    <div><dt>To order</dt><dd><strong>{line.toOrder}</strong></dd></div>
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
        {missingNumberLines.length > 0 && (
          <p className={styles.flag} role="status">
            <AlertTriangle aria-hidden="true" size={14} /> {missingNumberLines.length} {missingNumberLines.length === 1 ? "item has" : "items have"} no AdventSource number and {missingNumberLines.length === 1 ? "is" : "are"} left out of the AdventSource file. Order {missingNumberLines.length === 1 ? "it" : "them"} another way.
          </p>
        )}
        <div className={styles.actions}>
          {!readOnly && (
            <button className="primary-button" disabled={busy || lines.length === 0 || totalToOrder === 0} onClick={placeOrder} type="button">
              <ShoppingCart aria-hidden="true" size={16} /> {busy ? "Working…" : "Place order"}
            </button>
          )}
          <a className="secondary-button" href={`${base}/csv?view=adventsource`}><Download aria-hidden="true" size={14} /> AdventSource file</a>
          <a className="secondary-button" href={`${base}/csv?view=readable`}><Download aria-hidden="true" size={14} /> Order list</a>
          <a className="secondary-button" href={`${base}/csv?view=picklist`}><Download aria-hidden="true" size={14} /> Pick list</a>
        </div>
      </section>

      <section className={styles.block}>
        <h3>Orders placed</h3>
        {data.batches.length === 0 ? (
          <p className="quiet-copy">No orders placed yet.</p>
        ) : (
          <ul className={styles.list}>
            {data.batches.map((batch) => (
              <li className={styles.row} key={batch.id}>
                <span className={styles.text}>
                  <strong>{new Date(batch.createdAt).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "America/Chicago" })}</strong>
                  <small>{batch.itemCount} {batch.itemCount === 1 ? "item" : "items"} · {batch.totalQuantity} in all · {batch.status === "RECEIVED" ? "Received" : "Waiting to arrive"}</small>
                </span>
                <span className={styles.actions}>
                  <a className="secondary-button" href={`${base}/csv?view=adventsource&batch=${encodeURIComponent(batch.id)}`}><Download aria-hidden="true" size={14} /> AdventSource file</a>
                  <a className="secondary-button" href={`${base}/csv?view=picklist&batch=${encodeURIComponent(batch.id)}`}><Download aria-hidden="true" size={14} /> Pick list</a>
                  {!readOnly && batch.status === "ORDERED" && (
                    <button className="secondary-button" disabled={busy} onClick={() => act(`${base}/${encodeURIComponent(batch.id)}/receive`, {}, () => "Order marked received.")} type="button">
                      <PackageCheck aria-hidden="true" size={14} /> Mark received
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.block}>
        <h3>Ready to hand out</h3>
        {awardGroups.length === 0 ? (
          <p className="quiet-copy">Nothing has arrived yet.</p>
        ) : (
          <>
            {awardGroups.map(([itemId, group]) => {
              const ids = group.needs.map((need) => need.needId);
              const allOn = ids.every((id) => selected.has(id));
              return (
                <div className={styles.group} key={itemId}>
                  <div className={styles.groupHead}>
                    <strong translate="no">{group.itemName}</strong>
                    {!readOnly && (
                      <button className="text-button" onClick={() => toggle(ids, !allOn)} type="button">{allOn ? "Clear all" : "Select all"}</button>
                    )}
                  </div>
                  <ul className={styles.people}>
                    {group.needs.map((need) => (
                      <li key={need.needId}>
                        {readOnly ? (
                          <span translate="no">{need.firstName} {need.lastName}</span>
                        ) : (
                          <label className={styles.check}>
                            <input checked={selected.has(need.needId)} onChange={(event) => toggle([need.needId], event.target.checked)} type="checkbox" />
                            <span translate="no">{need.firstName} {need.lastName}</span>
                          </label>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {!readOnly && (
              <div className={styles.actions}>
                <button className="primary-button" disabled={busy || selected.size === 0} onClick={markAwarded} type="button">
                  <CheckCircle2 aria-hidden="true" size={16} /> Mark awarded{selected.size > 0 ? ` (${selected.size})` : ""}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </section>
  );
}
