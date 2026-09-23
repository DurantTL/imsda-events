"use client";

import { useState } from "react";
import { LogOut, Mail, Search, ShieldOff } from "lucide-react";
import { clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";
import type { AttendeeAccountSummary } from "@/modules/system-admin/user-admin";

function when(value: string | null) {
  return value ? new Date(value).toLocaleDateString("en-US", { dateStyle: "medium" }) : "—";
}

/**
 * Attendee accounts for system administrators (#386): find an account, reset
 * its two-step sign-in after a lost device, sign it out everywhere, or change
 * its email. Passwords are never set here; people use "Forgot password".
 */
export function AttendeeAccountsWorkspace({ initialAccounts }: { initialAccounts: AttendeeAccountSummary[] }) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function search(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setBusy("search");
    setError("");
    try {
      const response = await fetch(`/api/admin/accounts?q=${encodeURIComponent(query)}`);
      const result = await response.json().catch(() => ({})) as { accounts?: AttendeeAccountSummary[]; message?: string };
      if (!response.ok || !result.accounts) throw new Error(result.message ?? "Accounts couldn't be loaded.");
      setAccounts(result.accounts);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Accounts couldn't be loaded.");
    } finally {
      setBusy("");
    }
  }

  async function act(account: AttendeeAccountSummary, body: Record<string, string>) {
    setBusy(account.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "That account couldn't be updated.");
      setNotice(`${account.displayName || account.email}: ${result.message}`);
      await search();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That account couldn't be updated.");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">System administration</p>
          <h2>Accounts</h2>
          <p>
            Attendee and club accounts (people who sign in at /account). Reset two-step sign-in when someone loses their
            phone: their authenticator and passkeys are removed, they&apos;re signed out, and club roles set it up again at
            their next sign-in. Nobody can turn it off themselves. Forgotten passwords are reset by the person with
            &ldquo;Forgot password&rdquo;. Every action here is recorded.
          </p>
        </div>
      </div>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <form className="panel accounts-search" onSubmit={search}>
        <label>
          <span className="sr-only">Search by email or name</span>
          <input onChange={(event) => setQuery(event.target.value)} placeholder="Search by email or name" type="search" value={query} />
        </label>
        <button className="secondary-button" disabled={busy === "search"} type="submit"><Search aria-hidden="true" size={15} /> Search</button>
      </form>
      <section className="panel">
        {accounts.length === 0 ? (
          <p className="report-empty">No accounts match.</p>
        ) : (
          <div className="report-table-wrap">
            <table className="report-table">
              <thead><tr><th>Account</th><th>Club roles</th><th>Two-step</th><th>Last sign-in</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <strong translate="no">{account.displayName || "—"}</strong><br />
                      <small translate="no">{account.email}</small>
                      {account.disabled && <><br /><span className="status-chip coral">Disabled</span></>}
                    </td>
                    <td>{account.clubRoles.length === 0 ? "—" : account.clubRoles.map((role) => `${clubDirectorRoleLabels[role.role]}, ${role.clubName}`).join("; ")}</td>
                    <td>
                      {account.authenticatorOn ? "Authenticator" : ""}
                      {account.authenticatorOn && account.passkeyCount > 0 ? " + " : ""}
                      {account.passkeyCount > 0 ? `${account.passkeyCount} passkey${account.passkeyCount === 1 ? "" : "s"}` : ""}
                      {!account.authenticatorOn && account.passkeyCount === 0 ? "Not set up" : ""}
                    </td>
                    <td>{when(account.lastSignedInAt)}</td>
                    <td>
                      <div className="team-account-actions">
                        {(account.authenticatorOn || account.passkeyCount > 0) && (
                          <button
                            className="secondary-button"
                            disabled={busy === account.id}
                            onClick={() => window.confirm(`Reset two-step sign-in for ${account.email}? Their authenticator and passkeys are removed and they're signed out.`) && void act(account, { action: "reset-two-step" })}
                            type="button"
                          >
                            <ShieldOff aria-hidden="true" size={14} /> Reset two-step
                          </button>
                        )}
                        <button
                          className="secondary-button"
                          disabled={busy === account.id}
                          onClick={() => window.confirm(`Sign ${account.email} out on every device?`) && void act(account, { action: "sign-out" })}
                          type="button"
                        >
                          <LogOut aria-hidden="true" size={14} /> Sign out everywhere
                        </button>
                        <button
                          className="secondary-button"
                          disabled={busy === account.id}
                          onClick={() => {
                            const email = window.prompt(
                              `New email for ${account.email}? Registrations are found by email, so they'll see registrations made with the new address instead.`,
                              account.email,
                            );
                            if (email && email.trim().toLowerCase() !== account.email) void act(account, { action: "change-email", email });
                          }}
                          type="button"
                        >
                          <Mail aria-hidden="true" size={14} /> Change email
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
