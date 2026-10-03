"use client";

import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, LogOut, Mail, MapPinned, Search, ShieldOff } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";
import {
  accountColumnSortKeys,
  accountSortKeys,
  accountSortLabels,
  ariaSortFor,
  nextAccountSort,
  type AccountSort,
  type AccountSortKey,
} from "@/modules/system-admin/account-sort";
import type { AttendeeAccountSummary } from "@/modules/system-admin/user-admin";
import { cardCell } from "@/components/table-card-labels";

type PendingAccountAction = {
  account: AttendeeAccountSummary;
  body: Record<string, string | boolean>;
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
};

function when(value: string | null) {
  return value ? new Date(value).toLocaleDateString("en-US", { dateStyle: "medium" }) : "—";
}

/**
 * Attendee accounts for system administrators (#386): find an account, reset
 * its two-step sign-in after a lost device, sign it out everywhere, or change
 * its email. Passwords are never set here; people use "Forgot password".
 */
export function AttendeeAccountsWorkspace({
  initialAccounts,
  initialQuery = "",
  initialSort = null,
  initialCapped = false,
}: {
  initialAccounts: AttendeeAccountSummary[];
  initialQuery?: string;
  initialSort?: AccountSort;
  initialCapped?: boolean;
}) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [sort, setSort] = useState<AccountSort>(initialSort);
  const [capped, setCapped] = useState(initialCapped);
  const latestRequest = useRef(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Review before a high-consequence account action (#471): the shared
  // in-page confirm dialog replaces `window.confirm()`, which iOS Safari can
  // silently fail to show at all.
  const [pendingAction, setPendingAction] = useState<PendingAccountAction | null>(null);
  const [dialogError, setDialogError] = useState("");

  // The search and sort stay in the URL together (#738).
  function accountParams(nextQuery: string, nextSort: AccountSort) {
    const params = new URLSearchParams();
    if (nextQuery.trim()) params.set("q", nextQuery.trim());
    if (nextSort) {
      params.set("sort", nextSort.key);
      params.set("dir", nextSort.direction);
    }
    return params;
  }

  // A submit searches for what is typed; a sort or refresh reuses the last
  // submitted search, not whatever is half-typed in the box (#738).
  async function search(event?: React.FormEvent<HTMLFormElement>, nextSort: AccountSort = sort) {
    event?.preventDefault();
    const effectiveQuery = event ? query : submittedQuery;
    if (event) setSubmittedQuery(query);
    const requestId = ++latestRequest.current;
    setBusy("search");
    setError("");
    try {
      const params = accountParams(effectiveQuery, nextSort);
      const queryString = params.toString();
      window.history.replaceState(null, "", queryString ? `?${queryString}` : window.location.pathname);
      const response = await fetch(`/api/admin/accounts?${queryString}`);
      const result = await response.json().catch(() => ({})) as { accounts?: AttendeeAccountSummary[]; capped?: boolean; message?: string };
      if (requestId !== latestRequest.current) return;
      if (!response.ok || !result.accounts) throw new Error(result.message ?? "Accounts couldn't be loaded.");
      setAccounts(result.accounts);
      setCapped(Boolean(result.capped));
    } catch (caught) {
      if (requestId !== latestRequest.current) return;
      setError(caught instanceof Error ? caught.message : "Accounts couldn't be loaded.");
    } finally {
      if (requestId === latestRequest.current) setBusy("");
    }
  }

  function sortBy(next: NonNullable<AccountSort>) {
    setSort(next);
    void search(undefined, next);
  }

  /** Resolves to `null` on success, or the specific message to show on failure. */
  async function act(account: AttendeeAccountSummary, body: Record<string, string | boolean>): Promise<string | null> {
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
      return null;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "That account couldn't be updated.";
      setError(message);
      return message;
    } finally {
      setBusy("");
    }
  }

  function openConfirm(pending: PendingAccountAction) {
    setDialogError("");
    setPendingAction(pending);
  }

  async function confirmPendingAction() {
    if (!pendingAction) return;
    setDialogError("");
    // The server's own message (e.g. why this account can't be changed),
    // not a generic one, so the dialog explains what actually went wrong.
    const failure = await act(pendingAction.account, pendingAction.body);
    if (failure === null) setPendingAction(null);
    else setDialogError(failure);
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
      {/* While the confirm dialog is open, its own alert shows the error; one announcement, not two. */}
      {error && !pendingAction && <div className="inline-notice error" role="alert">{error}</div>}
      <form className="panel accounts-search" onSubmit={search}>
        <label>
          <span className="sr-only">Search by email or name</span>
          <input onChange={(event) => setQuery(event.target.value)} placeholder="Search by email or name" type="search" value={query} />
        </label>
        <button className="secondary-button" disabled={busy === "search"} type="submit"><Search aria-hidden="true" size={15} /> Search</button>
      <label className="accounts-sort-field">
          <span>Sort by</span>
          <select
            disabled={busy !== ""}
            onChange={(event) => {
              const key = event.target.value as AccountSortKey | "";
              if (!key) {
                setSort(null);
                void search(undefined, null);
              } else sortBy({ key, direction: sort?.direction ?? "asc" });
            }}
            value={sort?.key ?? ""}
          >
            <option value="">Newest first</option>
            {accountSortKeys.map((key) => <option key={key} value={key}>{accountSortLabels[key]}</option>)}
          </select>
        </label>
        {sort && (
          <button
            aria-label={`Sorted by ${accountSortLabels[sort.key]}, ${sort.direction === "asc" ? "ascending" : "descending"}. Reverse the order.`}
            className="secondary-button accounts-sort-direction"
            disabled={busy !== ""}
            onClick={() => sortBy({ key: sort.key, direction: sort.direction === "asc" ? "desc" : "asc" })}
            type="button"
          >
            {sort.direction === "asc" ? <ArrowUp aria-hidden="true" size={15} /> : <ArrowDown aria-hidden="true" size={15} />}
            {sort.direction === "asc" ? "Ascending" : "Descending"}
          </button>
        )}
      </form>
      <section className="panel">
        {capped && sort && <p className="inline-notice" role="status">Sorted the newest 5,000 matches — narrow your search.</p>}
        {accounts.length === 0 ? (
          <p className="report-empty">No accounts match.</p>
        ) : (
          <div className="report-table-wrap">
            <table role="table" className="report-table table-cards">
              <thead role="rowgroup">
                <tr role="row">
                  {accountColumnSortKeys.map((key) => (
                    <th aria-sort={ariaSortFor(sort, key)} key={key} role="columnheader" scope="col">
                      <button className="table-sort-button" disabled={busy !== ""} onClick={() => sortBy(nextAccountSort(sort, key))} type="button">
                        {accountSortLabels[key]}
                        {sort?.key === key
                          ? (sort.direction === "asc" ? <ArrowUp aria-hidden="true" size={13} /> : <ArrowDown aria-hidden="true" size={13} />)
                          : <ArrowUpDown aria-hidden="true" size={13} />}
                      </button>
                    </th>
                  ))}
                  <th role="columnheader"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {accounts.map((account) => (
                  <tr role="row" key={account.id}>
                    <td {...cardCell("Account")}>
                      <strong translate="no">{account.displayName || "—"}</strong><br />
                      <small translate="no">{account.email}</small>
                      {account.disabled && <><br /><span className="status-chip coral">Disabled</span></>}
                    </td>
                    <td {...cardCell("Club roles")}>
                      {account.areaCoordinator && <><span className="status-chip green">Area Coordinator</span>{account.clubRoles.length > 0 && <br />}</>}
                      {account.clubRoles.length === 0
                        ? (account.areaCoordinator ? null : "—")
                        : account.clubRoles.map((role) => `${clubDirectorRoleLabels[role.role]}, ${role.clubName}`).join("; ")}
                    </td>
                    <td {...cardCell("Two-step")}>
                      {account.authenticatorOn ? "Authenticator" : ""}
                      {account.authenticatorOn && account.passkeyCount > 0 ? " + " : ""}
                      {account.passkeyCount > 0 ? `${account.passkeyCount} passkey${account.passkeyCount === 1 ? "" : "s"}` : ""}
                      {!account.authenticatorOn && account.passkeyCount === 0 ? "Not set up" : ""}
                    </td>
                    <td {...cardCell("Last sign-in")}>{when(account.lastSignedInAt)}</td>
                    <td {...cardCell(null)}>
                      <div className="team-account-actions">
                        {(account.authenticatorOn || account.passkeyCount > 0) && (
                          <button
                            className="secondary-button"
                            disabled={busy === account.id}
                            onClick={() => openConfirm({
                              account,
                              body: { action: "reset-two-step" },
                              title: `Reset two-step sign-in for ${account.email}?`,
                              description: "Their authenticator and passkeys are removed and they're signed out.",
                              confirmLabel: `Reset two-step for ${account.email}`,
                              destructive: true,
                            })}
                            type="button"
                          >
                            <ShieldOff aria-hidden="true" size={14} /> Reset two-step
                          </button>
                        )}
                        <button
                          className="secondary-button"
                          disabled={busy === account.id}
                          onClick={() => openConfirm(account.areaCoordinator
                            ? {
                              account,
                              body: { action: "area-coordinator", on: false },
                              title: `Remove Area Coordinator from ${account.email}?`,
                              description: "They'll no longer see other clubs.",
                              confirmLabel: `Remove Area Coordinator from ${account.email}`,
                              destructive: true,
                            }
                            : {
                              account,
                              body: { action: "area-coordinator", on: true },
                              title: `Make ${account.email} an Area Coordinator?`,
                              description: "They'll see every club, view only (ages, not birth dates), after a second sign-in step.",
                              confirmLabel: `Make ${account.email} an Area Coordinator`,
                              destructive: false,
                            })}
                          type="button"
                        >
                          <MapPinned aria-hidden="true" size={14} /> {account.areaCoordinator ? "Remove Area Coordinator" : "Make Area Coordinator"}
                        </button>
                        <button
                          className="secondary-button"
                          disabled={busy === account.id}
                          onClick={() => openConfirm({
                            account,
                            body: { action: "sign-out" },
                            title: `Sign ${account.email} out on every device?`,
                            description: "This immediately ends every active session for this account.",
                            confirmLabel: `Sign ${account.email} out everywhere`,
                            destructive: true,
                          })}
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

      <ConfirmDialog
        busy={pendingAction ? busy === pendingAction.account.id : false}
        confirmLabel={pendingAction?.confirmLabel ?? "Confirm"}
        destructive={pendingAction?.destructive ?? false}
        error={dialogError}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => void confirmPendingAction()}
        open={pendingAction !== null}
        title={pendingAction?.title ?? ""}
      >
        <p>{pendingAction?.description}</p>
      </ConfirmDialog>
    </section>
  );
}
