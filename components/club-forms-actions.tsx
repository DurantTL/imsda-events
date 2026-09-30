"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Printer, Send } from "lucide-react";

/** Sends one single-use private link for a form to the one address the director types (#610). */
export function SendClubFormLink({
  organizationId,
  templateKey,
  formName,
  rosterMembers,
  defaultDays,
}: {
  organizationId: string;
  templateKey: string;
  formName: string;
  rosterMembers: Array<{ id: string; name: string }>;
  defaultDays: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [rosterMemberId, setRosterMemberId] = useState("");
  const [subjectName, setSubjectName] = useState("");
  const [days, setDays] = useState(String(defaultDays));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/attendee/clubs/${encodeURIComponent(organizationId)}/forms/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateKey,
          recipientEmail: email,
          rosterMemberId: rosterMemberId || null,
          subjectName: rosterMemberId ? undefined : subjectName || undefined,
          expiresInDays: Number(days) || undefined,
        }),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) {
        setError(result.message ?? "The link could not be sent.");
        return;
      }
      setNotice("Link sent. It works once and then stops working.");
      setEmail("");
      setSubjectName("");
      setRosterMemberId("");
      router.refresh();
    } catch {
      setError("The link could not be sent. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="club-form-send">
        <button className="secondary-button" onClick={() => setOpen(true)} type="button">
          <Send aria-hidden="true" size={14} /> Send a private link
        </button>
        {notice && <div className="inline-notice success" role="status">{notice}</div>}
      </div>
    );
  }
  return (
    <form className="club-form-send form-stack" onSubmit={send}>
      <p className="field-help">
        Email a private link to fill in <strong>{formName}</strong>. It goes to one address, works once, and shows nothing else about your club.
      </p>
      <div className="form-grid two-column">
        <label>Email address to send it to
          <input autoComplete="off" maxLength={160} onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
        </label>
        <label>Link expires after (days)
          <input max={30} min={1} onChange={(event) => setDays(event.target.value)} required type="number" value={days} />
        </label>
        {rosterMembers.length > 0 && (
          <label>Roster member it is for (optional)
            <select onChange={(event) => setRosterMemberId(event.target.value)} value={rosterMemberId}>
              <option value="">Not a roster member</option>
              {rosterMembers.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
            </select>
          </label>
        )}
        {!rosterMemberId && (
          <label>Label for your list (optional)
            <input maxLength={120} onChange={(event) => setSubjectName(event.target.value)} value={subjectName} />
          </label>
        )}
      </div>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <div className="intro-actions">
        <button className="primary-button" disabled={saving} type="submit">Send link</button>
        <button className="text-button" disabled={saving} onClick={() => setOpen(false)} type="button">Close</button>
      </div>
    </form>
  );
}

/** Withdraws an open link before anyone uses it. */
export function RevokeClubFormLinkButton({ organizationId, linkId }: { organizationId: string; linkId: string }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function revoke() {
    if (!window.confirm("Withdraw this link? It will stop working right away.")) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/attendee/clubs/${encodeURIComponent(organizationId)}/forms/links/${encodeURIComponent(linkId)}`, { method: "DELETE" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { message?: string };
        setError(result.message ?? "The link could not be withdrawn.");
        return;
      }
      router.refresh();
    } catch {
      setError("The link could not be withdrawn.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button className="text-button" disabled={saving} onClick={revoke} type="button">Withdraw</button>
      {error && <small className="club-report-problem">{error}</small>}
    </>
  );
}

/** A system administrator's on/off switch for one club form. */
export function ClubFormTemplateToggle({ templateKey, enabled, name, needsSync = false }: { templateKey: string; enabled: boolean; name: string; needsSync?: boolean }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function toggle() {
    const next = !enabled;
    if (!window.confirm(next
      ? `Turn on "${name}"? Every club's director and deputy will be able to use it.`
      : `Turn off "${name}"? Clubs will no longer see it or its forms. Nothing is deleted.`)) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/club-forms/${encodeURIComponent(templateKey)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { message?: string };
        setError(result.message ?? "The change could not be saved.");
        return;
      }
      router.refresh();
    } catch {
      setError("The change could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button className={enabled ? "secondary-button" : "primary-button"} disabled={saving || (needsSync && !enabled)} onClick={toggle} type="button">
        {enabled ? "Turn off" : "Turn on"}
      </button>
      {error && <small className="club-report-problem">{error}</small>}
    </>
  );
}

export function PrintFormButton() {
  return (
    <button className="secondary-button club-form-print-button" onClick={() => window.print()} type="button">
      <Printer aria-hidden="true" size={14} /> Print
    </button>
  );
}
