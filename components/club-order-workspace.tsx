"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { AlertTriangle, CheckCircle2, Download, Eye, History, PackageCheck, Plus, Printer, RotateCcw, Save, Trash2 } from "lucide-react";
import styles from "@/components/club-orders.module.css";
import { ClubSupplyStockWorkspace } from "@/components/club-supply-stock-workspace";
import { ClubUniformSection, emptyUniformData, type ClubUniformData } from "@/components/club-uniform-section";
import { ORDER_LIST_SECTIONS, activeHelperLines, orderListSectionLabels, type HelperLine } from "@/modules/club-orders/domain";
import type { AwardableNeed, OrderBatchSummary, UnmatchedNeed, WaitingNeed } from "@/modules/club-orders/repository";
import type { ClubStockRow } from "@/modules/club-supplies/repository";

export type ClubOrderWorkspaceData = {
  helper: HelperLine[];
  /** Orders placed before the helper list (#654): only ones still waiting to arrive are shown, to mark received. */
  batches: OrderBatchSummary[];
  unmatched: UnmatchedNeed[];
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

export const ADVENTSOURCE_URL = "https://www.adventsource.org";

/** Most items the "add an item" picker lists at once. */
const PICKER_LIMIT = 100;

const promptDismissedKey = (organizationId: string) => `imsda:orders:earlier-honors-dismissed:${organizationId}`;

/** Fallback for this page view when storage is blocked. */
const dismissedInMemory = new Set<string>();

function readDismissed(organizationId: string) {
  if (dismissedInMemory.has(organizationId)) return true;
  try {
    return window.localStorage.getItem(promptDismissedKey(organizationId)) === "1";
  } catch {
    return false;
  }
}

const DISMISSED_EVENT = "imsda:orders-prompt-dismissed";

function subscribeDismissed(onChange: () => void) {
  window.addEventListener(DISMISSED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(DISMISSED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function writeDismissed(organizationId: string) {
  dismissedInMemory.add(organizationId);
  try {
    window.localStorage.setItem(promptDismissedKey(organizationId), "1");
  } catch {
    // Storage can be blocked; the prompt then returns next visit.
  }
  window.dispatchEvent(new Event(DISMISSED_EVENT));
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "America/Chicago" });
}

/**
 * A club's Orders screen (#487, #497, #654): a helper for building the list
 * of supplies to order from AdventSource. It is not an order form and places
 * nothing. The list has Uniforms, Honors and other supplies, each line with
 * item name, size, item number and a quantity the director can change, add or
 * remove; "to order" is needed less what the club has on hand (the Inventory
 * below). It exports to CSV and prints. Below the list: who is ready to hand
 * out, honors that may already be handed out, and the uniform entry. Only
 * names and item names appear for people; no other personal field is ever
 * loaded. A registrar or Area Coordinator gets `readOnly`: the same lists, no
 * controls.
 */
export function ClubOrderWorkspace({
  organizationId,
  initial,
  initialUniforms = emptyUniformData,
  stock = [],
  printHref,
  readOnly = false,
}: {
  organizationId: string;
  initial: ClubOrderWorkspaceData;
  initialUniforms?: ClubUniformData;
  /** The catalog with this club's quantities: the add-an-item picker and the Inventory. */
  stock?: ClubStockRow[];
  /** The printable page, when the viewer has one. */
  printHref?: string;
  readOnly?: boolean;
}) {
  const [data, setData] = useState(initial);
  const [uniforms, setUniforms] = useState(initialUniforms);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [handedOut, setHandedOut] = useState<Set<string>>(new Set());
  const [beforeDate, setBeforeDate] = useState("");
  // Remembered per club on this device. The server snapshot is "not dismissed", so the first render matches the server.
  const promptDismissed = useSyncExternalStore(subscribeDismissed, () => readDismissed(organizationId), () => false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerItem, setPickerItem] = useState("");
  const [pickerQuantity, setPickerQuantity] = useState("1");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const base = ordersBase(organizationId);
  const uniformsBase = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/uniforms`;

  const onList = useMemo(() => activeHelperLines(data.helper), [data.helper]);
  const takenOff = useMemo(() => data.helper.filter((line) => line.needed === 0 && line.edited && line.computedNeeded > 0), [data.helper]);
  const totalToOrder = onList.reduce((sum, line) => sum + line.toOrder, 0);
  const awardGroups = useMemo(() => {
    const groups = new Map<string, { itemName: string; needs: AwardableNeed[] }>();
    for (const need of data.awardable) {
      const group = groups.get(need.itemId) ?? { itemName: need.itemName, needs: [] };
      group.needs.push(need);
      groups.set(need.itemId, group);
    }
    return [...groups.entries()];
  }, [data.awardable]);
  const pickerItems = useMemo(() => {
    const text = pickerQuery.trim().toLowerCase();
    const listed = new Set(onList.map((line) => line.itemId));
    return stock
      .filter((row) => row.isActive && !listed.has(row.itemId) && (!text || `${row.name} ${row.catalogNumber ?? ""}`.toLowerCase().includes(text)))
      .slice(0, PICKER_LIMIT);
  }, [stock, pickerQuery, onList]);
  // Honors that may have been handed out long ago: the club marks them so they aren't counted as needed.
  const earlier = useMemo(() => data.waiting.filter((need) => need.sourceType === "HONOR" && need.beforeFirstOrder), [data.waiting]);
  // Shown only while the club hasn't edited the helper list or handed anything out here: a one-time cleanup, never in read-only mode.
  const showPrompt = !readOnly && !promptDismissed && earlier.length > 0 && !data.helper.some((line) => line.edited);
  const waitingBatches = data.batches.filter((batch) => batch.status === "ORDERED");

  function dismissPrompt() {
    writeDismissed(organizationId);
  }

  async function refresh() {
    // Uniforms first: an editor's load drops departed members' needs before the order list is read.
    const uniformResponse = await fetch(uniformsBase, { cache: "no-store" });
    const response = await fetch(base, { cache: "no-store" });
    const result = await response.json().catch(() => ({})) as ApiResult;
    if (response.ok && result.helper && result.batches && result.awardable && result.unmatched && result.waiting) {
      setData({ helper: result.helper, batches: result.batches, unmatched: result.unmatched, awardable: result.awardable, waiting: result.waiting, firstOrderAt: result.firstOrderAt ?? null });
    }
    const uniformResult = await uniformResponse.json().catch(() => ({})) as Partial<ClubUniformData>;
    if (uniformResponse.ok && uniformResult.needs && uniformResult.catalog && uniformResult.members) {
      setUniforms({ catalog: uniformResult.catalog, members: uniformResult.members, needs: uniformResult.needs, issuedCount: uniformResult.issuedCount ?? 0 });
    }
  }

  async function send(url: string, method: "POST" | "PUT", body: unknown) {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
  const post = (url: string, body: unknown) => send(url, "POST", body);

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

  /** Sets one line's quantity (0 takes it off the list), or `null` to put it back to the computed count. */
  function setQuantity(itemId: string, quantity: number | null, message: string) {
    return act(async () => {
      await send(`${base}/lines/${encodeURIComponent(itemId)}`, "PUT", { quantity });
      setDrafts((current) => {
        const next = { ...current };
        delete next[itemId];
        return next;
      });
      return message;
    });
  }

  function saveDraft(line: HelperLine) {
    const draft = drafts[line.itemId];
    if (draft === undefined) return;
    if (!/^\d+$/.test(draft.trim())) {
      setError("Enter a whole number, 0 or more.");
      return;
    }
    return setQuantity(line.itemId, Number(draft), "Quantity saved.");
  }

  function removeLine(line: HelperLine) {
    // A line nothing calls for was added by hand: forget it. Otherwise keep a 0 so it stays off the list.
    return setQuantity(line.itemId, line.computedNeeded > 0 ? 0 : null, `Took ${line.name} off the list.`);
  }

  async function addLine() {
    const quantity = Number(pickerQuantity);
    if (!pickerItem || !Number.isSafeInteger(quantity) || quantity < 1) {
      setError("Choose an item and a quantity of 1 or more.");
      return;
    }
    if (await setQuantity(pickerItem, quantity, "Added to the list.")) {
      setPickerItem("");
      setPickerQuantity("1");
    }
  }

  async function markAwarded() {
    const needIds = [...selected];
    if (needIds.length === 0) return;
    const ok = await act(async () => {
      const result = await post(`${base}/award`, { needIds });
      const fromStock = result.fromStock ?? 0;
      return `Marked ${result.awarded ?? 0} handed out${fromStock > 0 ? ` (${fromStock} from stock)` : ""}.`;
    });
    if (ok) {
      setSelected(new Set());
      dismissPrompt();
    }
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
    if (ok) {
      setHandedOut(new Set());
      dismissPrompt();
    }
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
  const earlierIds = earlier.map((need) => need.needId);
  const beforeDateIds = beforeDate ? earlier.filter((need) => need.sourceDate && need.sourceDate < beforeDate).map((need) => need.needId) : [];

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="public-registration-eyebrow">Club supplies</p>
          <h2>Orders</h2>
        </div>
        <span className="count-badge">{onList.length} {onList.length === 1 ? "line" : "lines"}</span>
      </div>
      <p className="inline-notice" id="club-order-helper-notice" role="note">
        This is a helper to build your list — it is <strong>not</strong> an official order form. You still need to order the items from{" "}
        <a href={ADVENTSOURCE_URL} rel="noopener noreferrer" target="_blank">AdventSource</a>.
      </p>
      {readOnly ? (
        <p className="inline-notice" role="status"><Eye aria-hidden="true" size={14} /> View only. Shows what&apos;s on file. The club director or deputy builds the list.</p>
      ) : (
        <p className={`field-help ${styles.helpText}`}>Completed honors, uniform needs, and earned awards that haven&apos;t been handed out appear here on their own. Change a quantity, add an item, or take one off. Stock on hand comes off what you need.</p>
      )}
      {notice && <p className="inline-notice success" role="status">{notice}</p>}
      {error && <p className="inline-notice error" role="alert">{error}</p>}

      {showPrompt && (
        <section aria-labelledby="club-order-earlier" className={`${styles.block} ${styles.prompt}`}>
          <h3 id="club-order-earlier"><History aria-hidden="true" size={14} /> Honors that may already be handed out</h3>
          <p className={styles.promptCopy}>Mark the ones already handed out so they come off the list. Nothing is marked for you, and stock isn&apos;t changed.</p>
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
            <button className="text-button" onClick={dismissPrompt} type="button">Not now</button>
          </div>
        </section>
      )}

      <section className={styles.block}>
        <h3>Your order list</h3>
        {unmatchedCount > 0 && (
          <p className={styles.flag} role="status">
            <AlertTriangle aria-hidden="true" size={14} /> {unmatchedCount} completed {unmatchedCount === 1 ? "honor has" : "honors have"} no matching catalog item, so {unmatchedCount === 1 ? "it isn't" : "they aren't"} on this list. Conference staff can link the honor in the supply catalog.
          </p>
        )}
        {onList.length === 0 ? (
          <p className="quiet-copy">Nothing on the list. New completed honors appear here on their own; record uniform needs below, add earned awards on the Class tracking page, or add an item yourself.</p>
        ) : (
          ORDER_LIST_SECTIONS.map((section) => {
            const lines = onList.filter((line) => line.section === section);
            if (lines.length === 0) return null;
            return (
              <div className={styles.group} key={section}>
                <div className={styles.groupHead}><strong>{orderListSectionLabels[section]}</strong></div>
                <ul className={styles.list}>
                  {lines.map((line) => {
                    const inputId = `club-order-quantity-${line.itemId}`;
                    const draft = drafts[line.itemId];
                    return (
                      <li className={styles.row} key={line.itemId}>
                        <span className={styles.text}>
                          <strong translate="no">{line.name}</strong>
                          <small>
                            {line.size && <>Size {line.size} · </>}
                            {line.catalogNumber ? <>Item no. <code>{line.catalogNumber}</code></> : (
                              <span className={styles.flagInline}><AlertTriangle aria-hidden="true" size={12} /> No item number</span>
                            )}
                            {line.edited && line.needed !== line.computedNeeded && <> · calculated: {line.computedNeeded}</>}
                          </small>
                        </span>
                        <dl className={styles.numbers}>
                          <div>
                            <dt>Quantity</dt>
                            <dd>
                              {readOnly ? line.needed : (
                                <>
                                  <label className="sr-only" htmlFor={inputId}>Quantity: {line.name}{line.size ? `, ${line.size}` : ""}</label>
                                  <input
                                    className={styles.number}
                                    id={inputId}
                                    inputMode="numeric"
                                    min={0}
                                    onChange={(event) => setDrafts((current) => ({ ...current, [line.itemId]: event.target.value }))}
                                    type="number"
                                    value={draft ?? String(line.needed)}
                                  />
                                </>
                              )}
                            </dd>
                          </div>
                          <div><dt>Available</dt><dd>{line.onHand}</dd></div>
                          <div><dt>To order</dt><dd><strong>{line.toOrder}</strong></dd></div>
                        </dl>
                        {!readOnly && (
                          <span className={styles.actions}>
                            <button
                              aria-label={`Save quantity: ${line.name}${line.size ? `, ${line.size}` : ""}`}
                              className="secondary-button"
                              disabled={busy || draft === undefined || draft === String(line.needed)}
                              onClick={() => void saveDraft(line)}
                              type="button"
                            >
                              <Save aria-hidden="true" size={14} /> Save
                            </button>
                            {line.edited && line.computedNeeded > 0 && (
                              <button
                                aria-label={`Reset to ${line.computedNeeded}: ${line.name}${line.size ? `, ${line.size}` : ""}`}
                                className="text-button"
                                disabled={busy}
                                onClick={() => void setQuantity(line.itemId, null, "Quantity reset.")}
                                type="button"
                              >
                                <RotateCcw aria-hidden="true" size={14} /> Reset
                              </button>
                            )}
                            <button
                              aria-label={`Remove from the list: ${line.name}${line.size ? `, ${line.size}` : ""}`}
                              className="text-button"
                              disabled={busy}
                              onClick={() => void removeLine(line)}
                              type="button"
                            >
                              <Trash2 aria-hidden="true" size={14} /> Remove
                            </button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })
        )}
        {onList.length > 0 && (
          <p className={`field-help ${styles.helpText}`}>To order is the quantity less what is available, never below zero. Available = in stock minus items set aside for someone. {totalToOrder} to order in all.</p>
        )}

        {takenOff.length > 0 && (
          <div className={styles.group}>
            <div className={styles.groupHead}><strong>Taken off the list</strong></div>
            <ul className={styles.people}>
              {takenOff.map((line) => (
                <li className={styles.rowStatic} key={line.itemId}>
                  <span translate="no">{line.name}{line.size ? ` (${line.size})` : ""}</span>
                  {!readOnly && (
                    <button className="text-button" disabled={busy} onClick={() => void setQuantity(line.itemId, null, "Put back on the list.")} type="button">Put back</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!readOnly && (
          <div className={styles.group}>
            <div className={styles.groupHead}><strong>Add an item</strong></div>
            <div className={styles.pickerRow}>
              <label className={styles.pickerField} htmlFor="club-order-picker-search">
                Search the catalog
                <input className={styles.select} id="club-order-picker-search" onChange={(event) => { setPickerQuery(event.target.value); setPickerItem(""); }} placeholder="Name or item number" type="search" value={pickerQuery} />
              </label>
              <label className={styles.pickerField} htmlFor="club-order-picker-item">
                Item
                <select className={styles.select} id="club-order-picker-item" onChange={(event) => setPickerItem(event.target.value)} value={pickerItem}>
                  <option value="">Choose an item</option>
                  {pickerItems.map((row) => (
                    <option key={row.itemId} value={row.itemId}>
                      {row.name}{row.catalogNumber ? ` · ${row.catalogNumber}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.pickerField} htmlFor="club-order-picker-quantity">
                Quantity
                <input className={styles.select} id="club-order-picker-quantity" inputMode="numeric" min={1} onChange={(event) => setPickerQuantity(event.target.value)} type="number" value={pickerQuantity} />
              </label>
              <button className="secondary-button" disabled={busy || !pickerItem} onClick={() => void addLine()} type="button">
                <Plus aria-hidden="true" size={14} /> Add to list
              </button>
            </div>
          </div>
        )}

        <div className={styles.actions}>
          {onList.length > 0 ? (
            <a className="primary-button" href={`${base}/csv?view=list`}><Download aria-hidden="true" size={14} /> Export list (CSV)</a>
          ) : (
            <button aria-describedby="club-order-nothing" className="primary-button" disabled type="button"><Download aria-hidden="true" size={14} /> Export list (CSV)</button>
          )}
          {printHref && onList.length > 0 && (
            <a className="secondary-button" href={printHref}><Printer aria-hidden="true" size={14} /> Printable list</a>
          )}
          {onList.length > 0 || data.awardable.length > 0 ? (
            <a className="secondary-button" href={`${base}/csv?view=picklist`}><Download aria-hidden="true" size={14} /> Pick list (who gets what)</a>
          ) : null}
        </div>
        {onList.length === 0 && <p className={`field-help ${styles.helpText}`} id="club-order-nothing">Nothing on the list to export yet.</p>}
      </section>

      <section className={styles.block} id="inventory">
        <ClubSupplyStockWorkspace
          embedded
          initialStock={stock}
          onSaved={() => void refresh().catch(() => undefined)}
          organizationId={organizationId}
          readOnly={readOnly}
        />
      </section>

      {waitingBatches.length > 0 && (
        <section className={styles.block}>
          <h3>Orders waiting to arrive</h3>
          <p className={`field-help ${styles.helpText}`}>Earlier orders, from before this helper list. Mark one received when it arrives and its items join your stock. New orders can&apos;t be placed here.</p>
          <ul className={styles.list}>
            {waitingBatches.map((batch) => (
              <li className={styles.row} key={batch.id}>
                <span className={styles.text}>
                  <strong>{formatDate(batch.createdAt)}</strong>
                  <small>{batch.itemCount} {batch.itemCount === 1 ? "item" : "items"} · {batch.totalQuantity} ordered</small>
                </span>
                {!readOnly && (
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void act(async () => { await post(`${base}/${encodeURIComponent(batch.id)}/receive`, {}); return "Order marked received."; })}
                    type="button"
                  >
                    <PackageCheck aria-hidden="true" size={14} /> Mark received
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.block}>
        <h3>Ready to hand out</h3>
        {awardGroups.length === 0 ? (
          <p className="quiet-copy">Nothing in stock covers a need yet.</p>
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
