"use client";

import { useMemo, useState } from "react";
import {
  BadgePercent,
  CalendarClock,
  CircleCheck,
  Plus,
  Power,
  Save,
  TicketPercent,
  X,
} from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import { useUnsavedChangesGuard } from "@/components/use-unsaved-changes-guard";
import {
  isPromoCodeEditorDraftDirty,
  normalizePromoCodeEditorDraft,
  savedPromoCodeEditorDraft,
} from "@/modules/promo-codes/editor-draft";
import type { PromoCodeRecord } from "@/modules/promo-codes/repository";

const discardEditorMessage =
  "Discard your unsaved promo code changes? Your typed changes will be lost.";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function discountLabel(promo: PromoCodeRecord) {
  if (promo.discountType === "FIXED_CENTS") {
    return `${money(promo.discountValue)} off`;
  }
  const percent = promo.discountValue / 100;
  return `${percent.toLocaleString("en-US", {
    maximumFractionDigits: 2,
  })}% off`;
}

function availabilityLabel(promo: PromoCodeRecord) {
  return {
    AVAILABLE: "Available now",
    UPCOMING: "Starts later",
    ENDED: "Ended",
    USED_UP: "Use limit reached",
    INACTIVE: "Inactive",
  }[promo.availability];
}

function optionalMoneyValue(cents: number | null) {
  return cents === null ? "" : String(cents / 100);
}

function optionalIntegerValue(value: number | null) {
  return value === null ? "" : String(value);
}

function currentPromoCodeEditorDraft(form: HTMLFormElement) {
  const values = new FormData(form);
  return normalizePromoCodeEditorDraft({
    code: String(values.get("code") ?? ""),
    isActive: values.get("isActive") === "on",
    discountType: String(values.get("discountType") ?? ""),
    discountValue: String(values.get("discountValue") ?? ""),
    startsOn: String(values.get("startsOn") ?? ""),
    endsOn: String(values.get("endsOn") ?? ""),
    minimumSubtotal: String(values.get("minimumSubtotal") ?? ""),
    maximumUses: String(values.get("maximumUses") ?? ""),
    maximumDiscount: String(values.get("maximumDiscount") ?? ""),
  });
}

export function PromoCodeWorkspace({
  eventId,
  initialPromoCodes,
}: {
  eventId: string;
  initialPromoCodes: PromoCodeRecord[];
}) {
  const [promoCodes, setPromoCodes] = useState(initialPromoCodes);
  const [editing, setEditing] = useState<PromoCodeRecord | "new" | null>(null);
  const [discountType, setDiscountType] = useState<
    "FIXED_CENTS" | "PERCENT_BPS"
  >("FIXED_CENTS");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);
  const editedPromo = editing === "new" ? null : editing;
  const editorDialogRef = useAccessibleDialog<HTMLElement>(
    Boolean(editing),
    closeEditor,
  );
  useUnsavedChangesGuard(
    Boolean(editing) && editorDirty,
    discardEditorMessage,
  );

  const totals = useMemo(() => ({
    configured: promoCodes.length,
    active: promoCodes.filter((promo) => promo.availability === "AVAILABLE").length,
    redemptions: promoCodes.reduce(
      (total, promo) => total + promo.redeemedCount,
      0,
    ),
  }), [promoCodes]);

  function beginCreate() {
    setEditing("new");
    setDiscountType("FIXED_CENTS");
    setEditorDirty(false);
    setError("");
    setNotice("");
  }

  function beginEdit(promo: PromoCodeRecord) {
    setEditing(promo);
    setDiscountType(promo.discountType);
    setEditorDirty(false);
    setError("");
    setNotice("");
  }

  function closeEditor() {
    if (saving) return;
    if (editorDirty && !window.confirm(discardEditorMessage)) return;
    setEditorDirty(false);
    setEditing(null);
    setError("");
  }

  function updateEditorDirty(form: HTMLFormElement) {
    setEditorDirty(isPromoCodeEditorDraftDirty(
      savedPromoCodeEditorDraft(editedPromo),
      currentPromoCodeEditorDraft(form),
    ));
  }

  function numberOrNull(form: FormData, key: string, multiplier = 1) {
    const value = String(form.get(key) ?? "").trim();
    if (!value) return null;
    return Math.round(Number(value) * multiplier);
  }

  async function savePromo(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    const form = new FormData(event.currentTarget);
    const current = editing === "new" ? null : editing;
    const payload = {
      code: String(form.get("code") ?? ""),
      isActive: form.get("isActive") === "on",
      discountType,
      discountValue: numberOrNull(
        form,
        "discountValue",
        100,
      ) ?? 0,
      startsOn: String(form.get("startsOn") ?? "") || null,
      endsOn: String(form.get("endsOn") ?? "") || null,
      minimumSubtotalCents: numberOrNull(
        form,
        "minimumSubtotal",
        100,
      ),
      maximumUses: numberOrNull(form, "maximumUses"),
      maximumDiscountCents: discountType === "PERCENT_BPS"
        ? numberOrNull(form, "maximumDiscount", 100)
        : null,
      ...(current ? { expectedUpdatedAt: current.updatedAt } : {}),
    };
    const url = current
      ? `/api/events/${encodeURIComponent(eventId)}/promo-codes/${encodeURIComponent(current.id)}`
      : `/api/events/${encodeURIComponent(eventId)}/promo-codes`;
    try {
      const response = await fetch(url, {
        method: current ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({})) as {
        promoCodes?: PromoCodeRecord[];
        message?: string;
        issues?: Array<{ message?: string }>;
      };
      if (!response.ok || !result.promoCodes) {
        throw new Error(
          result.message
          ?? result.issues?.[0]?.message
          ?? "The promo code could not be saved.",
        );
      }
      setPromoCodes(result.promoCodes);
      setEditorDirty(false);
      setEditing(null);
      setNotice(current
        ? `Promo code ${payload.code.trim().toUpperCase()} updated.`
        : `Promo code ${payload.code.trim().toUpperCase()} created.`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The promo code could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function deactivatePromo(promo: PromoCodeRecord) {
    if (!window.confirm(
      `Deactivate ${promo.code}? Existing registrations keep their discount, but new registrations cannot use it.`,
    )) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/promo-codes/${encodeURIComponent(promo.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: promo.code,
            isActive: false,
            discountType: promo.discountType,
            discountValue: promo.discountValue,
            startsOn: promo.startsOn,
            endsOn: promo.endsOn,
            minimumSubtotalCents: promo.minimumSubtotalCents,
            maximumUses: promo.maximumUses,
            maximumDiscountCents: promo.maximumDiscountCents,
            expectedUpdatedAt: promo.updatedAt,
          }),
        },
      );
      const result = await response.json().catch(() => ({})) as {
        promoCodes?: PromoCodeRecord[];
        message?: string;
      };
      if (!response.ok || !result.promoCodes) {
        throw new Error(result.message ?? "The promo code could not be deactivated.");
      }
      setPromoCodes(result.promoCodes);
      setNotice(`${promo.code} is inactive. Existing registration discounts were not changed.`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The promo code could not be deactivated.",
      );
    } finally {
      setSaving(false);
    }
  }

  const defaultDiscountValue = editedPromo
    ? editedPromo.discountType === "FIXED_CENTS"
      ? editedPromo.discountValue / 100
      : editedPromo.discountValue / 100
    : "";

  return (
    <section className="page-stack promo-code-workspace">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Registration pricing</p>
          <h2>Promo codes</h2>
          <p>
            Offer a fixed-dollar or percentage discount. Every successful use
            is saved with the registration so later edits never change a
            promised total.
          </p>
        </div>
        <button className="primary-button" type="button" onClick={beginCreate}>
          <Plus size={17} aria-hidden="true" /> Create promo code
        </button>
      </div>

      <section className="finance-summary" aria-label="Promo-code summary">
        <article className="finance-stat">
          <span><TicketPercent aria-hidden="true" size={18} /></span>
          <small>Configured codes</small>
          <strong>{totals.configured}</strong>
        </article>
        <article className="finance-stat">
          <span><CircleCheck aria-hidden="true" size={18} /></span>
          <small>Available now</small>
          <strong>{totals.active}</strong>
        </article>
        <article className="finance-stat muted">
          <span><BadgePercent aria-hidden="true" size={18} /></span>
          <small>Total uses</small>
          <strong>{totals.redemptions}</strong>
        </article>
      </section>

      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && !editing && <p className="form-error" role="alert">{error}</p>}

      <section className="panel promo-code-list">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Event codes</p>
            <h2>Configured discounts</h2>
          </div>
          <span className="count-badge">{promoCodes.length} codes</span>
        </div>
        {promoCodes.length === 0 ? (
          <div className="empty-state">
            <TicketPercent aria-hidden="true" size={25} />
            <h3>No promo codes yet</h3>
            <p>Create the first code, then people can apply it on the public registration form.</p>
            <button className="primary-button" type="button" onClick={beginCreate}>Create first code</button>
          </div>
        ) : (
          <div className="promo-code-grid">
            {promoCodes.map((promo) => (
              <article className="promo-code-card" key={promo.id}>
                <header>
                  <div>
                    <code>{promo.code}</code>
                    <span className={`status-chip ${promo.availability === "AVAILABLE" ? "green" : promo.availability === "UPCOMING" ? "purple" : "neutral"}`}>
                      {availabilityLabel(promo)}
                    </span>
                  </div>
                  <strong>{discountLabel(promo)}</strong>
                </header>
                <dl>
                  <div>
                    <dt>Used</dt>
                    <dd>
                      {promo.redeemedCount}
                      {promo.maximumUses === null
                        ? " · no limit"
                        : ` of ${promo.maximumUses} · ${promo.remainingUses} left`}
                    </dd>
                  </div>
                  <div>
                    <dt>Dates</dt>
                    <dd>
                      {promo.startsOn || promo.endsOn
                        ? `${promo.startsOn ?? "Now"} through ${promo.endsOn ?? "No end date"}`
                        : "No date limit"}
                    </dd>
                  </div>
                  <div>
                    <dt>Minimum</dt>
                    <dd>{promo.minimumSubtotalCents === null ? "No minimum" : money(promo.minimumSubtotalCents)}</dd>
                  </div>
                  {promo.discountType === "PERCENT_BPS" && (
                    <div>
                      <dt>Maximum discount</dt>
                      <dd>{promo.maximumDiscountCents === null ? "No cap" : money(promo.maximumDiscountCents)}</dd>
                    </div>
                  )}
                </dl>
                <footer>
                  <button className="secondary-button" type="button" onClick={() => beginEdit(promo)}>Edit</button>
                  {promo.isActive && (
                    <button className="text-button is-danger" type="button" disabled={saving} onClick={() => deactivatePromo(promo)}>
                      <Power size={15} aria-hidden="true" /> Deactivate
                    </button>
                  )}
                </footer>
              </article>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeEditor();
        }}>
          <section
            className="modal-card promo-code-editor"
            ref={editorDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="promo-code-editor-title"
            aria-describedby="promo-code-editor-help"
            tabIndex={-1}
          >
            <div className="modal-head">
              <div>
                <p className="eyebrow">{editedPromo ? "Edit future uses" : "New discount"}</p>
                <h2 id="promo-code-editor-title">{editedPromo ? `Edit ${editedPromo.code}` : "Create promo code"}</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close promo-code editor"
                disabled={saving}
                onClick={closeEditor}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <form
              className="form-stack"
              onChange={(event) => updateEditorDirty(event.currentTarget)}
              onSubmit={savePromo}
            >
              <div className="inline-notice" id="promo-code-editor-help">
                Existing registrations keep their saved discount. Changes here
                apply only to future uses.
              </div>
              <label>
                Code people will enter
                <input
                  name="code"
                  required
                  minLength={3}
                  maxLength={32}
                  pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,31}"
                  autoCapitalize="characters"
                  disabled={Boolean(editedPromo?.redeemedCount)}
                  defaultValue={editedPromo?.code ?? ""}
                  placeholder="RETREAT25"
                />
                {Boolean(editedPromo?.redeemedCount) && <small>Used codes cannot be renamed. Deactivate this one and create a new code if the wording must change.</small>}
              </label>
              {Boolean(editedPromo?.redeemedCount) && <input type="hidden" name="code" value={editedPromo?.code} />}
              <div className="form-grid two-column">
                <label>
                  Discount type
                  <select
                    name="discountType"
                    value={discountType}
                    onChange={(event) => setDiscountType(event.target.value as typeof discountType)}
                  >
                    <option value="FIXED_CENTS">Fixed dollar amount</option>
                    <option value="PERCENT_BPS">Percentage</option>
                  </select>
                </label>
                <label>
                  {discountType === "FIXED_CENTS" ? "Dollars off" : "Percent off"}
                  <input
                    name="discountValue"
                    type="number"
                    min="0.01"
                    max={discountType === "PERCENT_BPS" ? "100" : "1000000"}
                    step="0.01"
                    required
                    defaultValue={defaultDiscountValue}
                  />
                </label>
              </div>
              <div className="form-grid two-column">
                <label>
                  Starts on <small>Optional · event timezone</small>
                  <input name="startsOn" type="date" defaultValue={editedPromo?.startsOn ?? ""} />
                </label>
                <label>
                  Ends on <small>Optional · inclusive</small>
                  <input name="endsOn" type="date" defaultValue={editedPromo?.endsOn ?? ""} />
                </label>
              </div>
              <div className="form-grid two-column">
                <label>
                  Minimum subtotal <small>Optional dollars before discount</small>
                  <input name="minimumSubtotal" type="number" min="0" step="0.01" defaultValue={optionalMoneyValue(editedPromo?.minimumSubtotalCents ?? null)} />
                </label>
                <label>
                  Maximum uses <small>Optional total registrations</small>
                  <input name="maximumUses" type="number" min={Math.max(1, editedPromo?.redeemedCount ?? 1)} step="1" defaultValue={optionalIntegerValue(editedPromo?.maximumUses ?? null)} />
                </label>
              </div>
              {discountType === "PERCENT_BPS" && (
                <label>
                  Maximum discount per registration <small>Optional dollars</small>
                  <input name="maximumDiscount" type="number" min="0.01" step="0.01" defaultValue={optionalMoneyValue(editedPromo?.maximumDiscountCents ?? null)} />
                </label>
              )}
              <label className="public-registration-check">
                <input name="isActive" type="checkbox" defaultChecked={editedPromo?.isActive ?? true} />
                <span><strong>Active</strong><small>Inactive codes remain in reports but cannot be used on a new registration.</small></span>
              </label>
              <div className="promo-code-date-note">
                <CalendarClock size={17} aria-hidden="true" />
                Start and end dates use the event’s timezone. The ending date
                remains valid through that whole calendar day.
              </div>
              {error && <p className="form-error" role="alert">{error}</p>}
              <div className="form-actions">
                <button className="secondary-button" type="button" disabled={saving} onClick={closeEditor}>Cancel</button>
                <button className="primary-button" type="submit" disabled={saving}>
                  <Save size={16} aria-hidden="true" />
                  {saving ? "Saving…" : editedPromo ? "Save changes" : "Create promo code"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
