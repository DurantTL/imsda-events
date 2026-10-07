"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ChurchSponsorFinanceFlagRow } from "@/modules/promo-codes/church-sponsor-lodging";
import { churchSponsorFlagLabel } from "@/modules/promo-codes/church-sponsor-flag-label";

/**
 * Lodging changes that moved a church's share after the church's invoice was finalized (#813). The invoice and the church's
 * amount owed were left exactly as they were; the finance office reviews each one (through the invoice-revision path if the
 * invoice should change) and clears it. A confirmation code and amounts only, never an attendee name.
 */
export function ChurchSponsorFlags({ eventId, flags }: { eventId: string; flags: ChurchSponsorFinanceFlagRow[] }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  if (flags.length === 0) return null;

  async function clear(event: FormEvent<HTMLFormElement>, flagId: string) {
    event.preventDefault();
    const note = String(new FormData(event.currentTarget).get("note") ?? "");
    setBusyId(flagId); setError("");
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/church-sponsor-flags/${encodeURIComponent(flagId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }),
      });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { message?: string }).message ?? "That flag could not be cleared.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That flag could not be cleared.");
    } finally { setBusyId(null); }
  }

  return (
    <section className="panel" aria-labelledby="church-sponsor-flags" data-testid="church-sponsor-flags">
      <h3 id="church-sponsor-flags">Church invoice already finalized ({flags.length})</h3>
      <p role="note" className="form-error">
        A lodging change moved the share of a church-sponsored registration after the church&apos;s invoice was finalized. The invoice was not revised and what the church owes was not changed. Review each one, revise the invoice through the invoice revision path if it should change, then clear the flag.
      </p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <ul>
        {flags.map((flag) => (
          <li key={flag.id}>
            <strong translate="no">{flag.churchName}</strong>, registration <span translate="no">{flag.confirmationCode}</span>: {churchSponsorFlagLabel(flag)} ({flag.createdAt.slice(0, 10)}).
            <form onSubmit={(event) => void clear(event, flag.id)}>
              <label>Note (optional) <input name="note" maxLength={300} /></label>
              <button type="submit" className="secondary-button" disabled={busyId === flag.id}>{busyId === flag.id ? "Clearing…" : "Clear flag"}</button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}
