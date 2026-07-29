"use client";

import { useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, KeyRound, Save } from "lucide-react";

type Contact = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

export function AttendeeRegistrationContactForm({
  registrationId,
  initialContact,
}: {
  registrationId: string;
  initialContact: Contact;
}) {
  const [contact, setContact] = useState(initialContact);
  const [code, setCode] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "idle" | "error" | "saved"; message: string }>({
    tone: "idle",
    message: "",
  });

  function field(name: keyof Contact, value: string) {
    setContact((current) => ({ ...current, [name]: value }));
    setNotice({ tone: "idle", message: "" });
  }

  async function requestCode() {
    setRequesting(true);
    setNotice({ tone: "idle", message: "Requesting a code…" });
    try {
      const response = await fetch("/api/attendee/step-up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const payload = await response.json().catch(() => null) as {
        message?: string;
        developmentCode?: string;
      } | null;
      if (!response.ok) throw new Error(payload?.message ?? "The code could not be sent.");
      if (payload?.developmentCode) setCode(payload.developmentCode);
      setNotice({ tone: "saved", message: payload?.message ?? "Check your email for the code." });
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "The code could not be sent.",
      });
    } finally {
      setRequesting(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setNotice({ tone: "idle", message: "Saving contact details…" });
    try {
      const response = await fetch(
        `/api/attendee/registrations/${encodeURIComponent(registrationId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, contact }),
        },
      );
      const payload = await response.json().catch(() => null) as {
        contact?: Contact;
        message?: string;
      } | null;
      if (!response.ok || !payload?.contact) {
        throw new Error(payload?.message ?? "The contact details could not be saved.");
      }
      setContact(payload.contact);
      setCode("");
      setNotice({ tone: "saved", message: "Contact details saved. The code has been used." });
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "The contact details could not be saved.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="public-manage-contact-card">
      <summary>Update registration contact</summary>
      <form onSubmit={save}>
        <p>A fresh emailed code is required. It works only in this signed-in session.</p>
        <div className="public-manage-contact-grid">
          <label className="public-registration-field">
            <span className="public-registration-field-label">First name</span>
            <input required maxLength={80} value={contact.firstName} onChange={(event) => field("firstName", event.target.value)} />
          </label>
          <label className="public-registration-field">
            <span className="public-registration-field-label">Last name</span>
            <input required maxLength={80} value={contact.lastName} onChange={(event) => field("lastName", event.target.value)} />
          </label>
          <label className="public-registration-field public-manage-contact-wide">
            <span className="public-registration-field-label">Email</span>
            <input required type="email" maxLength={160} value={contact.email} onChange={(event) => field("email", event.target.value)} />
          </label>
          <label className="public-registration-field public-manage-contact-wide">
            <span className="public-registration-field-label">Phone</span>
            <input maxLength={40} value={contact.phone} onChange={(event) => field("phone", event.target.value)} />
          </label>
          <label className="public-registration-field public-manage-contact-wide">
            <span className="public-registration-field-label">Six-digit edit code</span>
            <input autoComplete="one-time-code" inputMode="numeric" maxLength={7} value={code} onChange={(event) => setCode(event.target.value)} />
          </label>
        </div>
        <div className="public-manage-contact-actions">
          <button type="button" onClick={requestCode} disabled={requesting}>
            <KeyRound size={17} aria-hidden="true" />
            {requesting ? "Sending…" : "Email a code"}
          </button>
          <button type="submit" disabled={saving || code.replace(/\s+/g, "").length !== 6}>
            <Save size={17} aria-hidden="true" />
            {saving ? "Saving…" : "Save with code"}
          </button>
          <p className={notice.tone === "error" ? "is-error" : notice.tone === "saved" ? "is-saved" : ""} role={notice.tone === "error" ? "alert" : "status"} aria-live="polite">
            {notice.tone === "error" && <AlertCircle size={16} aria-hidden="true" />}
            {notice.tone === "saved" && <CheckCircle2 size={16} aria-hidden="true" />}
            {notice.message}
          </p>
        </div>
      </form>
    </details>
  );
}
