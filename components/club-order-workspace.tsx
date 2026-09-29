"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Eye, History, PackageCheck, ShoppingCart } from "lucide-react";
import styles from "@/components/club-orders.module.css";
import { applyExtras, type OrderLine } from "@/modules/club-orders/domain";
import { ClubUniformSection, emptyUniformData, type ClubUniformData } from "@/components/club-uniform-section";
import type { AwardableNeed, OrderBatchSummary, UnmatchedNeed, WaitingNeed } from "@/modules/club-orders/repository";

export type ClubOrderWorkspaceData = {
  lines: OrderLine[];
  unmatched: UnmatchedNeed[];
  batches: OrderBatchSummary[];
  awardable: AwardableNeed[];
  waiting: WaitingNeed[];
  firstOrderAt: string | null;
};

type ApiResult = Partial<ClubOrderWorkspaceData> & {
  error?: string;
  message?: string;
  issues?: Array<{ message?: string }>;
  awarded?: number;
  fromStock?: number;
  marked?: number;
  created?: number;
  skipped?: number;
  removed?: number;
};

const ordersBase = (organizationId: string) => `/api/attendee/clubs/${encodeURIComponent(organizationId)}/orders`;

/** The same bulk limit the award routes accept. */
const BULK_LIMIT = 500;

/**
 * A top-level export link with the extras typed on screen (#487), as
 * `extra=<itemId>:<count>`: the server checks them with the same schema as
 * placing the order, so the file matches the screen exactly.
 */
export function orderExportHref(base: string, view: "adventsource" | "readable" | "picklist", lines: readonly OrderLine[]) {
  const params = new URLSearchParams({ view });
  if (view !== "picklist") {
    for (const line of lines) if (line.extra > 0) params.append("extra", `${line.item.itemId}:${line.extra}`);
  }
  return `${base}/csv?${params.toString()}`;
}

/**
 * Which "to order" CSV exports have something to download (#571 F-24). An
 * export with nothing in it is a headers-only file, so it is disabled instead.
 * The AdventSource file needs a line with a catalog number; the order list needs
 * a line to order; the pick list covers what is to order and what is ready to
 * hand out, so it stays available while anything is waiting to be handed out.
 */
export function orderExportAvailability(lines: readonly OrderLine[], readyToHandOutCount: number) {
  const ordering = lines.filter((line) => line.toOrder > 0);
  return {
    adventsource: ordering.some((line) => Boolean(line.item.catalogNumber)),
    readable: ordering.length > 0,
    picklist: ordering.length > 0 || readyToHandOutCount > 0,
  };
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "America/Chicago" });
}

/**
 * A club's order screen (#487, #497), one page for honors and uniforms: what's needed (with editable
 * extras, available stock, and what to order), placing the order, past
 * orders with "Mark received", handing out what's arrived or already in
 * stock, and — for honors completed before the club ordered here — marking
 * the ones already handed out. Only names and item names appear for people;
 * no other personal field is ever loaded. A registrar or Area Coordinator
 * gets `readOnly`: the same lists, no controls.
 */
export function ClubOrderWorkspace({
  organizationId,
  initial,
  initialUniforms = emptyUniformData,
  readOnly = false,
}: {
  organizationId: string;
  initial: ClubOrderWorkspaceData;
  initialUniforms?: ClubUniformData;
  readOnly?: boolean;
}) {
  const [data, setData] = useState(initial);
  const [uniforms, setUniforms] = useState(initialUniforms);
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [handedOut, setHandedOut] = useState<Set<string>>(new Set());
  const [beforeDate, setBeforeDate] = useState("");
  const [promptDismissed, setPromptDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const base = ordersBase(organizationId);
  const uniformsBase = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/uniforms`;

  const lines = useMemo(() => applyExtras(data.lines, extras), [data.lines, extras]);
  const exportAvailability = orderExportAvailability(lines, data.awardable.length);
  const nothingToOrderId = "club-order-nothing-to-order";
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
  // Only honors get the "completed before you started ordering" prompt: a uniform's
  // "already has one" is chosen when it's recorded (#497).
  const earlier = useMemo(() => data.waiting.filter((need) => need.sourceType === "HONOR" && need.beforeFirstOrder), [data.waiting]);
  const showPrompt = !readOnly && !promptDismissed && earlier.length > 0;

  async function refresh() {
    // Uniforms first: an editor's load drops departed members' needs before the order list is read.
    const uniformResponse = await fetch(uniformsBase, { cache: "no-store" });
    const response = await fetch(base, { cache: "no-store" });
    const result = await response.json().catch(() => ({})) as ApiResult;
    if (response.ok && result.lines && result.batches && result.awardable && result.unmatched && result.waiting) {
      setData({
        lines: result.lines, unmatched: result.unmatched, batches: result.batches, awardable: result.awardable,
        waiting: result.waiting, firstOrderAt: result.firstOrderAt ?? null,
      });
    }
    const uniformResult = await uniformResponse.json().catch(() => ({})) as Partial<ClubUniformData>;
    if (uniformResponse.ok && uniformResult.needs && uniformResult.catalog && uniformResult.members) {
      setUniforms({ catalog: uniformResult.catalog, members: uniformResult.members, needs: uniformResult.needs, issuedCount: uniformResult.issuedCount ?? 0 });
    }
  }

  async function post(url: string, body: unknown) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({})) as ApiResult;
    if (!response.ok) {
      throw new Error(
        result.error === "MFA_UNLOCK_REQUIRED"
          ? "Confirm it's you again: reload this page and enter your authenticator code."
          : result.message ?? result.issues?.[0]?.message ?? "That could not be saved.",
      );
    }
    return result;
  }

  async function act(run: () => Promise<string>) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      setNotice(await run());
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That could not be saved.");
      return false;
    } finally {
      await refresh().catch(() => undefined);
      setBusy(false);
    }
  }

  async function placeOrder() {
    const payload = Object.fromEntries(lines.filter((line) => line.extra > 0).map((line) => [line.item.itemId, line.extra]));
    if (await act(async () => { await post(base, { extras: payload }); return "Order placed."; })) setExtras({});
  }

  async function markAwarded() {
    const needIds = [...selected];
    if (needIds.length === 0) return;
    const ok = await act(async () => {
      const result = await post(`${base}/award`, { needIds });
      const fromStock = result.fromStock ?? 0;
      return `Marked ${result.awarded ?? 0} handed out${fromStock > 0 ? ` (${fromStock} from stock)` : ""}.`;
    });
    if (ok) setSelected(new Set());
  }

  async function markAlreadyHandedOut() {
    const needIds = [...handedOut];
    if (needIds.length === 0) return;
    const ok = await act(async () => {
      let marked = 0;
      for (let start = 0; start < needIds.length; start += BULK_LIMIT) {
        const result = await post(`${base}/already-awarded`, { needIds: needIds.slice(start, start + BULK_LIMIT) });
        marked += result.marked ?? 0;
      }
      return `Marked ${marked} as already handed out. Stock wasn't changed.`;
    });
    if (ok) setHandedOut(new Set());
  }

  async function recordUniforms(input: { personIds: string[]; itemIds: string[]; alreadyHasOne: boolean }) {
    return act(async () => {
      const result = await post(uniformsBase, input);
      const created = result.created ?? 0;
      const skipped = result.skipped ?? 0;
      const marked = result.marked ?? 0;
      const what = input.alreadyHasOne
        ? `Recorded ${created} as already issued${marked > 0 ? ` and marked ${marked} existing ${marked === 1 ? "need" : "needs"} as issued` : ""}. Stock wasn't changed.`
        : `Recorded ${created} uniform ${created === 1 ? "need" : "needs"}.`;
      return skipped > 0 ? `${what} ${skipped} already on file, so ${skipped === 1 ? "it was" : "they were"} skipped.` : what;
    });
  }

  async function removeUniforms(needIds: string[]) {
    return act(async () => {
      let removed = 0;
      for (let start = 0; start < needIds.length; start += BULK_LIMIT) {
        removed += (await post(`${uniformsBase}/remove`, { needIds: needIds.slice(start, start + BULK_LIMIT) })).removed ?? 0;
      }
      return `Removed ${removed} uniform ${removed === 1 ? "need" : "needs"}.`;
    });
  }

  async function uniformsAlreadyHaveOne(needIds: string[]) {
    return act(async () => {
      let marked = 0;
      for (let start = 0; start < needIds.length; start += BULK_LIMIT) {
        marked += (await post(`${base}/already-awarded`, { needIds: needIds.slice(start, start + BULK_LIMIT) })).marked ?? 0;
      }
      return `Marked ${marked} as already issued. Stock wasn't changed.`;
    });
  }

  function toggleIn(setter: typeof setSelected, ids: string[], on: boolean) {
    setter((current) => {
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
  const earlierIds = earlier.map((need) => need.needId);
  const beforeDateIds = beforeDate ? earlier.filter((need) => need.sourceDate && need.sourceDate < beforeDate).map((need) => need.needId) : [];

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="public-registration-eyebrow">Club supplies</p>
          <h2>Club orders</h2>
        </div>
        <span className="count-badge">{lines.length} to review</span>
      </div>
      {readOnly ? (
        <p className="inline-notice" role="status"><Eye aria-hidden="true" size={14} /> View only. Shows what&apos;s on file. The club director or deputy places orders.</p>
      ) : (
        <p className="field-help">Completed honors, uniform needs, and earned awards that haven&apos;t been ordered yet. Add extras for spares, then place one order for everything.</p>
      )}
      {notice && <p className="inline-notice success" role="status">{notice}</p>}
      {error && <p className="inline-notice error" role="alert">{error}</p>}

      {showPrompt && (
        <section aria-labelledby="club-order-earlier" className={`${styles.block} ${styles.prompt}`}>
          <h3 id="club-order-earlier"><History aria-hidden="true" size={14} /> Honors completed before you started ordering here</h3>
          <p className={styles.promptCopy}>Mark the ones already handed out. Nothing is marked for you, and stock isn&apos;t changed.</p>
          <div className={styles.actions}>
            <button className="secondary-button" disabled={busy} onClick={() => toggleIn(setHandedOut, earlierIds, true)} type="button">Select all ({earlierIds.length})</button>
            <span className={styles.dateSelect}>
              <label htmlFor="club-order-before-date">Completed before</label>
              <input className={styles.date} id="club-order-before-date" onChange={(event) => setBeforeDate(event.target.value)} type="date" value={beforeDate} />
              <button className="secondary-button" disabled={busy || beforeDateIds.length === 0} onClick={() => toggleIn(setHandedOut, beforeDateIds, true)} type="button">
                Select {beforeDate ? `(${beforeDateIds.length})` : ""}
              </button>
            </span>
          </div>
          <ul className={styles.people}>
            {earlier.map((need) => (
              <li key={need.needId}>
                <label className={styles.check}>
                  <input checked={handedOut.has(need.needId)} onChange={(event) => toggleIn(setHandedOut, [need.needId], event.target.checked)} type="checkbox" />
                  <span>
                    <span translate="no">{need.firstName} {need.lastName}</span>
                    {" · "}<span translate="no">{need.itemName ?? need.sourceLabel}</span>
                    {need.sourceDate && <small className={styles.muted}> · {need.sourceDate}</small>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <button className="primary-button" disabled={busy || handedOut.size === 0} onClick={markAlreadyHandedOut} type="button">
              <CheckCircle2 aria-hidden="true" size={16} /> Already handed out{handedOut.size > 0 ? ` (${handedOut.size})` : ""}
            </button>
            <button className="text-button" onClick={() => setPromptDismissed(true)} type="button">Not now</button>
          </div>
        </section>
      )}

      <section className={styles.block}>
        <h3>To order</h3>
        {unmatchedCount > 0 && (
          <p className={styles.flag} role="status">
            <AlertTriangle aria-hidden="true" size={14} /> {unmatchedCount} completed {unmatchedCount === 1 ? "honor has" : "honors have"} no matching catalog item, so {unmatchedCount === 1 ? "it isn't" : "they aren't"} on this list. Conference staff can link the honor in the supply catalog.
          </p>
        )}
        {lines.length === 0 ? (
          <p className="quiet-copy">Nothing to order. New completed honors appear here on their own; record uniform needs below, and add earned awards on the Earned awards page.</p>
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
        {lines.length > 0 && (
          <p className="field-help">In stock counts only what isn&apos;t already set aside for someone. Needs it covers are ready to hand out below.</p>
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
          {exportAvailability.adventsource ? (
            <a className="secondary-button" href={orderExportHref(base, "adventsource", lines)}><Download aria-hidden="true" size={14} /> AdventSource file</a>
          ) : (
            <button aria-describedby={nothingToOrderId} className="secondary-button" disabled type="button"><Download aria-hidden="true" size={14} /> AdventSource file</button>
          )}
          {exportAvailability.readable ? (
            <a className="secondary-button" href={orderExportHref(base, "readable", lines)}><Download aria-hidden="true" size={14} /> Order list</a>
          ) : (
            <button aria-describedby={nothingToOrderId} className="secondary-button" disabled type="button"><Download aria-hidden="true" size={14} /> Order list</button>
          )}
          {exportAvailability.picklist ? (
            <a className="secondary-button" href={orderExportHref(base, "picklist", lines)}><Download aria-hidden="true" size={14} /> Pick list (to order and ready)</a>
          ) : (
            <button aria-describedby={nothingToOrderId} className="secondary-button" disabled type="button"><Download aria-hidden="true" size={14} /> Pick list (to order and ready)</button>
          )}
        </div>
        {!(exportAvailability.adventsource && exportAvailability.readable && exportAvailability.picklist) && (
          <p className="field-help" id={nothingToOrderId}>
            {exportAvailability.readable ? "No item has an AdventSource number yet, so there is nothing for the AdventSource file." : "Nothing to order yet."}
          </p>
        )}
      </section>

      <section className={styles.block}>
        <h3>Orders placed</h3>
        {data.batches.length === 0 ? (
          <p className="quiet-copy">No orders placed yet.</p>
        ) : (
          <ul className={styles.list}>
            {data.batches.map((batch) => {
              const batchQuery = `batch=${encodeURIComponent(batch.id)}`;
              return (
                <li className={styles.row} key={batch.id}>
                  <span className={styles.text}>
                    <strong>{formatDate(batch.createdAt)}</strong>
                    <small>{batch.itemCount} {batch.itemCount === 1 ? "item" : "items"} · {batch.totalQuantity} ordered · {batch.status === "RECEIVED" ? "Received" : "Waiting to arrive"}</small>
                  </span>
                  <span className={styles.actions}>
                    <a className="secondary-button" href={`${base}/csv?view=adventsource&${batchQuery}`}><Download aria-hidden="true" size={14} /> AdventSource file</a>
                    <a className="secondary-button" href={`${base}/csv?view=readable&${batchQuery}`}><Download aria-hidden="true" size={14} /> Order list</a>
                    <a className="secondary-button" href={`${base}/csv?view=picklist&${batchQuery}`}><Download aria-hidden="true" size={14} /> Pick list</a>
                    {!readOnly && batch.status === "ORDERED" && (
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => act(async () => { await post(`${base}/${encodeURIComponent(batch.id)}/receive`, {}); return "Order marked received."; })}
                        type="button"
                      >
                        <PackageCheck aria-hidden="true" size={14} /> Mark received
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={styles.block}>
        <h3>Ready to hand out</h3>
        {awardGroups.length === 0 ? (
          <p className="quiet-copy">Nothing has arrived yet, and nothing needed is in stock.</p>
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
                      <button className="text-button" onClick={() => toggleIn(setSelected, ids, !allOn)} type="button">{allOn ? "Clear all" : "Select all"}</button>
                    )}
                  </div>
                  <ul className={styles.people}>
                    {group.needs.map((need) => {
                      const name = <span translate="no">{need.firstName} {need.lastName}</span>;
                      const note = need.fromStock ? <small className={styles.muted}> · from stock</small> : null;
                      return (
                        <li key={need.needId}>
                          {readOnly ? (
                            <span>{name}{note}</span>
                          ) : (
                            <label className={styles.check}>
                              <input checked={selected.has(need.needId)} onChange={(event) => toggleIn(setSelected, [need.needId], event.target.checked)} type="checkbox" />
                              <span>{name}{note}</span>
                            </label>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
            {!readOnly && (
              <div className={styles.actions}>
                <button className="primary-button" disabled={busy || selected.size === 0} onClick={markAwarded} type="button">
                  <CheckCircle2 aria-hidden="true" size={16} /> Mark handed out{selected.size > 0 ? ` (${selected.size})` : ""}
                </button>
              </div>
            )}
          </>
        )}
      </section>
      <ClubUniformSection
        busy={busy}
        data={uniforms}
        onAlreadyHasOne={uniformsAlreadyHaveOne}
        onRecord={recordUniforms}
        onRemove={removeUniforms}
        readOnly={readOnly}
      />
    </section>
  );
}
