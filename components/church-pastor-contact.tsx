"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { inlineFieldProblem, inlinePhoneProblem } from "@/lib/field-validation";
import type { PastorContactEntry } from "@/modules/organizations/contacts-repository";

function date(value: string) {
  return new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Office staff manage one church's pastor contact (#977): add or replace (the previous is ended and kept), end, and read the history. */
export function ChurchPastorContact({ organizationId, active, history }: { organizationId: string; active: PastorContactEntry | null; history: PastorContactEntry[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const base = useId();
  const [phoneTouched, setPhoneTouched] = useState(false);
  // The same phone check the server runs (#1193). The form starts blank, so a typed phone is always a new value.
  const phoneProblem = inlinePhoneProblem("Phone", phone, undefined, phoneTouched);
  const [emailTouched, setEmailTouched] = useState(false);
  const emailProblem = inlineFieldProblem("Email", "email", email, undefined, emailTouched);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/organizations/${encodeURIComponent(organizationId)}/pastor-contact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.message === "string" ? result.message : "The change could not be saved.");
      router.refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel pastor-contact-admin">
      <h3>Current pastor contact</h3>
      {active ? (
        <p>
          <strong>{active.name}</strong>{active.email ? ` · ${active.email}` : ""}{active.phone ? ` · ${active.phone}` : ""}
          <br /><small>since {date(active.effectiveFrom)}</small>
        </p>
      ) : (
        <p>No pastor contact on file.</p>
      )}
      {active && (
        <button className="secondary-button" disabled={busy} onClick={() => void send({ action: "end", contactId: active.id })} type="button">End contact</button>
      )}
      <form
        className="billing-contact-form"
        onSubmit={(event) => {
          event.preventDefault();
          setPhoneTouched(true);
          setEmailTouched(true);
          if (phoneProblem.blocking || emailProblem.blocking) return;
          void send({ action: "set", contact: { name, email: email || undefined, phone: phone || undefined } }).then((ok) => {
            if (ok) { setName(""); setEmail(""); setPhone(""); }
          });
        }}
      >
        <h4>{active ? "Replace the pastor" : "Add a pastor"}</h4>
        <label htmlFor={`${base}-name`}>Name</label>
        <input autoComplete="off" id={`${base}-name`} maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} />
        <label htmlFor={`${base}-email`}>Email (optional)</label>
        <input aria-describedby={emailProblem.message ? `${base}-email-error` : undefined} aria-invalid={emailProblem.message ? true : undefined} autoComplete="off" id={`${base}-email`} inputMode="email" maxLength={254} onBlur={() => setEmailTouched(true)} onChange={(event) => setEmail(event.target.value)} type="email" value={email} />
        {emailProblem.message && <small className="field-error" id={`${base}-email-error`} role="alert">{emailProblem.message}</small>}
        <label htmlFor={`${base}-phone`}>Phone (optional)</label>
        <input aria-describedby={phoneProblem.message ? `${base}-phone-error` : undefined} aria-invalid={phoneProblem.message ? true : undefined} autoComplete="off" id={`${base}-phone`} inputMode="tel" maxLength={40} onBlur={() => setPhoneTouched(true)} onChange={(event) => setPhone(event.target.value)} type="tel" value={phone} />
        {phoneProblem.message && <small className="field-error" id={`${base}-phone-error`} role="alert">{phoneProblem.message}</small>}
        {active && <small>The current pastor is ended and kept in the history.</small>}
        <button className="primary-button" disabled={busy} type="submit">{busy ? "Saving…" : "Save pastor"}</button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
      {history.length > 0 && (
        <details open>
          <summary>History ({history.length})</summary>
          <ul>
            {history.map((entry) => (
              <li key={entry.id}>
                {entry.name} · {date(entry.effectiveFrom)} to {entry.effectiveTo ? date(entry.effectiveTo) : "now"}
                {entry.createdByName ? ` · entered by ${entry.createdByName}` : ""}
                {entry.endReason ? ` · ${entry.endReason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
