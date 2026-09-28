"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ClonePlan } from "@/modules/event-clones/domain";

export type CloneSourceOption = { id: string; name: string; startsOn: string; endsOn: string; isPublished: boolean };

type CopyFromPastEventProps = {
  sources: CloneSourceOption[];
};

function slugFromName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

type Failure = { message: string; issues: string[]; stale: boolean };

/**
 * "Copy from a past event" (#157): pick a source event, review the
 * domain-by-domain plan, enter every date and capacity the copy resets, and
 * confirm. Nothing is copied until the confirm; the fingerprint from the
 * preview is echoed so a source that changed in between is refused.
 */
export function CopyFromPastEvent({ sources }: CopyFromPastEventProps) {
  const router = useRouter();
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [plan, setPlan] = useState<ClonePlan | null>(null);
  const [include, setInclude] = useState<Record<string, boolean>>({});
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [capacity, setCapacity] = useState("");
  const [opensOn, setOpensOn] = useState("");
  const [closesOn, setClosesOn] = useState("");
  const [lateDates, setLateDates] = useState<Record<string, string>>({});
  const [promoWindows, setPromoWindows] = useState<Record<string, { startsOn: string; endsOn: string }>>({});
  const [capacities, setCapacities] = useState<Record<string, string>>({});
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  function updateName(value: string) {
    setName(value);
    if (!slugEdited) setSlug(slugFromName(value));
  }

  async function loadPlan() {
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch("/api/event-clones/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceEventId: sourceId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The copy plan could not be prepared.");
      const next = body.plan as ClonePlan;
      setPlan(next);
      setInclude(Object.fromEntries(next.domains.map((domain) => [domain.key, domain.count > 0])));
      setLateDates({});
      setPromoWindows(Object.fromEntries(next.review.promoCodes.map((promo) => [promo.promoCodeId, { startsOn: "", endsOn: "" }])));
      setCapacities(Object.fromEntries(next.review.honorOfferings.map((offering) => [offering.offeringId, String(offering.sourceCapacity)])));
      setRequestKey(crypto.randomUUID());
    } catch (error) {
      setPlan(null);
      setFailure({ message: error instanceof Error ? error.message : "The copy plan could not be prepared.", issues: [], stale: false });
    } finally {
      setBusy(false);
    }
  }

  const lateItems = plan && include.registrationForms ? plan.review.latePricing : [];
  const promoItems = plan && include.promoCodes ? plan.review.promoCodes : [];
  const honorItems = plan && include.honors ? plan.review.honorOfferings : [];
  const capacityNumber = capacity.trim() === "" ? null : Number(capacity);

  const complete = Boolean(plan)
    && name.trim().length >= 3 && slug.trim().length >= 3 && Boolean(startsOn) && Boolean(endsOn)
    && (capacityNumber === null || (Number.isInteger(capacityNumber) && capacityNumber >= 1))
    && lateItems.every((item) => Boolean(lateDates[`${item.formId}:${item.fieldKey}`]))
    && honorItems.every((offering) => Number.isInteger(Number(capacities[offering.offeringId])) && Number(capacities[offering.offeringId]) >= 1);

  async function confirm() {
    if (!plan) return;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch("/api/event-clones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceEventId: plan.source.id,
          expectedFingerprint: plan.fingerprint,
          requestKey,
          name, slug, startsOn, endsOn,
          capacity: capacityNumber,
          registrationOpensOn: opensOn || null,
          registrationClosesOn: closesOn || null,
          include: Object.fromEntries(plan.domains.map((domain) => [domain.key, Boolean(include[domain.key])])),
          formLatePricingDates: lateItems.map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, startsOn: lateDates[`${item.formId}:${item.fieldKey}`] })),
          promoCodeWindows: promoItems.map((promo) => ({
            promoCodeId: promo.promoCodeId,
            startsOn: promoWindows[promo.promoCodeId]?.startsOn || null,
            endsOn: promoWindows[promo.promoCodeId]?.endsOn || null,
          })),
          honorOfferingCapacities: honorItems.map((offering) => ({ offeringId: offering.offeringId, capacity: Number(capacities[offering.offeringId]) })),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setFailure({
          message: body.message ?? "The event could not be copied.",
          issues: Array.isArray(body.issues) && body.error === "CLONE_REVIEW_INCOMPLETE" ? body.issues : [],
          stale: body.error === "SOURCE_CHANGED",
        });
        setBusy(false);
        return;
      }
      router.push(`/more/event-settings?event=${body.event.id}`);
    } catch (error) {
      setFailure({ message: error instanceof Error ? error.message : "The event could not be copied.", issues: [], stale: false });
      setBusy(false);
    }
  }

  if (sources.length === 0) return <p>There are no events to copy from yet.</p>;

  return (
    <div className="page-stack event-settings-workspace event-clone">
      {failure ? (
        <div className="inline-notice error" role="alert">
          <p>{failure.message}</p>
          {failure.issues.length > 0 ? <ul>{failure.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : null}
          {failure.stale ? <button type="button" className="secondary-button" onClick={loadPlan} disabled={busy}>Preview again</button> : null}
        </div>
      ) : null}

      <section className="panel form-stack event-settings-panel">
        <label>Copy from
          <select value={sourceId} onChange={(event) => { setSourceId(event.target.value); setPlan(null); }}>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>{source.name} ({source.startsOn})</option>
            ))}
          </select>
        </label>
        <button type="button" className="secondary-button" onClick={loadPlan} disabled={busy || !sourceId}>
          {busy && !plan ? "Preparing…" : plan ? "Refresh the copy plan" : "Preview the copy plan"}
        </button>
      </section>

      {plan ? (
        <>
          <section className="panel form-stack event-settings-panel">
            <h2>What to copy</h2>
            <p className="clone-hint">Only configuration is copied, as a new unpublished draft. Turn off anything you do not want.</p>
            <ul className="clone-domain-list">
              {plan.domains.map((domain) => (
                <li key={domain.key} className="clone-domain">
                  <label className="checkbox-label clone-domain-toggle">
                    <input
                      type="checkbox"
                      checked={Boolean(include[domain.key])}
                      disabled={domain.count === 0}
                      onChange={(event) => setInclude((current) => ({ ...current, [domain.key]: event.target.checked }))}
                    />
                    <span><strong>{domain.label}</strong> <span className="clone-count">{domain.count === 0 ? "nothing to copy" : domain.count}</span></span>
                  </label>
                  <p>{domain.description}</p>
                  {domain.notes.map((note) => <p key={note} className="clone-note">{note}</p>)}
                  {domain.skipped.map((entry) => <p key={`${entry.label}-${entry.reason}`} className="clone-note">Skipped: {entry.label}. {entry.reason}</p>)}
                </li>
              ))}
            </ul>
          </section>

          <section className="panel form-stack event-settings-panel">
            <h2>New event details</h2>
            <p className="clone-hint">These are never carried over from {plan.source.name}. Enter them for the new event.</p>
            <div className="form-grid two-column">
              <label>Event name
                <input value={name} onChange={(event) => updateName(event.target.value)} />
              </label>
              <label>Web address
                <input value={slug} onChange={(event) => { setSlug(event.target.value); setSlugEdited(true); }} />
              </label>
              <label>Starts on
                <input type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />
              </label>
              <label>Ends on
                <input type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} />
              </label>
              <label>Registration opens
                <input type="date" value={opensOn} onChange={(event) => setOpensOn(event.target.value)} />
                <small>Leave blank for no opening date.</small>
              </label>
              <label>Registration closes
                <input type="date" value={closesOn} onChange={(event) => setClosesOn(event.target.value)} />
                <small>Leave blank for no closing date.</small>
              </label>
              <label>Event capacity
                <input inputMode="numeric" value={capacity} onChange={(event) => setCapacity(event.target.value.replace(/[^0-9]/g, ""))} />
                <small>Leave blank for no limit.</small>
              </label>
            </div>
          </section>

          {lateItems.length > 0 || promoItems.length > 0 || honorItems.length > 0 ? (
            <section className="panel form-stack event-settings-panel">
              <h2>Dates and capacities to review</h2>
              {lateItems.map((item) => {
                const key = `${item.formId}:${item.fieldKey}`;
                return (
                  <label key={key}>Late pricing starts: {item.fieldLabel} ({item.formName})
                    <input type="date" value={lateDates[key] ?? ""} onChange={(event) => setLateDates((current) => ({ ...current, [key]: event.target.value }))} />
                    <small>Was {item.sourceStartsOn}.</small>
                  </label>
                );
              })}
              {promoItems.map((promo) => (
                <div key={promo.promoCodeId} className="form-grid two-column">
                  <label>Promo code {promo.code} starts
                    <input type="date" value={promoWindows[promo.promoCodeId]?.startsOn ?? ""} onChange={(event) => setPromoWindows((current) => ({ ...current, [promo.promoCodeId]: { startsOn: event.target.value, endsOn: current[promo.promoCodeId]?.endsOn ?? "" } }))} />
                    <small>Was {promo.sourceStartsOn ?? "no start date"}. Copied inactive.</small>
                  </label>
                  <label>Promo code {promo.code} ends
                    <input type="date" value={promoWindows[promo.promoCodeId]?.endsOn ?? ""} onChange={(event) => setPromoWindows((current) => ({ ...current, [promo.promoCodeId]: { startsOn: current[promo.promoCodeId]?.startsOn ?? "", endsOn: event.target.value } }))} />
                    <small>Was {promo.sourceEndsOn ?? "no end date"}.</small>
                  </label>
                </div>
              ))}
              {honorItems.map((offering) => (
                <label key={offering.offeringId}>Capacity: {offering.honorName}{offering.sessionName ? ` (${offering.sessionName})` : ""}
                  <input inputMode="numeric" value={capacities[offering.offeringId] ?? ""} onChange={(event) => setCapacities((current) => ({ ...current, [offering.offeringId]: event.target.value.replace(/[^0-9]/g, "") }))} />
                  <small>Was {offering.sourceCapacity}. Confirm or change it.</small>
                </label>
              ))}
            </section>
          ) : null}

          <section className="panel form-stack event-settings-panel">
            <h2>Not copied</h2>
            <ul className="clone-plain-list">
              {plan.resets.map((reset) => <li key={reset}>{reset}</li>)}
            </ul>
            <p className="clone-hint">Not supported yet, so set up again on the new event:</p>
            <ul className="clone-plain-list">
              {plan.unsupported.map((entry) => <li key={entry.key}><strong>{entry.label}</strong>{entry.sourceCount > 0 ? ` (${entry.sourceCount} on the source)` : ""}. {entry.reason}</li>)}
            </ul>
            <p className="clone-hint">Never copied:</p>
            <ul className="clone-plain-list">
              {plan.neverCopied.map((entry) => <li key={entry}>{entry}</li>)}
            </ul>
          </section>

          <button type="button" className="primary-button clone-confirm" disabled={busy || !complete} onClick={confirm}>
            {busy ? "Creating…" : "Create draft event"}
          </button>
        </>
      ) : null}
    </div>
  );
}
