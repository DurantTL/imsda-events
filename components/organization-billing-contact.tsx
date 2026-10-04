"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import type { BillingContactAdminEntry } from "@/modules/billing-responsibility/repository";

function date(value: string) {
  return new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Conference administrators manage one organization's billing contact (#165): add or replace
 * (the previous one is ended and kept), verify, end, and read the history. The route checks the
 * system administrator role again.
 */
export function OrganizationBillingContact({
  organizationId,
  active,
  history,
}: {
  organizationId: string;
  active: BillingContactAdminEntry | null;
  history: BillingContactAdminEntry[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [roleLabel, setRoleLabel] = useState("Treasurer");
  const base = useId();

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/organizations/${encodeURIComponent(organizationId)}/billing-contact`, {
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
    <div className="panel billing-contact-admin">
      <h3>Current billing contact</h3>
      {active ? (
        <p>
          <strong>{active.name}</strong> ({active.roleLabel}) · {active.email}{active.phone ? ` · ${active.phone}` : ""}
          <br /><small>{active.verifiedAt ? `Verified ${date(active.verifiedAt)}${active.verifiedByName ? ` by ${active.verifiedByName}` : ""}` : "Not verified"} · since {date(active.effectiveFrom)}</small>
        </p>
      ) : (
        <p>No billing contact on file.</p>
      )}
      {active && (
        <span className="billing-inline-action">
          {!active.verifiedAt && <button className="secondary-button" disabled={busy} onClick={() => void send({ action: "verify", contactId: active.id })} type="button">Mark verified</button>}
          <button className="secondary-button" disabled={busy} onClick={() => void send({ action: "end", contactId: active.id })} type="button">End contact</button>
        </span>
      )}
      <form
        className="billing-contact-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send({ action: "set", contact: { name, email, phone: phone || undefined, roleLabel } }).then((ok) => {
            if (ok) { setName(""); setEmail(""); setPhone(""); }
          });
        }}
      >
        <h4>{active ? "Replace the contact" : "Add a billing contact"}</h4>
        <label htmlFor={`${base}-name`}>Name</label>
        <input autoComplete="off" id={`${base}-name`} maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} />
        <label htmlFor={`${base}-role`}>Role</label>
        <input id={`${base}-role`} maxLength={80} onChange={(event) => setRoleLabel(event.target.value)} required value={roleLabel} />
        <label htmlFor={`${base}-email`}>Email</label>
        <input autoComplete="off" id={`${base}-email`} maxLength={254} onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
        <label htmlFor={`${base}-phone`}>Phone (optional)</label>
        <input autoComplete="off" id={`${base}-phone`} maxLength={40} onChange={(event) => setPhone(event.target.value)} type="tel" value={phone} />
        {active && <small>The current contact is ended and kept in the history. The new one starts unverified.</small>}
        <button className="primary-button" disabled={busy} type="submit">{busy ? "Saving…" : "Save contact"}</button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
      {history.length > 0 && (
        <details open>
          <summary>History ({history.length})</summary>
          <ul>
            {history.map((entry) => (
              <li key={entry.id}>
                {entry.name} ({entry.roleLabel}) · {date(entry.effectiveFrom)} to {entry.effectiveTo ? date(entry.effectiveTo) : "now"}
                {entry.verifiedAt ? ` · verified${entry.verifiedByName ? ` by ${entry.verifiedByName}` : ""}` : " · not verified"}
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
