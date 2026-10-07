"use client";

import { useState } from "react";
import { Building2, FileText, KeyRound, Mail, Save } from "lucide-react";
import type { PlatformSettingsRecord } from "@/modules/system-admin/platform-settings";

type Draft = {
  organizationName: string;
  logoUrl: string;
  supportContact: string;
  publicWebsiteUrl: string;
  defaultTimezone: string;
  defaultSenderName: string;
  defaultSenderEmail: string;
  defaultReplyToEmail: string;
  defaultAttendeeEditPolicy: "TIERED" | "VERIFY_EVERY_EDIT";
  passkeyRpId: string;
  securityAlertEmail: string;
  newClubApplicationEmail: string;
  invoiceHeaderDepartment: string;
  invoiceHeaderOrganization: string;
  invoiceHeaderAddress: string;
  invoiceHeaderPhone: string;
};

function draftFrom(settings: PlatformSettingsRecord): Draft {
  return {
    organizationName: settings.organizationName,
    logoUrl: settings.logoUrl ?? "",
    supportContact: settings.supportContact ?? "",
    publicWebsiteUrl: settings.publicWebsiteUrl ?? "",
    defaultTimezone: settings.defaultTimezone,
    defaultSenderName: settings.defaultSenderName,
    defaultSenderEmail: settings.defaultSenderEmail ?? "",
    defaultReplyToEmail: settings.defaultReplyToEmail ?? "",
    defaultAttendeeEditPolicy: settings.defaultAttendeeEditPolicy,
    passkeyRpId: settings.passkeyRpId ?? "",
    securityAlertEmail: settings.securityAlertEmail ?? "",
    newClubApplicationEmail: settings.newClubApplicationEmail ?? "",
    invoiceHeaderDepartment: settings.invoiceHeaderDepartment ?? "",
    invoiceHeaderOrganization: settings.invoiceHeaderOrganization ?? "",
    invoiceHeaderAddress: settings.invoiceHeaderAddress ?? "",
    invoiceHeaderPhone: settings.invoiceHeaderPhone ?? "",
  };
}

export function PlatformSettingsWorkspace({
  initialSettings,
}: {
  initialSettings: PlatformSettingsRecord;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [draft, setDraft] = useState(() => draftFrom(initialSettings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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
      <div className="page-intro">
        <div>
          <p className="eyebrow">System administration</p>
          <h2>Platform settings</h2>
          <p>
            Identity for the platform as a whole, and the defaults a newly created event starts from.
          </p>
        </div>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="inline-notice" role="status">{notice}</p>}

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
          <label>
            Support contact
            <input type="email" placeholder="support@imsda.org" {...field("supportContact")} />
            <small>Also receives event feature requests.</small>
          </label>
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
              <p className="eyebrow"><KeyRound aria-hidden="true" size={14} /> Sign-in security</p>
              <h2>Lockout alerts</h2>
            </div>
          </div>
          <label>
            Security alert email
            <input type="email" placeholder="security@imsda.org" {...field("securityAlertEmail")} />
            <small>
              Gets a short alert whenever a staff, club leader, or attendee sign-in locks after too many wrong passwords
              or wrong two-step codes, in addition to the account holder. Leave blank to notify only the account holder.
            </small>
          </label>
        </section>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow"><Mail aria-hidden="true" size={14} /> Clubs</p>
              <h2>New club applications</h2>
            </div>
          </div>
          <label>
            New club application notifications
            <input type="email" placeholder="youth-assistant@example.org" {...field("newClubApplicationEmail")} />
            <small>
              Gets a short notice (club name, church and director name, with a link) whenever someone applies to start a new club.
              No phone, address or attachment is ever emailed. Leave blank to send no notice; applications still wait in the queue.
            </small>
          </label>
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
          <label>Phone<input maxLength={40} {...field("invoiceHeaderPhone")} /></label>
        </section>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow"><Mail aria-hidden="true" size={14} /> New event defaults</p>
              <h2>What a new event starts from</h2>
            </div>
          </div>
          <p className="field-help">
            These fill in when an event is created. Changing them here never rewrites an event that already exists — an event’s own settings stay whatever its staff chose.
          </p>
          <label>Default timezone<input required maxLength={60} {...field("defaultTimezone")} /></label>
          <label>Default sender name<input required minLength={2} maxLength={120} {...field("defaultSenderName")} /></label>
          <label>
            Default sender address
            <input type="email" placeholder="notifications@imsda.org" {...field("defaultSenderEmail")} />
            <small>Must be verified with the email provider before an event can send real mail.</small>
          </label>
          <label>Default reply-to address<input type="email" placeholder="registration@imsda.org" {...field("defaultReplyToEmail")} /></label>
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
