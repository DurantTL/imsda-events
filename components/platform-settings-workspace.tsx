"use client";

import Link from "next/link";
import { StaffPageHeader } from "@/components/staff-page-header";
import { useState } from "react";
import { useConfirm } from "@/components/use-confirm";
import { Building2, FileText, KeyRound, Mail, Save } from "lucide-react";
import { inlinePhoneProblem } from "@/lib/field-validation";
import type { PlatformSettingsRecord } from "@/modules/system-admin/platform-settings";

type Draft = {
  organizationName: string;
  logoUrl: string;
  publicWebsiteUrl: string;
  defaultTimezone: string;
  defaultAttendeeEditPolicy: "TIERED" | "VERIFY_EVERY_EDIT";
  passkeyRpId: string;
  invoiceHeaderDepartment: string;
  invoiceHeaderOrganization: string;
  invoiceHeaderAddress: string;
  invoiceHeaderPhone: string;
};

function draftFrom(settings: PlatformSettingsRecord): Draft {
  return {
    organizationName: settings.organizationName,
    logoUrl: settings.logoUrl ?? "",
    publicWebsiteUrl: settings.publicWebsiteUrl ?? "",
    defaultTimezone: settings.defaultTimezone,
    defaultAttendeeEditPolicy: settings.defaultAttendeeEditPolicy,
    passkeyRpId: settings.passkeyRpId ?? "",
    invoiceHeaderDepartment: settings.invoiceHeaderDepartment ?? "",
    invoiceHeaderOrganization: settings.invoiceHeaderOrganization ?? "",
    invoiceHeaderAddress: settings.invoiceHeaderAddress ?? "",
    invoiceHeaderPhone: settings.invoiceHeaderPhone ?? "",
  };
}

export type SignInSwitchState = {
  enabled: boolean;
  linkCheck: { unlinkedPairs: number; linkedPairs: number };
};

export function PlatformSettingsWorkspace({
  initialSettings,
  initialSignIn,
}: {
  initialSettings: PlatformSettingsRecord;
  initialSignIn: SignInSwitchState;
}) {
  const { confirm: askConfirm, confirmDialog } = useConfirm();
  const [signIn, setSignIn] = useState(initialSignIn);
  const [signInBusy, setSignInBusy] = useState(false);
  const [signInError, setSignInError] = useState("");
  const [signInNotice, setSignInNotice] = useState("");

  async function changeSignIn(enabled: boolean) {
    if (enabled) {
      // Fresh counts, so the warning is not stale if someone linked people since the page loaded.
      let counts = signIn.linkCheck;
      try {
        const fresh = await fetch("/api/admin/platform-settings/unified-sign-in");
        const data = await fresh.json().catch(() => ({}));
        if (fresh.ok && data.linkCheck) {
          counts = data.linkCheck;
          setSignIn((current) => ({ ...current, linkCheck: data.linkCheck }));
        }
      } catch {
        // Fall back to the counts already on screen.
      }
      const unlinked = counts.unlinkedPairs;
      const confirmed = await askConfirm({
        title: "Turn on one sign-in",
        confirmLabel: "Turn one sign-in on",
        body: (
          <>
            {unlinked > 0 && (
              <p>
                {unlinked} {unlinked === 1 ? "person still has a separate account" : "people still have separate accounts"}; link
                them on <Link className="text-button" href="/admin/accounts">Accounts</Link> first.
              </p>
            )}
            <p>
              <code>/login</code> and <code>/account/sign-in</code> will send everyone to the single <code>/sign-in</code> page, and
              staff get both their staff and attendee sides. You can turn it off again; sessions that already exist stay valid.
            </p>
          </>
        ),
      });
      if (!confirmed) return;
    }
    setSignInBusy(true);
    setSignInError("");
    setSignInNotice("");
    try {
      const response = await fetch("/api/admin/platform-settings/unified-sign-in", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.enabled !== "boolean") {
        throw new Error(result.message ?? "The switch could not be changed.");
      }
      setSignIn({ enabled: result.enabled, linkCheck: result.linkCheck ?? signIn.linkCheck });
      setSignInNotice(result.enabled ? "One sign-in is on." : "One sign-in is off.");
    } catch (caught) {
      setSignInError(caught instanceof Error ? caught.message : "The switch could not be changed.");
    } finally {
      setSignInBusy(false);
    }
  }

  const [settings, setSettings] = useState(initialSettings);
  const [draft, setDraft] = useState(() => draftFrom(initialSettings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // The invoice phone gets the shared check inline (#1193); the saved phone is the one already stored, which is flagged but never blocks.
  const [phoneTouched, setPhoneTouched] = useState(false);
  const phoneProblem = inlinePhoneProblem("Phone", draft.invoiceHeaderPhone, settings.invoiceHeaderPhone, phoneTouched);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(settings));

  function field(key: keyof Draft) {
    return {
      value: draft[key],
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => (
        setDraft((current) => ({ ...current, [key]: event.target.value }))
      ),
    };
  }

  async function save(submitEvent: React.FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    setPhoneTouched(true);
    if (phoneProblem.blocking) {
      setError("Check the highlighted answers and try again.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/platform-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.settings) {
        throw new Error(result.message ?? "The platform settings could not be saved.");
      }
      setSettings(result.settings);
      setDraft(draftFrom(result.settings));
      setNotice("Platform settings saved. New events will inherit these defaults.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The platform settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page-stack">
      <StaffPageHeader description="Identity for the platform as a whole, and the defaults a newly created event starts from." />

      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="inline-notice" role="status">{notice}</p>}

      <section className="panel" aria-labelledby="one-sign-in-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow"><KeyRound aria-hidden="true" size={14} /> One sign-in</p>
            <h2 id="one-sign-in-heading">One sign-in for staff and attendees</h2>
          </div>
        </div>
        <p className="field-help">
          Turning this on sends <code>/login</code> and <code>/account/sign-in</code> to the single <code>/sign-in</code> page, and
          staff get both their staff and attendee sides. Turning it off restores the separate pages. Sessions that already exist
          stay valid either way.
        </p>
        <p className="field-help">
          One sign-in is currently <strong>{signIn.enabled ? "on" : "off"}</strong>.
        </p>
        <ul className="field-help">
          <li>Staff with a matching attendee account, not linked yet: <strong>{signIn.linkCheck.unlinkedPairs}</strong></li>
          <li>Linked pairs: <strong>{signIn.linkCheck.linkedPairs}</strong></li>
        </ul>
        <p className="field-help">
          Link people by hand on <Link className="text-button" href="/admin/accounts">System management → Accounts</Link>. You can
          turn this on with unlinked pairs remaining; they keep separate accounts until linked.
        </p>
        {signInError && <p className="form-error" role="alert">{signInError}</p>}
        {signInNotice && <p className="inline-notice" role="status">{signInNotice}</p>}
        <div className="form-actions">
          <button className="primary-button" type="button" disabled={signInBusy} onClick={() => void changeSignIn(!signIn.enabled)}>
            {signIn.enabled ? "Turn one sign-in off" : "Turn one sign-in on"}
          </button>
        </div>
        {confirmDialog}
      </section>

      <form className="form-stack" onSubmit={save}>
        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow"><Building2 aria-hidden="true" size={14} /> Identity</p>
              <h2>Who this platform belongs to</h2>
            </div>
          </div>
          <label>Organization name<input required minLength={2} maxLength={120} {...field("organizationName")} /></label>
          <label>
            Logo URL
            <input type="url" placeholder="https://imsda.org/logo.png" {...field("logoUrl")} />
            <small>A link to an image already hosted somewhere you control. Leave blank for none.</small>
          </label>
          <label>Public website<input type="url" placeholder="https://imsda.org" {...field("publicWebsiteUrl")} /></label>
        </section>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow"><KeyRound aria-hidden="true" size={14} /> Sign-in</p>
              <h2>Passkeys</h2>
            </div>
          </div>
          <label>
            Passkey domain
            <input autoCapitalize="off" autoComplete="off" placeholder="events.imsda.org" spellCheck={false} {...field("passkeyRpId")} />
            <small>
              The site&apos;s own domain, with no https:// or path. Club directors can then use a passkey instead of an authenticator
              code. Leave blank to keep passkeys off. Changing it later makes every existing passkey stop working.
            </small>
          </label>
        </section>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow"><Mail aria-hidden="true" size={14} /> Alerts</p>
              <h2>Alert addresses</h2>
            </div>
          </div>
          <p className="field-help">
            The support contact, the security alert address and the new club application address are edited, with a switch for every
            automatic alert, on <Link className="text-button" href="/admin/email">Email</Link>.
          </p>
        </section>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow"><FileText aria-hidden="true" size={14} /> Invoices</p>
              <h2>Invoice PDF header</h2>
            </div>
          </div>
          <p className="field-help">
            Printed at the top of every church invoice PDF made from now on. A PDF that was already made keeps its header. Leave every
            field blank to print just the organization name above.
          </p>
          <label>
            Department line
            <input maxLength={120} placeholder="Youth Ministries Department" {...field("invoiceHeaderDepartment")} />
          </label>
          <label>
            Organization on invoices
            <input maxLength={120} {...field("invoiceHeaderOrganization")} />
            <small>Blank prints the organization name from Identity.</small>
          </label>
          <label>
            Mailing address
            <textarea
              maxLength={400}
              rows={3}
              value={draft.invoiceHeaderAddress}
              onChange={(event) => setDraft((current) => ({ ...current, invoiceHeaderAddress: event.target.value }))}
            />
            <small>One line per row, up to four.</small>
          </label>
          <label>Phone
            <input aria-describedby={phoneProblem.message ? "invoice-phone-error" : undefined} aria-invalid={phoneProblem.message ? true : undefined} autoComplete="off" inputMode="tel" maxLength={40} onBlur={() => setPhoneTouched(true)} type="tel" {...field("invoiceHeaderPhone")} />
            {phoneProblem.message && <small className="field-error" id="invoice-phone-error" role="alert">{phoneProblem.message}</small>}
          </label>
        </section>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow"><Mail aria-hidden="true" size={14} /> New event defaults</p>
              <h2>What a new event starts from</h2>
            </div>
          </div>
          <p className="field-help">
            These fill in when an event is created. Changing them here never rewrites an event that already exists.
          </p>
          <label>Default timezone<input required maxLength={60} {...field("defaultTimezone")} /></label>
          <p className="field-help">
            The sender name, address and reply-to every event&apos;s email uses are set on <Link className="text-button" href="/admin/email">System management → Email</Link>.
          </p>
          <label>
            Default attendee edit verification
            <select
              value={draft.defaultAttendeeEditPolicy}
              onChange={(event) => setDraft((current) => ({
                ...current,
                defaultAttendeeEditPolicy: event.target.value as Draft["defaultAttendeeEditPolicy"],
              }))}
            >
              <option value="VERIFY_EVERY_EDIT">Verify every edit</option>
              <option value="TIERED">Tiered by sensitivity</option>
            </select>
            <small>New events inherit this choice. Existing events are never rewritten.</small>
          </label>
          <p className="field-help">
            A new event still starts on local capture, so nothing reaches a registrant until someone turns real delivery on for that event.
          </p>
        </section>

        <div className="form-actions">
          {dirty && <span className="unsaved-dot" role="status">Unsaved changes</span>}
          <button className="primary-button" type="submit" disabled={saving || !dirty}>
            <Save aria-hidden="true" size={16} /> {saving ? "Saving…" : "Save platform settings"}
          </button>
        </div>
        <p className="field-help">
          Last changed {new Date(settings.updatedAt).toLocaleString()}
          {settings.updatedByName ? ` by ${settings.updatedByName}` : ""}.
        </p>
      </form>
    </section>
  );
}
