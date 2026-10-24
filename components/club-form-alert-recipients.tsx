"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Save } from "lucide-react";
import { CLUB_FORM_ALERT_MAX_RECIPIENTS, parseAlertRecipients } from "@/modules/club-forms/alert-recipients";

/**
 * "Email these addresses when this form is submitted" (#1017). Saved on its own, not with the draft: it takes effect at
 * once and needs no new version. System administrators only (the route checks again). The email never holds answers.
 */
export function ClubFormAlertRecipients({ templateKey, initialEmails }: { templateKey: string; initialEmails: string[] }) {
  const router = useRouter();
  const [text, setText] = useState(initialEmails.join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    const checked = parseAlertRecipients(text, initialEmails);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/admin/club-forms/${encodeURIComponent(templateKey)}/alerts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails: checked.emails }),
      });
      const result = await response.json().catch(() => null) as { message?: string; emails?: string[] } | null;
      if (!response.ok) {
        setError(result?.message ?? "The addresses could not be saved. Try again.");
        return;
      }
      setText((result?.emails ?? checked.emails).join("\n"));
      setNotice(checked.emails.length === 0 ? "Saved. No email will be sent for this form." : `Saved. ${checked.emails.length} address${checked.emails.length === 1 ? "" : "es"} will be emailed.`);
      router.refresh();
    } catch {
      setError("The addresses could not be saved. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="club-form-alerts-heading" className="panel form-stack club-form-alerts">
      <h3 id="club-form-alerts-heading">Email when this form is submitted</h3>
      <form className="form-stack" noValidate onSubmit={save}>
        <label className="field">
          <span>Email these addresses when this form is submitted</span>
          <textarea
            aria-describedby={`club-form-alerts-help club-form-alerts-status${error ? " club-form-alerts-error" : ""}`}
            aria-invalid={Boolean(error)}
            autoComplete="off"
            maxLength={2000}
            name="alertRecipients"
            onBlur={() => {
              // The same check as the server, once the person leaves the box; an address already saved is not held against them.
              const checked = parseAlertRecipients(text, initialEmails);
              if (!checked.ok) setError(checked.message);
            }}
            onChange={(event) => { setText(event.target.value); setError(""); }}
            rows={4}
            spellCheck={false}
            value={text}
          />
        </label>
        <p className="field-help" id="club-form-alerts-help">
          One address per line, up to {CLUB_FORM_ALERT_MAX_RECIPIENTS}. Leave it empty to send nothing. The email names the form, the club, who
          submitted it and when, with a link. It never includes the answers: people sign in to read them. It also follows the
          &quot;Club form submitted&quot; switch on the Notifications page.
        </p>
        <div aria-live="polite" id="club-form-alerts-status" role="status">
          {notice && <p className="quiet-copy">{notice}</p>}
        </div>
        {error && <div className="inline-notice error" id="club-form-alerts-error" role="alert">{error}</div>}
        <div>
          <button className="primary-button" disabled={saving} type="submit">
            <Save aria-hidden="true" size={14} /> {saving ? "Saving..." : "Save addresses"}
          </button>
        </div>
      </form>
    </section>
  );
}
