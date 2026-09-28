"use client";

import { useMemo, useState } from "react";
import { Eye, Package, Save } from "lucide-react";
import styles from "@/components/club-supplies.module.css";
import { type ClubSupplySection, clubSupplySectionLabels, clubSupplySections } from "@/modules/club-supplies/domain";
import type { ClubStockRow } from "@/modules/club-supplies/repository";

type SaveResponse = { stock?: { itemId: string; quantityOnHand: number }; error?: string; message?: string; issues?: Array<{ message?: string }> };

function without(record: Record<string, string>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * A club's supplies on hand (#531): every catalog item grouped by section,
 * with its AdventSource number, size, and the club's quantity. A director or
 * deputy saves each row on its own; a registrar or Area Coordinator sees the
 * same list with `readOnly`, and no save endpoint is ever called.
 */
export function ClubSupplyStockWorkspace({
  organizationId,
  initialStock,
  readOnly = false,
}: {
  organizationId: string;
  initialStock: ClubStockRow[];
  readOnly?: boolean;
}) {
  const [stock, setStock] = useState(initialStock);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [section, setSection] = useState<ClubSupplySection | "">("");
  const [query, setQuery] = useState("");
  const [onlyInStock, setOnlyInStock] = useState(false);

  const groups = useMemo(() => {
    const text = query.trim().toLowerCase();
    const visible = stock.filter((row) => (!section || row.section === section)
      && (!onlyInStock || row.quantityOnHand > 0)
      && (!text || `${row.name} ${row.catalogNumber ?? ""}`.toLowerCase().includes(text)));
    return clubSupplySections
      .map((value) => ({ section: value, rows: visible.filter((row) => row.section === value) }))
      .filter((group) => group.rows.length > 0);
  }, [stock, section, query, onlyInStock]);

  async function save(row: ClubStockRow) {
    const draft = drafts[row.itemId];
    if (draft === undefined) return;
    const quantityOnHand = Number(draft);
    if (!/^\d+$/.test(draft.trim()) || !Number.isSafeInteger(quantityOnHand)) {
      setRowErrors((current) => ({ ...current, [row.itemId]: "Enter a whole number, 0 or more." }));
      return;
    }
    setSaving(row.itemId);
    setSaved(null);
    setRowErrors((current) => without(current, row.itemId));
    try {
      const response = await fetch(
        `/api/attendee/clubs/${encodeURIComponent(organizationId)}/supplies/${encodeURIComponent(row.itemId)}`,
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quantityOnHand }) },
      );
      const result = await response.json().catch(() => ({})) as SaveResponse;
      if (!response.ok || !result.stock) {
        throw new Error(
          result.error === "MFA_UNLOCK_REQUIRED"
            ? "Confirm it's you again: reload this page and enter your authenticator code."
            : result.message ?? result.issues?.[0]?.message ?? "That quantity could not be saved.",
        );
      }
      const savedQuantity = result.stock.quantityOnHand;
      setStock((current) => current.map((entry) => (entry.itemId === row.itemId ? { ...entry, quantityOnHand: savedQuantity } : entry)));
      setDrafts((current) => without(current, row.itemId));
      setSaved(row.itemId);
    } catch (caught) {
      setRowErrors((current) => ({ ...current, [row.itemId]: caught instanceof Error ? caught.message : "That quantity could not be saved." }));
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="public-registration-eyebrow">Club supplies</p>
          <h2>Supplies on hand</h2>
        </div>
        <span className="count-badge">{stock.filter((row) => row.quantityOnHand > 0).length} in stock</span>
      </div>
      {readOnly ? (
        <p className="inline-notice" role="status"><Eye aria-hidden="true" size={14} /> View only. The club director or deputy records stock.</p>
      ) : (
        <p className="field-help">Record how many of each item the club has on hand. Each row saves on its own.</p>
      )}
      {stock.length === 0 ? (
        <div className="empty-state">
          <Package aria-hidden="true" size={27} />
          <h3>No catalog items yet</h3>
          <p>Conference staff haven&apos;t loaded the supply catalog yet.</p>
        </div>
      ) : (
        <>
          <div className={styles.filters}>
            <label>
              Section
              <select onChange={(event) => setSection(event.target.value as ClubSupplySection | "")} value={section}>
                <option value="">All sections</option>
                {clubSupplySections.map((value) => <option key={value} value={value}>{clubSupplySectionLabels[value]}</option>)}
              </select>
            </label>
            <label>
              Search
              <input onChange={(event) => setQuery(event.target.value)} placeholder="Name or catalog number" type="search" value={query} />
            </label>
          </div>
          <label className="checkbox-label">
            <input checked={onlyInStock} onChange={(event) => setOnlyInStock(event.target.checked)} type="checkbox" /> Only items in stock
          </label>
          {groups.length === 0 && <p className="quiet-copy">Nothing matches.</p>}
          {groups.map((group) => (
            <section className={styles.sectionBlock} key={group.section}>
              <h3>{clubSupplySectionLabels[group.section]}</h3>
              <ul className={styles.itemList}>
                {group.rows.map((row) => {
                  const draft = drafts[row.itemId];
                  const inputId = `club-stock-${row.itemId}`;
                  return (
                    <li className={styles.itemRow} key={row.itemId}>
                      <span className={styles.itemText}>
                        <strong translate="no">{row.name}</strong>
                        <small>
                          {row.catalogNumber ? <>No. <code>{row.catalogNumber}</code></> : "No catalog number"}
                          {row.sizeLabel ? ` · ${row.sizeLabel}` : ""}
                          {row.isActive ? "" : " · No longer in the catalog"}
                        </small>
                      </span>
                      {readOnly ? (
                        <span className={styles.itemControls}><strong>{row.quantityOnHand}</strong>&nbsp;on hand</span>
                      ) : (
                        <form
                          className={styles.itemControls}
                          onSubmit={(event) => { event.preventDefault(); void save(row); }}
                        >
                          <label className="sr-only" htmlFor={inputId}>Quantity on hand: {row.name}</label>
                          <input
                            className={styles.quantity}
                            id={inputId}
                            inputMode="numeric"
                            min={0}
                            onChange={(event) => setDrafts((current) => ({ ...current, [row.itemId]: event.target.value }))}
                            type="number"
                            value={draft ?? String(row.quantityOnHand)}
                          />
                          <button
                            aria-label={`Save quantity: ${row.name}`}
                            className="secondary-button"
                            disabled={saving === row.itemId || draft === undefined || draft === String(row.quantityOnHand)}
                            type="submit"
                          >
                            <Save aria-hidden="true" size={14} /> {saving === row.itemId ? "Saving…" : "Save"}
                          </button>
                          {saved === row.itemId && <span className={styles.saved} role="status">Saved</span>}
                        </form>
                      )}
                      {rowErrors[row.itemId] && <span className={styles.rowError} role="alert">{rowErrors[row.itemId]}</span>}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      )}
    </section>
  );
}
