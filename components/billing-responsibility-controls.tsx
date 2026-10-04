"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

/**
 * Staff controls for the Billing responsibility screen (#165). Every action posts to one
 * endpoint that checks MANAGE_FINANCE for the event again; hiding a control is never the
 * protection. Free text goes to the server as typed, and no value here is ever linked to an
 * organization by itself: staff choose one from the picker.
 */

async function postAction(eventId: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/billing-responsibility`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.message === "string" ? result.message : "The change could not be saved.");
  return result;
}

function useAction(eventId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function run(body: Record<string, unknown>, summarize?: (result: Record<string, unknown>) => string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await postAction(eventId, body);
      if (summarize) setNotice(summarize(result));
      router.refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, notice, run };
}

export function BillingActionButton({
  eventId,
  body,
  label,
  busyLabel,
  tone = "secondary",
}: {
  eventId: string;
  body: Record<string, unknown>;
  label: string;
  busyLabel?: string;
  tone?: "primary" | "secondary";
}) {
  const { busy, error, run } = useAction(eventId);
  return (
    <span className="billing-inline-action">
      <button className={tone === "primary" ? "primary-button" : "secondary-button"} disabled={busy} onClick={() => void run(body)} type="button">
        {busy ? busyLabel ?? "Saving…" : label}
      </button>
      {error && <small className="form-error" role="alert">{error}</small>}
    </span>
  );
}

type ResolutionReportView = {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  keptStaffDecisions: number;
  unresolved: Array<{ confirmationCode: string }>;
};

/** Dry run and apply for the resolver; the dry run reports what would change and writes nothing. */
export function ResolveControls({ eventId }: { eventId: string }) {
  const { busy, error, notice, run } = useAction(eventId);
  const summarize = (result: Record<string, unknown>) => {
    const report = result.report as ResolutionReportView;
    return `${report.dryRun ? "Dry run: would record" : "Recorded"} ${report.created} new and ${report.updated} changed; ${report.unchanged} already current, ${report.keptStaffDecisions} staff decisions kept, ${report.unresolved.length} unresolved.`;
  };
  return (
    <div className="billing-resolve">
      <button className="secondary-button" disabled={busy} onClick={() => void run({ action: "resolve", apply: false }, summarize)} type="button">Check what would change</button>
      <button className="primary-button" disabled={busy} onClick={() => void run({ action: "resolve", apply: true }, summarize)} type="button">Record responsible parties</button>
      {notice && <small role="status">{notice}</small>}
      {error && <small className="form-error" role="alert">{error}</small>}
    </div>
  );
}

export function GroupingControl({ eventId, value }: { eventId: string; value: "PER_CHURCH" | "PER_CLUB" }) {
  const { busy, error, run } = useAction(eventId);
  const id = useId();
  return (
    <div className="billing-grouping">
      <label htmlFor={id}>Invoice grouping</label>
      <select
        disabled={busy}
        id={id}
        onChange={(event) => void run({ action: "set-grouping", invoiceGrouping: event.target.value })}
        value={value}
      >
        <option value="PER_CHURCH">One invoice per church (each club its own line)</option>
        <option value="PER_CLUB">One invoice per club</option>
      </select>
      {error && <small className="form-error" role="alert">{error}</small>}
    </div>
  );
}

type OrganizationOption = { id: string; name: string; type: string; city: string | null };

/** Searchable picker to link a registration to an organization; an override also needs a reason. */
export function LinkOrganizationForm({
  eventId,
  registrationId,
  needsReason,
  hint,
}: {
  eventId: string;
  registrationId: string;
  needsReason: boolean;
  hint?: string | null;
}) {
  const { busy, error, run } = useAction(eventId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<OrganizationOption[]>([]);
  const [selected, setSelected] = useState<OrganizationOption | null>(null);
  const [reason, setReason] = useState("");
  const [searchError, setSearchError] = useState("");
  const searchId = useId();
  const reasonId = useId();

  async function search(value: string) {
    setQuery(value);
    setSelected(null);
    setSearchError("");
    if (value.trim().length < 2) {
      setOptions([]);
      return;
    }
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/billing-responsibility/organizations?q=${encodeURIComponent(value)}`);
      if (!response.ok) throw new Error();
      const result = await response.json();
      setOptions(Array.isArray(result.organizations) ? result.organizations : []);
    } catch {
      setSearchError("The search failed. Try again.");
    }
  }

  if (!open) {
    return <button className="secondary-button" onClick={() => setOpen(true)} type="button">{needsReason ? "Override…" : "Link to organization…"}</button>;
  }
  return (
    <form
      className="billing-link-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!selected) return;
        void run({ action: "link", registrationId, organizationId: selected.id, reason: reason || undefined }).then((ok) => {
          if (ok) setOpen(false);
        });
      }}
    >
      {hint && <small>Registrant typed: “{hint}” (a hint only; choose the organization yourself)</small>}
      <label htmlFor={searchId}>Find a church, school, club or ministry</label>
      <input autoComplete="off" id={searchId} maxLength={80} onChange={(event) => void search(event.target.value)} value={query} />
      {searchError && <small className="form-error" role="alert">{searchError}</small>}
      {options.length > 0 && !selected && (
        <ul className="billing-options" role="listbox" aria-label="Matching organizations">
          {options.map((option) => (
            <li key={option.id}>
              <button onClick={() => { setSelected(option); setQuery(option.name); setOptions([]); }} role="option" aria-selected="false" type="button">
                {option.name} <small>{option.type.replaceAll("_", " ").toLowerCase()}{option.city ? ` · ${option.city}` : ""}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && <small role="status">Selected: <strong>{selected.name}</strong></small>}
      {needsReason && (
        <>
          <label htmlFor={reasonId}>Why replace the responsible party?</label>
          <textarea id={reasonId} maxLength={500} onChange={(event) => setReason(event.target.value)} required rows={2} value={reason} />
        </>
      )}
      <span className="billing-inline-action">
        <button className="primary-button" disabled={busy || !selected || (needsReason && reason.trim() === "")} type="submit">{busy ? "Saving…" : "Save"}</button>
        <button className="secondary-button" onClick={() => setOpen(false)} type="button">Cancel</button>
      </span>
      {error && <small className="form-error" role="alert">{error}</small>}
    </form>
  );
}
