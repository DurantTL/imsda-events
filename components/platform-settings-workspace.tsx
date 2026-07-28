"use client";

import { useState } from "react";
import { Building2, Mail, Save } from "lucide-react";
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
          <label>Support contact<input type="email" placeholder="support@imsda.org" {...field("supportContact")} /></label>
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
