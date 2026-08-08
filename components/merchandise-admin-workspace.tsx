"use client";

/* The asset API returns already-authorized event URLs; next/image cannot optimize these event-scoped responses. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ImagePlus,
  PackageOpen,
  Pencil,
  Plus,
  Save,
  ShoppingBag,
  X,
} from "lucide-react";
import {
  assetEndpoint,
  formatMerchandiseMoney,
  merchandiseAdminStatus,
  merchandiseEndpoint,
} from "@/components/merchandise-admin-ui";
import styles from "./merchandise-admin-workspace.module.css";

type Artwork = { id: string; url?: string; altText?: string | null; filename?: string };
type Variant = {
  id: string;
  label: string;
  isArchived?: boolean;
  isEnabled: boolean;
  availability?: {
    priceCents: number;
    inventoryPolicy: "UNLIMITED" | "TRACKED";
    inventoryQuantity: number | null;
    isActive: boolean;
    salesStartsAt?: string | null;
    salesEndsAt?: string | null;
    maxQuantity?: number | null;
  } | null;
};
type Product = {
  id: string;
  name: string;
  description?: string | null;
  isEnabled: boolean;
  isArchived?: boolean;
  position?: number;
  artwork?: Artwork | null;
  variants: Variant[];
};
type Catalog = { eventId: string; isEnabled: boolean; products: Product[] };

type AssetList = { assets: Artwork[] };

function errorMessage(result: { message?: string; error?: string }, fallback: string) {
  return result.message ?? result.error ?? fallback;
}

export function MerchandiseAdminWorkspace({ eventId }: { eventId: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [assets, setAssets] = useState<Artwork[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [variantEditing, setVariantEditing] = useState<Variant | "new" | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [catalogResponse, assetResponse] = await Promise.all([
        fetch(merchandiseEndpoint(eventId), { cache: "no-store" }),
        fetch(assetEndpoint(eventId), { cache: "no-store" }),
      ]);
      const catalogResult = await catalogResponse.json().catch(() => ({})) as Catalog & { message?: string; error?: string };
      const assetResult = await assetResponse.json().catch(() => ({})) as AssetList & { message?: string; error?: string };
      if (catalogResponse.status === 401 || catalogResponse.status === 403 || assetResponse.status === 401 || assetResponse.status === 403) {
        throw new Error("Merchandise management is restricted for your event role.");
      }
      if (!catalogResponse.ok) throw new Error(errorMessage(catalogResult, "The merchandise catalog could not be loaded."));
      setCatalog({ eventId, isEnabled: Boolean(catalogResult.isEnabled), products: catalogResult.products ?? [] });
      if (assetResponse.ok) setAssets(assetResult.assets ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The merchandise workspace could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  // Loading is intentionally deferred to avoid a synchronous state update in the effect body.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [eventId]);

  async function mutate(url: string, method: "POST" | "PATCH", body: unknown, success: string) {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({})) as Catalog & { message?: string; error?: string };
      if (response.status === 401 || response.status === 403) throw new Error("You no longer have permission to change this catalog.");
      if (!response.ok) throw new Error(errorMessage(result, "The catalog change could not be saved."));
      if (result.products) setCatalog({ eventId, isEnabled: Boolean(result.isEnabled), products: result.products });
      setNotice(success);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The catalog change could not be saved.");
      return false;
    } finally { setSaving(false); }
  }

  async function saveProduct(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const current = editing === "new" ? null : editing;
    const product = {
      name: String(form.get("name") ?? "").trim(),
      description: String(form.get("description") ?? "").trim() || null,
      isEnabled: form.get("isEnabled") === "on",
      position: current?.position ?? 0,
      artwork: String(form.get("artworkAssetId") ?? "") ? { assetId: String(form.get("artworkAssetId")), altText: String(form.get("artworkAltText") ?? "").trim() } : null,
    };
    if (!product.name) return setError("Product name is required.");
    const saved = await mutate(
      current ? merchandiseEndpoint(eventId, `/products/${encodeURIComponent(current.id)}`) : merchandiseEndpoint(eventId, "/products"),
      current ? "PATCH" : "POST",
      product,
      current ? `${product.name} updated.` : `${product.name} created.`,
    );
    if (saved) setEditing(null);
  }

  async function saveVariant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    const current = variantEditing === "new" ? null : variantEditing;
    const tracked = form.get("inventoryPolicy") === "TRACKED";
    const payload = {
      label: String(form.get("label") ?? "").trim(),
      isEnabled: form.get("isEnabled") === "on",
      availability: {
        priceCents: Math.round(Number(form.get("price") ?? 0) * 100),
        inventoryPolicy: tracked ? "TRACKED" : "UNLIMITED",
        inventoryQuantity: tracked ? Math.max(0, Math.floor(Number(form.get("inventoryQuantity") ?? 0))) : null,
        isActive: form.get("isActive") === "on",
        maxQuantity: String(form.get("maximumQuantity") ?? "").trim() ? Math.max(1, Math.floor(Number(form.get("maximumQuantity")))) : null,
        minQuantity: 1,
        attendeeAvailability: "ALL",
        taxTreatment: "TAXABLE",
        feePolicy: "ABSORBED_BY_EVENT",
      },
    };
    if (!payload.label || !Number.isFinite(payload.availability.priceCents) || payload.availability.priceCents < 0) {
      setError("Variant label and a non-negative price are required.");
      return;
    }
    const saved = await mutate(
      current ? merchandiseEndpoint(eventId, `/products/${encodeURIComponent(selected.id)}/variants/${encodeURIComponent(current.id)}`) : merchandiseEndpoint(eventId, `/products/${encodeURIComponent(selected.id)}/variants`),
      current ? "PATCH" : "POST",
      payload,
      current ? `${payload.label} updated.` : `${payload.label} added.`,
    );
    if (saved) setVariantEditing(null);
  }

  async function uploadArtwork(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setSaving(true); setError("");
    try {
      const body = new FormData(); body.append("file", file);
      const response = await fetch(assetEndpoint(eventId), { method: "POST", body });
      const result = await response.json().catch(() => ({})) as AssetList & { message?: string; error?: string };
      if (!response.ok) throw new Error(errorMessage(result, "Artwork upload failed."));
      setAssets(result.assets ?? []);
      setNotice(`${file.name} uploaded. Add meaningful alt text before publishing it.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Artwork upload failed."); }
    finally { setSaving(false); event.target.value = ""; }
  }

  const selected = catalog?.products.find((product) => product.id === selectedId) ?? null;
  const enabledProducts = useMemo(() => catalog?.products.filter((product) => !product.isArchived && product.isEnabled && product.variants.some((variant) => variant.isEnabled && !variant.isArchived && variant.availability?.isActive)) ?? [], [catalog]);

  if (loading) return <section className="page-stack"><div className="panel" role="status">Loading merchandise catalog…</div></section>;
  if (!catalog) return <section className="page-stack"><div className="panel"><p className="form-error" role="alert">{error || "The merchandise catalog is unavailable."}</p><button className="secondary-button" type="button" onClick={() => void load()}>Try again</button></div></section>;

  return (
    <section className={`page-stack ${styles.workspace}`}>
      <div className="page-intro">
        <div><p className="eyebrow">Event commerce</p><h2>Merchandise catalog</h2><p>Configure reusable products for this event. Archived products stay in history and cannot be deleted.</p></div>
        <div className={styles.actions}><button className="secondary-button" type="button" onClick={() => void mutate(merchandiseEndpoint(eventId), "PATCH", { isEnabled: !catalog.isEnabled }, catalog.isEnabled ? "Merchandise disabled for this event." : "Merchandise enabled for this event.")} disabled={saving} aria-pressed={catalog.isEnabled}>{catalog.isEnabled ? "Disable catalog" : "Enable catalog"}</button><button className="primary-button" type="button" onClick={() => { setEditing("new"); setError(""); }}><Plus size={16} aria-hidden="true" /> Add product</button></div>
      </div>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      {!catalog.isEnabled && <div className="inline-notice warning"><PackageOpen size={17} aria-hidden="true" /><span><strong>Catalog disabled.</strong> Attendees will not see merchandise until you enable it.</span></div>}

      <div className={styles.layout}>
        <section className="panel" aria-labelledby="catalog-products-heading">
          <div className="section-heading"><div><p className="eyebrow">Staff configuration</p><h2 id="catalog-products-heading">Products</h2></div><span className="count-badge">{catalog.products.length} total</span></div>
          {catalog.products.length === 0 ? <div className="empty-state"><ShoppingBag size={26} aria-hidden="true" /><h3>No products yet</h3><p>Add a product with at least one variant to build the attendee offering.</p><button className="primary-button" type="button" onClick={() => setEditing("new")}>Create first product</button></div> : <div className={styles.productList}>
            {catalog.products.map((product) => {
              const status = merchandiseAdminStatus(product);
              return <article className={`${styles.productCard} ${selectedId === product.id ? styles.selected : ""}`} key={product.id}>
                <button className={styles.productSelect} type="button" onClick={() => setSelectedId(product.id)} aria-pressed={selectedId === product.id}>
                  {product.artwork?.url ? <img src={product.artwork.url} alt={product.artwork.altText || `${product.name} artwork`} /> : <span className={styles.artPlaceholder}><ImagePlus size={20} aria-hidden="true" /></span>}
                  <span><strong>{product.name}</strong><small>{product.variants.length} variant{product.variants.length === 1 ? "" : "s"} · {status}</small></span>
                </button>
                <div className={styles.cardActions}><button className="icon-button" type="button" aria-label={`Edit ${product.name}`} onClick={() => setEditing(product)}><Pencil size={16} aria-hidden="true" /></button>{!product.isArchived && <button className="icon-button" type="button" aria-label={`Archive ${product.name}`} onClick={() => void mutate(merchandiseEndpoint(eventId, `/products/${encodeURIComponent(product.id)}`), "PATCH", { name: product.name, description: product.description ?? null, isEnabled: false, isArchived: true, position: product.position ?? 0, artwork: product.artwork?.id && product.artwork.altText ? { assetId: product.artwork.id, altText: product.artwork.altText } : null }, `${product.name} archived. Existing history is preserved.`)}><Archive size={16} aria-hidden="true" /></button>}</div>
              </article>;
            })}
          </div>}
        </section>

        <aside className="panel" aria-labelledby="preview-heading">
          <div className="section-heading"><div><p className="eyebrow">Shared public DTO</p><h2 id="preview-heading">Attendee preview</h2></div><span className="status-chip green">{enabledProducts.length} visible</span></div>
          <p className={styles.previewHelp}>This preview uses the same safe catalog projection attendees receive. Storage paths and payment settings are never displayed.</p>
          <div className={styles.previewList}>{enabledProducts.length === 0 ? <div className="empty-state"><ShoppingBag size={24} aria-hidden="true" /><p>No enabled variants are currently visible.</p></div> : enabledProducts.map((product) => <article className={styles.previewCard} key={product.id}>{product.artwork?.url && <img src={product.artwork.url} alt={product.artwork.altText || `${product.name} artwork`} /> }<div><h3>{product.name}</h3>{product.description && <p>{product.description}</p>}<ul>{product.variants.filter((variant) => variant.isEnabled && variant.availability?.isActive).map((variant) => <li key={variant.id}><span>{variant.label}</span><strong>{formatMerchandiseMoney(variant.availability?.priceCents ?? 0)}</strong></li>)}</ul></div></article>)}</div>
          {selected && <div className={styles.variantSummary}><div className={styles.variantHeading}><strong>{selected.name} variants</strong><button className="secondary-button" type="button" onClick={() => setVariantEditing("new")}><Plus size={14} aria-hidden="true" /> Add variant</button></div>{selected.variants.map((variant) => <div className={styles.variantRow} key={variant.id}><span><strong>{variant.label}</strong><small>{variant.availability?.inventoryPolicy === "TRACKED" ? `${variant.availability.inventoryQuantity ?? 0} in stock` : "Unlimited inventory"} · {variant.isEnabled ? "enabled" : "disabled"}</small></span><span>{formatMerchandiseMoney(variant.availability?.priceCents ?? 0)}<button className="text-button" type="button" onClick={() => setVariantEditing(variant)}>Edit</button></span></div>)}</div>}
        </aside>
      </div>

      {variantEditing && selected && <div className="modal-backdrop" role="presentation"><section className={`modal-card ${styles.editor}`} role="dialog" aria-modal="true" aria-labelledby="variant-editor-title"><div className="modal-head"><div><p className="eyebrow">Variant configuration</p><h2 id="variant-editor-title">{variantEditing === "new" ? `Add ${selected.name} variant` : variantEditing.label}</h2></div><button className="icon-button" type="button" aria-label="Close variant editor" onClick={() => setVariantEditing(null)}><X size={18} aria-hidden="true" /></button></div><form className="form-stack" onSubmit={saveVariant}><label>Variant label<input name="label" required maxLength={100} defaultValue={variantEditing === "new" ? "" : variantEditing.label} placeholder="Adult · Navy" /></label><div className="form-grid two-column"><label>Price <small>USD</small><input name="price" required type="number" min="0" step="0.01" defaultValue={variantEditing === "new" ? "" : ((variantEditing.availability?.priceCents ?? 0) / 100).toFixed(2)} /></label><label>Maximum per attendee <small>Optional</small><input name="maximumQuantity" type="number" min="1" step="1" defaultValue={variantEditing === "new" ? "" : variantEditing.availability?.maxQuantity ?? ""} /></label></div><label>Inventory policy<select name="inventoryPolicy" defaultValue={variantEditing === "new" ? "UNLIMITED" : variantEditing.availability?.inventoryPolicy ?? "UNLIMITED"}><option value="UNLIMITED">Unlimited</option><option value="TRACKED">Track quantity</option></select></label><label>Inventory quantity <small>Used when tracking inventory</small><input name="inventoryQuantity" type="number" min="0" step="1" defaultValue={variantEditing === "new" ? "" : variantEditing.availability?.inventoryQuantity ?? ""} /></label><label className="public-registration-check"><input name="isEnabled" type="checkbox" defaultChecked={variantEditing === "new" ? true : variantEditing.isEnabled} /><span><strong>Variant enabled</strong><small>Disabled variants stay in history but are not offered.</small></span></label><label className="public-registration-check"><input name="isActive" type="checkbox" defaultChecked={variantEditing === "new" ? true : variantEditing.availability?.isActive ?? false} /><span><strong>Available for purchase</strong><small>Pause sales without removing configuration.</small></span></label><div className="form-actions"><button className="secondary-button" type="button" onClick={() => setVariantEditing(null)}>Cancel</button><button className="primary-button" type="submit" disabled={saving}><Save size={16} aria-hidden="true" />{saving ? "Saving…" : "Save variant"}</button></div></form></section></div>}
      {editing && <div className="modal-backdrop" role="presentation"><section className={`modal-card ${styles.editor}`} role="dialog" aria-modal="true" aria-labelledby="merchandise-editor-title"><div className="modal-head"><div><p className="eyebrow">{editing === "new" ? "New catalog item" : "Edit catalog item"}</p><h2 id="merchandise-editor-title">{editing === "new" ? "Add product" : editing.name}</h2></div><button className="icon-button" type="button" aria-label="Close product editor" onClick={() => setEditing(null)}><X size={18} aria-hidden="true" /></button></div><form className="form-stack" onSubmit={saveProduct}><label>Product name<input name="name" required maxLength={120} defaultValue={editing === "new" ? "" : editing.name} /></label><label>Description <small>Shown to attendees</small><textarea name="description" rows={3} maxLength={500} defaultValue={editing === "new" ? "" : editing.description ?? ""} /></label><div className={styles.artworkControls}><label>Artwork<input type="file" accept="image/jpeg,image/png,image/webp" onChange={uploadArtwork} disabled={saving} /></label><label>Use uploaded artwork<select name="artworkAssetId" defaultValue={editing === "new" ? "" : editing.artwork?.id ?? ""}><option value="">No artwork</option>{assets.map((asset) => <option value={asset.id} key={asset.id}>{asset.filename ?? asset.id}{asset.altText ? " · alt text set" : " · alt text needed"}</option>)}</select></label><label>Meaningful alt text <small>Required when artwork is selected</small><input name="artworkAltText" maxLength={240} defaultValue={editing === "new" ? "" : editing.artwork?.altText ?? ""} /></label></div><label className="public-registration-check"><input name="isEnabled" type="checkbox" defaultChecked={editing === "new" ? true : editing.isEnabled} /><span><strong>Enabled</strong><small>Disable instead of deleting a product referenced by order history.</small></span></label><p className={styles.variantNote}><strong>Variants and availability</strong><br />Save the product first, then use the variant controls in the product detail panel. Prices are stored and sent as integer cents.</p><div className="form-actions"><button className="secondary-button" type="button" onClick={() => setEditing(null)}>Cancel</button><button className="primary-button" type="submit" disabled={saving}><Save size={16} aria-hidden="true" />{saving ? "Saving…" : "Save product"}</button></div></form></section></div>}
    </section>
  );
}
