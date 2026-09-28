"use client";

import { useMemo, useState } from "react";
import { Check, Download, FileUp, Package, RefreshCw, Upload } from "lucide-react";
import styles from "@/components/club-supplies.module.css";
import type { ClubSupplyImportSummary, MergedNumberConflict, RepeatedCatalogNumber } from "@/modules/club-supplies/catalog-csv";
import { type ClubSupplySection, clubSupplySectionLabels, clubSupplySections } from "@/modules/club-supplies/domain";
import type { ClubSupplyItemRecord } from "@/modules/club-supplies/repository";

type PreviewStep = {
  line: number;
  name: string;
  action: "ADD" | "UPDATE" | "SKIP";
  message: string;
  section: ClubSupplySection | null;
  honorMatch: "MATCHED" | "UNMATCHED" | null;
  duplicateOfLine: number | null;
};

type ImportResponse = {
  steps?: PreviewStep[];
  summary?: ClubSupplyImportSummary;
  repeatedNumbers?: RepeatedCatalogNumber[];
  mergedNumberConflicts?: MergedNumberConflict[];
  fingerprint?: string;
  items?: ClubSupplyItemRecord[];
  error?: string;
  message?: string;
  issues?: Array<{ message?: string }>;
};

type Preview = {
  csv: string;
  steps: PreviewStep[];
  summary: ClubSupplyImportSummary;
  repeatedNumbers: RepeatedCatalogNumber[];
  mergedNumberConflicts: MergedNumberConflict[];
  fingerprint: string;
};

/** A file download from an API route, not a page, so a plain link. */
const TEMPLATE_HREF = "/api/admin/club-supplies/template";
const actionLabels = { ADD: "Add", UPDATE: "Update", SKIP: "Skip" } as const;
const actionTone = { ADD: "green", UPDATE: "purple", SKIP: "gold" } as const;

/**
 * Staff page for the club supply catalog (#531): download the template,
 * upload a CSV, read the dry run (counts, honors matched and unmatched,
 * repeated-number warnings, every row), confirm exactly that preview, then
 * browse the catalog by section and mark items active or inactive.
 */
export function ClubSupplyCatalogWorkspace({ initialItems }: { initialItems: ClubSupplyItemRecord[] }) {
  const [items, setItems] = useState(initialItems);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  const [section, setSection] = useState<ClubSupplySection | "">("");
  const [query, setQuery] = useState("");
  const [toggling, setToggling] = useState<string | null>(null);

  async function send(body: Record<string, unknown>) {
    const response = await fetch("/api/admin/club-supplies/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({})) as ImportResponse;
    return { response, result };
  }

  async function runPreview(csv: string) {
    setBusy(true);
    setError("");
    setNotice("");
    setStale(false);
    try {
      const { response, result } = await send({ csv, confirm: false });
      if (!response.ok || !result.steps || !result.summary || !result.fingerprint) {
        throw new Error(result.message ?? result.issues?.[0]?.message ?? "That file couldn't be read.");
      }
      setPreview({ csv, steps: result.steps, summary: result.summary, repeatedNumbers: result.repeatedNumbers ?? [],
        mergedNumberConflicts: result.mergedNumberConflicts ?? [],
        fingerprint: result.fingerprint,
      });
    } catch (caught) {
      setPreview(null);
      setError(caught instanceof Error ? caught.message : "That file couldn't be read.");
    } finally {
      setBusy(false);
    }
  }

  async function chooseFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await runPreview(await file.text());
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const { response, result } = await send({ csv: preview.csv, confirm: true, fingerprint: preview.fingerprint });
      if (response.status === 409 && result.error === "PREVIEW_CHANGED") {
        setStale(true);
        throw new Error(result.message ?? "The catalog changed since this preview. Refresh the preview before saving.");
      }
      if (!response.ok || !result.summary) throw new Error(result.message ?? "The catalog could not be saved.");
      if (result.items) setItems(result.items);
      setNotice(`Catalog saved: ${result.summary.added} added, ${result.summary.updated} updated, ${result.summary.skipped} skipped.`);
      setPreview(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The catalog could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(item: ClubSupplyItemRecord) {
    setToggling(item.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/club-supplies/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !item.isActive }),
      });
      const result = await response.json().catch(() => ({})) as ImportResponse;
      if (!response.ok || !result.items) throw new Error(result.message ?? "The item could not be updated.");
      setItems(result.items);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The item could not be updated.");
    } finally {
      setToggling(null);
    }
  }

  const visible = useMemo(() => {
    const text = query.trim().toLowerCase();
    return items.filter((item) => (!section || item.section === section)
      && (!text || `${item.name} ${item.catalogNumber ?? ""}`.toLowerCase().includes(text)));
  }, [items, section, query]);

  const changes = preview ? preview.summary.added + preview.summary.updated : 0;
  const counts: Array<[string, number]> = preview ? [
    ["Added", preview.summary.added],
    ["Updated", preview.summary.updated],
    ["Skipped", preview.summary.skipped],
    ["Honors matched", preview.summary.honorsMatched],
    ["Honors unmatched", preview.summary.honorsUnmatched],
    ["Repeated numbers", preview.summary.repeatedNumbers],
    ["Merged rows with another number", preview.summary.mergedNumberConflicts],
  ] : [];

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Club ministries</p>
          <h2>Club supply catalog</h2>
          <p>
            AdventSource items clubs order and keep in stock: insignia, event patches, uniform apparel, honor
            patches, and master awards. Each size is its own item because each size has its own catalog number.
          </p>
        </div>
      </div>

      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Import</p>
            <h2>Update the catalog from CSV</h2>
          </div>
        </div>
        <p className="field-help">
          Columns: Section, Item, Catalog Number, and an optional Active (Yes or No). Items are matched by section and
          name, not by number; a repeated catalog number is only a warning. A missing column or blank cell keeps what
          is saved: numbers are never cleared, and each item keeps its active setting. The reference file is <code>docs/reference/adventsource-club-catalog.csv</code>. Nothing is saved
          until you confirm the preview.
        </p>
        <div className={styles.actions}>
          <a className="secondary-button" download href={TEMPLATE_HREF}><Download aria-hidden="true" size={14} /> CSV template</a>
          <label className={`secondary-button ${styles.upload}`}>
            <FileUp aria-hidden="true" size={14} /> {busy && !preview ? "Reading…" : "Upload CSV"}
            <input accept=".csv,text/csv" disabled={busy} onChange={chooseFile} type="file" />
          </label>
        </div>
      </section>

      {preview && (
        <section className="panel" aria-labelledby="club-supply-preview-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Dry run · nothing saved yet</p>
              <h2 id="club-supply-preview-title">Preview</h2>
            </div>
            <span className="count-badge">{preview.summary.rows} rows</span>
          </div>
          <ul className={styles.counts}>
            {counts.map(([label, value]) => <li key={label}><strong>{value}</strong><span>{label}</span></li>)}
          </ul>
          {preview.mergedNumberConflicts.length > 0 && (
            <ul className={styles.warnings} aria-label="Merged rows with a different catalog number">
              {preview.mergedNumberConflicts.map((entry) => (
                <li key={entry.line}>
                  Row {entry.line} repeats row {entry.duplicateOfLine} with number <code>{entry.catalogNumber}</code>; the item keeps <code>{entry.keptCatalogNumber}</code>.
                </li>
              ))}
            </ul>
          )}
          {preview.repeatedNumbers.length > 0 && (
            <ul className={styles.warnings} aria-label="Repeated catalog numbers">
              {preview.repeatedNumbers.map((entry) => (
                <li key={entry.catalogNumber}>
                  <code>{entry.catalogNumber}</code> is on {entry.count} items (rows {entry.lines.slice(0, 6).join(", ")}{entry.lines.length > 6 ? ", …" : ""}).
                </li>
              ))}
            </ul>
          )}
          <div className={`report-table-wrap ${styles.previewTable}`}>
            <table className="report-table">
              <thead><tr><th>Row</th><th>Item</th><th>Section</th><th>What happens</th></tr></thead>
              <tbody>
                {preview.steps.map((step) => (
                  <tr key={step.line}>
                    <td>{step.line}</td>
                    <td translate="no">{step.name || "—"}</td>
                    <td>{step.section ? clubSupplySectionLabels[step.section] : "—"}</td>
                    <td><span className={`status-chip ${actionTone[step.action]}`}>{actionLabels[step.action]}</span> {step.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <button className="secondary-button" disabled={busy} onClick={() => { setPreview(null); setStale(false); }} type="button">Cancel</button>
            {stale ? (
              <button className="primary-button" disabled={busy} onClick={() => runPreview(preview.csv)} type="button">
                <RefreshCw aria-hidden="true" size={16} /> Refresh preview
              </button>
            ) : (
              <button className="primary-button" disabled={busy || changes === 0} onClick={confirm} type="button">
                <Upload aria-hidden="true" size={16} /> {busy ? "Saving…" : changes === 0 ? "Nothing to save" : `Confirm ${changes} change${changes === 1 ? "" : "s"}`}
              </button>
            )}
          </div>
        </section>
      )}

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Catalog</p>
            <h2>Items</h2>
          </div>
          <span className="count-badge">{items.length} items</span>
        </div>
        {items.length === 0 ? (
          <div className="empty-state">
            <Package aria-hidden="true" size={27} />
            <h3>No items yet</h3>
            <p>Import the reference file to start the catalog.</p>
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
            <p className="quiet-copy">{visible.length} shown</p>
            <ul className={styles.itemList}>
              {visible.map((item) => (
                <li className={styles.itemRow} key={item.id}>
                  <span className={styles.itemText}>
                    <strong translate="no">{item.name}</strong>
                    <small>
                      {clubSupplySectionLabels[item.section]}
                      {" · "}{item.catalogNumber ? <>No. <code>{item.catalogNumber}</code></> : "No catalog number"}
                      {item.sizeLabel ? ` · ${item.sizeLabel}` : ""}
                      {item.honorCode ? ` · Honor ${item.honorCode}` : ""}
                    </small>
                  </span>
                  <span className={styles.itemControls}>
                    <span className={`status-chip ${item.isActive ? "green" : "gold"}`}>{item.isActive ? "Active" : "Inactive"}</span>
                    <button
                      aria-label={`${item.isActive ? "Mark inactive" : "Mark active"}: ${item.name}`}
                      className="secondary-button"
                      disabled={toggling === item.id}
                      onClick={() => toggle(item)}
                      type="button"
                    >
                      {item.isActive ? "Mark inactive" : <><Check aria-hidden="true" size={14} /> Mark active</>}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </section>
  );
}
