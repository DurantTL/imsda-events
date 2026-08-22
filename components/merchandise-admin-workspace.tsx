"use client";

/* The asset API returns already-authorized event URLs; next/image cannot optimize these event-scoped responses. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ChevronDown,
  ChevronUp,
  ImagePlus,
  PackageOpen,
  Pencil,
  Plus,
  Save,
  ShoppingBag,
  X,
} from "lucide-react";
import {
  artworkPreviewUrl,
  assetEndpoint,
  formatMerchandiseMoney,
  merchandiseAdminStatus,
  merchandiseEndpoint,
  resequenceAfterMove,
  toIsoOrNull,
  toLocalInputValue,
} from "@/components/merchandise-admin-ui";
import styles from "./merchandise-admin-workspace.module.css";

type Artwork = { id: string; url?: string; altText?: string | null; filename?: string };
type TaxTreatment = "TAXABLE" | "TAX_EXEMPT";
type FeePolicy = "ABSORBED_BY_EVENT" | "PASSED_TO_BUYER";
type AttendeeAvailability = "ALL" | "REGISTERED" | "STAFF_ONLY";
type Availability = {
  priceCents: number;
  taxTreatment: TaxTreatment;
  feePolicy: FeePolicy;
  inventoryPolicy: "UNLIMITED" | "TRACKED";
  inventoryQuantity: number | null;
  isActive: boolean;
  salesStartsAt?: string | null;
  salesEndsAt?: string | null;
  minQuantity: number;
  maxQuantity: number | null;
  attendeeAvailability: AttendeeAvailability;
  reason?: string | null;
};
type Variant = {
  id: string;
  label: string;
  sku?: string | null;
  isArchived?: boolean;
  isEnabled: boolean;
  position?: number;
  availability?: Availability | null;
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

/** The exact safe DTO an anonymous attendee would receive, fetched from
 * /merchandise/preview rather than re-derived from admin state so the
 * preview can never drift from the real projection (sales windows,
 * attendeeAvailability, and enabled/archived enforcement all live there
 * once, in projectMerchandiseCatalog). */
type PreviewVariant = { id: string; label: string; availability: { priceCents: number } };
type PreviewProduct = { id: string; name: string; description: string | null; artwork: { assetId: string; altText: string } | null; variants: PreviewVariant[] };
type Preview = { eventId: string; products: PreviewProduct[] };
type PreviewAudience = "anonymous" | "registered" | "staff";
const previewAudiences: Array<{ value: PreviewAudience; label: string }> = [
  { value: "anonymous", label: "Public" },
  { value: "registered", label: "Registered attendees" },
  { value: "staff", label: "Staff" },
];

type AssetList = { assets: Artwork[] };

function errorMessage(result: { message?: string; error?: string }, fallback: string) {
  return result.message ?? result.error ?? fallback;
}

function productPayload(product: Product, position: number) {
  return {
    name: product.name,
    description: product.description ?? null,
    isEnabled: product.isEnabled,
    isArchived: product.isArchived ?? false,
    position,
    artwork: product.artwork?.id && product.artwork.altText ? { assetId: product.artwork.id, altText: product.artwork.altText } : null,
  };
}

function variantPayload(variant: Variant, position: number) {
  const availability = variant.availability;
  return {
    label: variant.label,
    sku: variant.sku ?? null,
    isEnabled: variant.isEnabled,
    isArchived: variant.isArchived ?? false,
    position,
    availability: {
      priceCents: availability?.priceCents ?? 0,
      taxTreatment: availability?.taxTreatment ?? "TAXABLE",
      feePolicy: availability?.feePolicy ?? "ABSORBED_BY_EVENT",
      inventoryPolicy: availability?.inventoryPolicy ?? "UNLIMITED",
      inventoryQuantity: availability?.inventoryPolicy === "TRACKED" ? (availability?.inventoryQuantity ?? 0) : null,
      isActive: availability?.isActive ?? true,
      salesStartsAt: availability?.salesStartsAt ?? null,
      salesEndsAt: availability?.salesEndsAt ?? null,
      minQuantity: availability?.minQuantity ?? 1,
      maxQuantity: availability?.maxQuantity ?? null,
      attendeeAvailability: availability?.attendeeAvailability ?? "ALL",
      reason: availability?.reason ?? null,
    },
  };
}

export function MerchandiseAdminWorkspace({ eventId }: { eventId: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [assets, setAssets] = useState<Artwork[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewAudience, setPreviewAudience] = useState<PreviewAudience>("registered");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [variantEditing, setVariantEditing] = useState<Variant | "new" | null>(null);

  /** Re-fetches admin catalog, assets, and the safe attendee preview without
   * flipping the full-page loading state, so a mutation's refresh never
   * flashes the whole workspace back to a spinner. */
  async function refresh() {
    const [catalogResponse, assetResponse, previewResponse] = await Promise.all([
      fetch(merchandiseEndpoint(eventId), { cache: "no-store" }),
      fetch(assetEndpoint(eventId), { cache: "no-store" }),
      fetch(merchandiseEndpoint(eventId, `/preview?audience=${previewAudience}`), { cache: "no-store" }),
    ]);
    const catalogResult = await catalogResponse.json().catch(() => ({})) as Catalog & { message?: string; error?: string };
    const assetResult = await assetResponse.json().catch(() => ({})) as AssetList & { message?: string; error?: string };
    const previewResult = await previewResponse.json().catch(() => ({})) as Preview & { message?: string; error?: string };
    if (catalogResponse.status === 401 || catalogResponse.status === 403 || assetResponse.status === 401 || assetResponse.status === 403) {
      throw new Error("Merchandise management is restricted for your event role.");
    }
    if (!catalogResponse.ok) throw new Error(errorMessage(catalogResult, "The merchandise catalog could not be loaded."));
    setCatalog({ eventId, isEnabled: Boolean(catalogResult.isEnabled), products: catalogResult.products ?? [] });
    if (assetResponse.ok) setAssets(assetResult.assets ?? []);
    if (previewResponse.ok) setPreview({ eventId, products: previewResult.products ?? [] });
  }

  async function load() {
    setLoading(true);
    setError("");
    try {
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The merchandise workspace could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  // Loading is intentionally deferred to avoid a synchronous state update in the effect body.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [eventId]);

  /** Every mutation response only carries the one product or variant it
   * touched, never the full catalog — so the only response shape that is
   * always correct after a write is a fresh read of the whole workspace. */
  async function mutate(url: string, method: "POST" | "PATCH" | "DELETE", body: unknown, success: string) {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as { message?: string; error?: string };
      if (response.status === 401 || response.status === 403) throw new Error("You no longer have permission to change this catalog.");
      if (!response.ok) throw new Error(errorMessage(result, "The catalog change could not be saved."));
      await refresh();
      setNotice(success);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The catalog change could not be saved.");
      return false;
    } finally { setSaving(false); }
  }

  /** Refetches only the preview for the newly chosen attendee context, so
   * switching audiences never re-fetches (or flashes) the admin catalog and
   * asset lists behind it. */
  async function changePreviewAudience(next: PreviewAudience) {
    setPreviewAudience(next);
    const response = await fetch(merchandiseEndpoint(eventId, `/preview?audience=${next}`), { cache: "no-store" });
    const result = await response.json().catch(() => ({})) as Preview & { message?: string; error?: string };
    if (response.ok) setPreview({ eventId, products: result.products ?? [] });
  }

  async function saveProduct(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const current = editing === "new" ? null : editing;
    const product = {
      name: String(form.get("name") ?? "").trim(),
      description: String(form.get("description") ?? "").trim() || null,
      isEnabled: form.get("isEnabled") === "on",
      isArchived: current?.isArchived ?? false,
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
    const maximumQuantity = String(form.get("maximumQuantity") ?? "").trim();
    const payload = {
      label: String(form.get("label") ?? "").trim(),
      sku: String(form.get("sku") ?? "").trim() || null,
      isEnabled: form.get("isEnabled") === "on",
      isArchived: current?.isArchived ?? false,
      position: current?.position ?? 0,
      availability: {
        priceCents: Math.round(Number(form.get("price") ?? 0) * 100),
        taxTreatment: String(form.get("taxTreatment") ?? "TAXABLE"),
        feePolicy: String(form.get("feePolicy") ?? "ABSORBED_BY_EVENT"),
        inventoryPolicy: tracked ? "TRACKED" : "UNLIMITED",
        inventoryQuantity: tracked ? Math.max(0, Math.floor(Number(form.get("inventoryQuantity") ?? 0))) : null,
        isActive: form.get("isActive") === "on",
        salesStartsAt: toIsoOrNull(String(form.get("salesStartsAt") ?? "")),
        salesEndsAt: toIsoOrNull(String(form.get("salesEndsAt") ?? "")),
        minQuantity: Math.max(1, Math.floor(Number(form.get("minQuantity") ?? 1))),
        maxQuantity: maximumQuantity ? Math.max(1, Math.floor(Number(maximumQuantity))) : null,
        attendeeAvailability: String(form.get("attendeeAvailability") ?? "ALL"),
        reason: String(form.get("reason") ?? "").trim() || null,
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

  async function archiveVariantAction(variant: Variant) {
    if (!selected) return;
    await mutate(
      merchandiseEndpoint(eventId, `/products/${encodeURIComponent(selected.id)}/variants/${encodeURIComponent(variant.id)}`),
      "DELETE",
      undefined,
      `${variant.label} archived. Existing history is preserved.`,
    );
  }

  function orderedProducts() {
    return catalog ? [...catalog.products].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)) : [];
  }

  /** A plain two-item position swap is a no-op once more than two siblings
   * share a position — every product/variant created through this UI starts
   * at position 0. resequenceAfterMove instead resolves the full current
   * order (ties broken the same way the server breaks them) and returns the
   * minimal set of position writes that actually change, so a move is never
   * silently swallowed by a tie. */
  async function moveProduct(product: Product, direction: -1 | 1) {
    const changes = resequenceAfterMove(catalog?.products ?? [], product.id, direction);
    if (!changes) return;
    for (const change of changes) {
      const target = catalog?.products.find((candidate) => candidate.id === change.id);
      if (!target) continue;
      const saved = await mutate(merchandiseEndpoint(eventId, `/products/${encodeURIComponent(target.id)}`), "PATCH", productPayload(target, change.position), `${target.name} moved.`);
      if (!saved) return;
    }
  }

  function orderedVariants(product: Product) {
    return [...product.variants].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  async function moveVariant(variant: Variant, direction: -1 | 1) {
    if (!selected) return;
    const changes = resequenceAfterMove(selected.variants, variant.id, direction);
    if (!changes) return;
    for (const change of changes) {
      const target = selected.variants.find((candidate) => candidate.id === change.id);
      if (!target) continue;
      const url = merchandiseEndpoint(eventId, `/products/${encodeURIComponent(selected.id)}/variants/${encodeURIComponent(target.id)}`);
      const saved = await mutate(url, "PATCH", variantPayload(target, change.position), `${target.label} moved.`);
      if (!saved) return;
    }
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
  const previewProducts = useMemo(() => preview?.products ?? [], [preview]);

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
            {orderedProducts().map((product, index, ordered) => {
              const status = merchandiseAdminStatus(product);
              return <article className={`${styles.productCard} ${selectedId === product.id ? styles.selected : ""}`} key={product.id}>
                <button className={styles.productSelect} type="button" onClick={() => setSelectedId(product.id)} aria-pressed={selectedId === product.id}>
                  {product.artwork?.url ? <img src={product.artwork.url} alt={product.artwork.altText || `${product.name} artwork`} /> : <span className={styles.artPlaceholder}><ImagePlus size={20} aria-hidden="true" /></span>}
                  <span><strong>{product.name}</strong><small>{product.variants.length} variant{product.variants.length === 1 ? "" : "s"} · {status}</small></span>
                </button>
                <div className={styles.cardActions}>
                  <button className="icon-button" type="button" aria-label={`Move ${product.name} up`} disabled={saving || index === 0} onClick={() => void moveProduct(product, -1)}><ChevronUp size={16} aria-hidden="true" /></button>
                  <button className="icon-button" type="button" aria-label={`Move ${product.name} down`} disabled={saving || index === ordered.length - 1} onClick={() => void moveProduct(product, 1)}><ChevronDown size={16} aria-hidden="true" /></button>
                  <button className="icon-button" type="button" aria-label={`Edit ${product.name}`} onClick={() => setEditing(product)}><Pencil size={16} aria-hidden="true" /></button>
                  {!product.isArchived && <button className="icon-button" type="button" aria-label={`Archive ${product.name}`} onClick={() => void mutate(merchandiseEndpoint(eventId, `/products/${encodeURIComponent(product.id)}`), "PATCH", { ...productPayload(product, product.position ?? 0), isEnabled: false, isArchived: true }, `${product.name} archived. Existing history is preserved.`)}><Archive size={16} aria-hidden="true" /></button>}
                </div>
              </article>;
            })}
          </div>}
        </section>

        <aside className="panel" aria-labelledby="preview-heading">
          <div className="section-heading"><div><p className="eyebrow">Safe preview endpoint</p><h2 id="preview-heading">Attendee preview</h2></div><span className="status-chip green">{previewProducts.length} visible</span></div>
          <p className={styles.previewHelp}>This preview is fetched from the same safe catalog projection attendees receive — sales windows, attendee-availability rules, and enabled/archived state are enforced server-side, not re-derived here. Storage paths and payment settings are never displayed. Draft, unapproved configuration is visible here to staff only; it is never exposed publicly until you enable and approve the catalog.</p>
          <div className={styles.audienceToggle} role="group" aria-label="Preview as attendee context">{previewAudiences.map((audience) => <button key={audience.value} type="button" className="secondary-button" aria-pressed={previewAudience === audience.value} onClick={() => void changePreviewAudience(audience.value)}>{audience.label}</button>)}</div>
          <div className={styles.previewList}>{previewProducts.length === 0 ? <div className="empty-state"><ShoppingBag size={24} aria-hidden="true" /><p>No enabled variants are currently visible.</p></div> : previewProducts.map((product) => <article className={styles.previewCard} key={product.id}>{product.artwork && <img src={artworkPreviewUrl(eventId, product.artwork.assetId)} alt={product.artwork.altText} />}<div><h3>{product.name}</h3>{product.description && <p>{product.description}</p>}<ul>{product.variants.map((variant) => <li key={variant.id}><span>{variant.label}</span><strong>{formatMerchandiseMoney(variant.availability.priceCents)}</strong></li>)}</ul></div></article>)}</div>
          {selected && <div className={styles.variantSummary}><div className={styles.variantHeading}><strong>{selected.name} variants</strong><button className="secondary-button" type="button" onClick={() => setVariantEditing("new")}><Plus size={14} aria-hidden="true" /> Add variant</button></div>{orderedVariants(selected).map((variant, index, ordered) => <div className={styles.variantRow} key={variant.id}>
            <span><strong>{variant.label}</strong><small>{variant.sku ? `${variant.sku} · ` : ""}{variant.availability?.inventoryPolicy === "TRACKED" ? `${variant.availability.inventoryQuantity ?? 0} in stock` : "Unlimited inventory"} · {variant.isArchived ? "archived" : variant.isEnabled ? "enabled" : "disabled"} · {variant.availability?.attendeeAvailability === "STAFF_ONLY" ? "staff only" : variant.availability?.attendeeAvailability === "REGISTERED" ? "registered attendees" : "all attendees"}</small></span>
            <span>
              {formatMerchandiseMoney(variant.availability?.priceCents ?? 0)}
              <button className="icon-button" type="button" aria-label={`Move ${variant.label} up`} disabled={saving || index === 0} onClick={() => void moveVariant(variant, -1)}><ChevronUp size={14} aria-hidden="true" /></button>
              <button className="icon-button" type="button" aria-label={`Move ${variant.label} down`} disabled={saving || index === ordered.length - 1} onClick={() => void moveVariant(variant, 1)}><ChevronDown size={14} aria-hidden="true" /></button>
              <button className="text-button" type="button" onClick={() => setVariantEditing(variant)}>Edit</button>
              {!variant.isArchived && <button className="text-button" type="button" onClick={() => void archiveVariantAction(variant)}>Archive</button>}
            </span>
          </div>)}</div>}
        </aside>
      </div>

      {variantEditing && selected && <div className="modal-backdrop" role="presentation"><section className={`modal-card ${styles.editor}`} role="dialog" aria-modal="true" aria-labelledby="variant-editor-title"><div className="modal-head"><div><p className="eyebrow">Variant configuration</p><h2 id="variant-editor-title">{variantEditing === "new" ? `Add ${selected.name} variant` : variantEditing.label}</h2></div><button className="icon-button" type="button" aria-label="Close variant editor" onClick={() => setVariantEditing(null)}><X size={18} aria-hidden="true" /></button></div><form className="form-stack" onSubmit={saveVariant}>
        <div className="form-grid two-column"><label>Variant label<input name="label" required maxLength={100} defaultValue={variantEditing === "new" ? "" : variantEditing.label} placeholder="Adult · Navy" /></label><label>SKU <small>Optional</small><input name="sku" maxLength={100} defaultValue={variantEditing === "new" ? "" : variantEditing.sku ?? ""} /></label></div>
        <div className="form-grid two-column"><label>Price <small>USD</small><input name="price" required type="number" min="0" step="0.01" defaultValue={variantEditing === "new" ? "" : ((variantEditing.availability?.priceCents ?? 0) / 100).toFixed(2)} /></label><label>Maximum per attendee <small>Optional</small><input name="maximumQuantity" type="number" min="1" step="1" defaultValue={variantEditing === "new" ? "" : variantEditing.availability?.maxQuantity ?? ""} /></label></div>
        <div className="form-grid two-column"><label>Minimum per order<input name="minQuantity" type="number" min="1" step="1" defaultValue={variantEditing === "new" ? 1 : variantEditing.availability?.minQuantity ?? 1} /></label><label>Attendee availability<select name="attendeeAvailability" defaultValue={variantEditing === "new" ? "ALL" : variantEditing.availability?.attendeeAvailability ?? "ALL"}><option value="ALL">All attendees</option><option value="REGISTERED">Registered attendees</option><option value="STAFF_ONLY">Staff only</option></select></label></div>
        <label>Inventory policy<select name="inventoryPolicy" defaultValue={variantEditing === "new" ? "UNLIMITED" : variantEditing.availability?.inventoryPolicy ?? "UNLIMITED"}><option value="UNLIMITED">Unlimited</option><option value="TRACKED">Track quantity</option></select></label>
        <label>Inventory quantity <small>Used when tracking inventory</small><input name="inventoryQuantity" type="number" min="0" step="1" defaultValue={variantEditing === "new" ? "" : variantEditing.availability?.inventoryQuantity ?? ""} /></label>
        <div className="form-grid two-column"><label>Tax treatment<select name="taxTreatment" defaultValue={variantEditing === "new" ? "TAXABLE" : variantEditing.availability?.taxTreatment ?? "TAXABLE"}><option value="TAXABLE">Taxable</option><option value="TAX_EXEMPT">Tax exempt</option></select></label><label>Fee policy<select name="feePolicy" defaultValue={variantEditing === "new" ? "ABSORBED_BY_EVENT" : variantEditing.availability?.feePolicy ?? "ABSORBED_BY_EVENT"}><option value="ABSORBED_BY_EVENT">Event absorbs fee</option><option value="PASSED_TO_BUYER">Passed to buyer</option></select></label></div>
        <div className="form-grid two-column"><label>Sales start <small>Optional</small><input name="salesStartsAt" type="datetime-local" defaultValue={variantEditing === "new" ? "" : toLocalInputValue(variantEditing.availability?.salesStartsAt)} /></label><label>Sales end <small>Optional</small><input name="salesEndsAt" type="datetime-local" defaultValue={variantEditing === "new" ? "" : toLocalInputValue(variantEditing.availability?.salesEndsAt)} /></label></div>
        <label>Reason for this change <small>Kept in the audit history</small><textarea name="reason" rows={2} maxLength={500} defaultValue={variantEditing === "new" ? "" : variantEditing.availability?.reason ?? ""} /></label>
        <label className="public-registration-check"><input name="isEnabled" type="checkbox" defaultChecked={variantEditing === "new" ? true : variantEditing.isEnabled} /><span><strong>Variant enabled</strong><small>Disabled variants stay in history but are not offered.</small></span></label>
        <label className="public-registration-check"><input name="isActive" type="checkbox" defaultChecked={variantEditing === "new" ? true : variantEditing.availability?.isActive ?? false} /><span><strong>Available for purchase</strong><small>Pause sales without removing configuration.</small></span></label>
        <div className="form-actions"><button className="secondary-button" type="button" onClick={() => setVariantEditing(null)}>Cancel</button><button className="primary-button" type="submit" disabled={saving}><Save size={16} aria-hidden="true" />{saving ? "Saving…" : "Save variant"}</button></div>
      </form></section></div>}
      {editing && <div className="modal-backdrop" role="presentation"><section className={`modal-card ${styles.editor}`} role="dialog" aria-modal="true" aria-labelledby="merchandise-editor-title"><div className="modal-head"><div><p className="eyebrow">{editing === "new" ? "New catalog item" : "Edit catalog item"}</p><h2 id="merchandise-editor-title">{editing === "new" ? "Add product" : editing.name}</h2></div><button className="icon-button" type="button" aria-label="Close product editor" onClick={() => setEditing(null)}><X size={18} aria-hidden="true" /></button></div><form className="form-stack" onSubmit={saveProduct}><label>Product name<input name="name" required maxLength={120} defaultValue={editing === "new" ? "" : editing.name} /></label><label>Description <small>Shown to attendees</small><textarea name="description" rows={3} maxLength={500} defaultValue={editing === "new" ? "" : editing.description ?? ""} /></label><div className={styles.artworkControls}><label>Artwork<input type="file" accept="image/jpeg,image/png,image/webp" onChange={uploadArtwork} disabled={saving} /></label><label>Use uploaded artwork<select name="artworkAssetId" defaultValue={editing === "new" ? "" : editing.artwork?.id ?? ""}><option value="">No artwork</option>{assets.map((asset) => <option value={asset.id} key={asset.id}>{asset.filename ?? asset.id}{asset.altText ? " · alt text set" : " · alt text needed"}</option>)}</select></label><label>Meaningful alt text <small>Required when artwork is selected</small><input name="artworkAltText" maxLength={240} defaultValue={editing === "new" ? "" : editing.artwork?.altText ?? ""} /></label></div><label className="public-registration-check"><input name="isEnabled" type="checkbox" defaultChecked={editing === "new" ? true : editing.isEnabled} /><span><strong>Enabled</strong><small>Disable instead of deleting a product referenced by order history.</small></span></label><p className={styles.variantNote}><strong>Variants and availability</strong><br />Save the product first, then use the variant controls in the product detail panel. Prices are stored and sent as integer cents.</p><div className="form-actions"><button className="secondary-button" type="button" onClick={() => setEditing(null)}>Cancel</button><button className="primary-button" type="submit" disabled={saving}><Save size={16} aria-hidden="true" />{saving ? "Saving…" : "Save product"}</button></div></form></section></div>}
    </section>
  );
}
