"use client";

import Link from "next/link";
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

/** One reviewed value: typed in, or explicitly marked as none. Blank is "not answered". */
type Reviewed = { value: string; none: boolean };
const blank: Reviewed = { value: "", none: false };

type CloneResult = {
  event: { id: string; name: string };
  alreadyCloned: boolean;
  summary: {
    copiedCounts: Record<string, number>;
    skipped: { forms: number; messageTemplates: number; assetLinks: number; privateLinks: number };
    pricingMessage: string | null;
  } | null;
};

function answered(entry: Reviewed | undefined) {
  return Boolean(entry && (entry.none || entry.value.trim() !== ""));
}

function wholeNumberAnswer(entry: Reviewed | undefined, minimum = 1) {
  if (!entry) return false;
  if (entry.none) return true;
  const number = Number(entry.value);
  return entry.value.trim() !== "" && Number.isInteger(number) && number >= minimum;
}

/** The confirm body's explicit shape: `{ value }`, or `{ value: null, none: true }`. */
function reviewedBody(entry: Reviewed, toValue: (value: string) => string | number = (value) => value) {
  return entry.none ? { value: null, none: true } : { value: toValue(entry.value) };
}

function digits(value: string) {
  return value.replace(/[^0-9]/g, "");
}

type ReviewedInputProps = {
  label: string;
  type: "date" | "number";
  entry: Reviewed;
  noneLabel: string;
  hint?: string;
  onChange: (next: Reviewed) => void;
};

/** An input with its explicit "none" choice. Checking the box clears and disables the input. */
function ReviewedInput({ label, type, entry, noneLabel, hint, onChange }: ReviewedInputProps) {
  return (
    <div className="clone-review-field">
      <label>{label}
        {type === "date" ? (
          <input type="date" value={entry.value} disabled={entry.none} onChange={(event) => onChange({ value: event.target.value, none: false })} />
        ) : (
          <input inputMode="numeric" value={entry.value} disabled={entry.none} onChange={(event) => onChange({ value: digits(event.target.value), none: false })} />
        )}
        {hint ? <small>{hint}</small> : null}
      </label>
      <label className="checkbox-label clone-none-toggle">
        <input type="checkbox" checked={entry.none} onChange={(event) => onChange({ value: "", none: event.target.checked })} />
        <span>{noneLabel}</span>
      </label>
    </div>
  );
}

/**
 * "Copy from a past event" (#157): pick a source event, review the
 * domain-by-domain plan, enter every date, capacity, and limit the copy
 * resets (or mark each one as none), and confirm. Nothing is copied until the
 * confirm; the fingerprint from the preview is echoed so a source that changed
 * in between is refused. No value is pre-filled from the source: the old one
 * is shown as a hint only.
 */
export function CopyFromPastEvent({ sources }: CopyFromPastEventProps) {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [plan, setPlan] = useState<ClonePlan | null>(null);
  const [include, setInclude] = useState<Record<string, boolean>>({});
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [capacity, setCapacity] = useState<Reviewed>(blank);
  const [opensOn, setOpensOn] = useState<Reviewed>(blank);
  const [closesOn, setClosesOn] = useState<Reviewed>(blank);
  const [lateDates, setLateDates] = useState<Record<string, string>>({});
  const [choiceLimits, setChoiceLimits] = useState<Record<string, Reviewed>>({});
  const [promoWindows, setPromoWindows] = useState<Record<string, { startsOn: Reviewed; endsOn: Reviewed }>>({});
  const [capacities, setCapacities] = useState<Record<string, string>>({});
  const [perClubLimits, setPerClubLimits] = useState<Record<string, Reviewed>>({});
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<CloneResult | null>(null);

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
      // Nothing is pre-filled from the source: every value is entered again.
      setLateDates({});
      setChoiceLimits({});
      setPromoWindows({});
      setCapacities({});
      setPerClubLimits({});
      setRequestKey(crypto.randomUUID());
    } catch (error) {
      setPlan(null);
      setFailure({ message: error instanceof Error ? error.message : "The copy plan could not be prepared.", issues: [], stale: false });
    } finally {
      setBusy(false);
    }
  }

  const lateItems = plan && include.registrationForms ? plan.review.latePricing : [];
  const limitItems = plan && include.registrationForms ? plan.review.formChoiceLimits : [];
  const promoItems = plan && include.promoCodes ? plan.review.promoCodes : [];
  const honorItems = plan && include.honors ? plan.review.honorOfferings : [];
  const privateLinks = plan ? plan.review.privateLinks.filter((finding) => include[finding.domain]) : [];
  const limitKey = (item: { formId: string; fieldKey: string; choice: string }) => JSON.stringify([item.formId, item.fieldKey, item.choice]);

  const complete = Boolean(plan)
    && name.trim().length >= 3 && slug.trim().length >= 3 && Boolean(startsOn) && Boolean(endsOn)
    && wholeNumberAnswer(capacity) && answered(opensOn) && answered(closesOn)
    && lateItems.every((item) => Boolean(lateDates[`${item.formId}:${item.fieldKey}`]))
    && limitItems.every((item) => wholeNumberAnswer(choiceLimits[limitKey(item)]))
    && promoItems.every((promo) => answered(promoWindows[promo.promoCodeId]?.startsOn) && answered(promoWindows[promo.promoCodeId]?.endsOn))
    && honorItems.every((offering) => wholeNumberAnswer({ value: capacities[offering.offeringId] ?? "", none: false }) && wholeNumberAnswer(perClubLimits[offering.offeringId]));

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
          capacity: reviewedBody(capacity, Number),
          registrationOpensOn: reviewedBody(opensOn),
          registrationClosesOn: reviewedBody(closesOn),
          include: Object.fromEntries(plan.domains.map((domain) => [domain.key, Boolean(include[domain.key])])),
          formLatePricingDates: lateItems.map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, startsOn: lateDates[`${item.formId}:${item.fieldKey}`] })),
          formChoiceLimits: limitItems.map((item) => {
            const entry = choiceLimits[limitKey(item)]!;
            return { formId: item.formId, fieldKey: item.fieldKey, choice: item.choice, limit: entry.none ? null : Number(entry.value) };
          }),
          promoCodeWindows: promoItems.map((promo) => ({
            promoCodeId: promo.promoCodeId,
            startsOn: reviewedBody(promoWindows[promo.promoCodeId]!.startsOn),
            endsOn: reviewedBody(promoWindows[promo.promoCodeId]!.endsOn),
          })),
          honorOfferingCapacities: honorItems.map((offering) => {
            const perClub = perClubLimits[offering.offeringId]!;
            return { offeringId: offering.offeringId, capacity: Number(capacities[offering.offeringId]), perClubLimit: perClub.none ? null : Number(perClub.value) };
          }),
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
      setResult(body as CloneResult);
      setBusy(false);
    } catch (error) {
      setFailure({ message: error instanceof Error ? error.message : "The event could not be copied.", issues: [], stale: false });
      setBusy(false);
    }
  }

  if (sources.length === 0) return <p>There are no events to copy from yet.</p>;

  if (result && plan) {
    const summary = result.summary;
    return (
      <div className="page-stack event-settings-workspace event-clone">
        <section className="panel form-stack event-settings-panel" aria-live="polite">
          <h2>{result.alreadyCloned ? "This draft was already created" : "Draft event created"}</h2>
          <p className="clone-hint">{result.event.name} is an unpublished draft copied from {plan.source.name}.</p>
          {summary?.pricingMessage ? <p className="inline-notice clone-warning" role="status">{summary.pricingMessage} Copied forms are drafts and copied promo codes are inactive until you publish or activate them.</p> : null}
          {summary ? (
            <ul className="clone-plain-list">
              {plan.domains.filter((domain) => (summary.copiedCounts[domain.key] ?? 0) > 0).map((domain) => (
                <li key={domain.key}><strong>{domain.label}</strong>: {summary.copiedCounts[domain.key]} copied</li>
              ))}
              {summary.skipped.privateLinks > 0 ? <li><strong>Private links removed</strong>: {summary.skipped.privateLinks}</li> : null}
              {summary.skipped.assetLinks > 0 ? <li><strong>Links to uploaded files skipped</strong>: {summary.skipped.assetLinks}</li> : null}
              {summary.skipped.forms > 0 ? <li><strong>Forms not copied</strong>: {summary.skipped.forms}</li> : null}
              {summary.skipped.messageTemplates > 0 ? <li><strong>Message templates not copied</strong>: {summary.skipped.messageTemplates}</li> : null}
            </ul>
          ) : null}
          <Link className="primary-button clone-confirm" href={`/more/event-settings?event=${result.event.id}`}>Open the new event&apos;s settings</Link>
        </section>
      </div>
    );
  }

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
            {plan.pricingMessage ? <p className="inline-notice clone-warning" role="status">{plan.pricingMessage}</p> : null}
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

          {privateLinks.length > 0 ? (
            <section className="panel form-stack event-settings-panel">
              <h2>Private links to review</h2>
              <p className="clone-hint">These links point at the source event or carry a token. Each is removed from the copy; add a new link on the draft if one is still needed.</p>
              <ul className="clone-plain-list">
                {privateLinks.map((finding, index) => (
                  <li key={`${finding.location}-${index}`}>
                    <strong>Needs review:</strong> {finding.location}. <code className="clone-link">{finding.link}</code> ({finding.reasons.join(", ")}). Removed from the copy.
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="panel form-stack event-settings-panel">
            <h2>New event details</h2>
            <p className="clone-hint">These are never carried over from {plan.source.name}. Enter each one, or mark it as none.</p>
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
              <ReviewedInput label="Registration opens" type="date" entry={opensOn} noneLabel="No opening date" onChange={setOpensOn} />
              <ReviewedInput label="Registration closes" type="date" entry={closesOn} noneLabel="No closing date" onChange={setClosesOn} />
              <ReviewedInput label="Event capacity" type="number" entry={capacity} noneLabel="No limit" onChange={setCapacity} />
            </div>
          </section>

          {lateItems.length > 0 || limitItems.length > 0 || promoItems.length > 0 || honorItems.length > 0 ? (
            <section className="panel form-stack event-settings-panel">
              <h2>Dates, capacities, and limits to review</h2>
              <p className="clone-hint">Nothing here is filled in from {plan.source.name}. The old value is shown as a hint.</p>
              {lateItems.map((item) => {
                const key = `${item.formId}:${item.fieldKey}`;
                return (
                  <label key={key}>Late pricing starts: {item.fieldLabel} ({item.formName})
                    <input type="date" value={lateDates[key] ?? ""} onChange={(event) => setLateDates((current) => ({ ...current, [key]: event.target.value }))} />
                    <small>Last time: {item.sourceStartsOn}.</small>
                  </label>
                );
              })}
              {limitItems.map((item) => {
                const key = limitKey(item);
                return (
                  <ReviewedInput
                    key={key}
                    label={`Choice limit: ${item.choice} (${item.fieldLabel}, ${item.formName})`}
                    type="number"
                    entry={choiceLimits[key] ?? blank}
                    noneLabel="No limit"
                    hint={`Last time: ${item.sourceLimit}.`}
                    onChange={(next) => setChoiceLimits((current) => ({ ...current, [key]: next }))}
                  />
                );
              })}
              {promoItems.map((promo) => {
                const window = promoWindows[promo.promoCodeId] ?? { startsOn: blank, endsOn: blank };
                const update = (side: "startsOn" | "endsOn", next: Reviewed) => setPromoWindows((current) => ({
                  ...current,
                  [promo.promoCodeId]: { ...(current[promo.promoCodeId] ?? { startsOn: blank, endsOn: blank }), [side]: next },
                }));
                return (
                  <div key={promo.promoCodeId} className="form-grid two-column clone-review-group">
                    <ReviewedInput label={`Promo code ${promo.code} starts`} type="date" entry={window.startsOn} noneLabel="No start date" hint={`Last time: ${promo.sourceStartsOn ?? "no start date"}. Copied inactive.`} onChange={(next) => update("startsOn", next)} />
                    <ReviewedInput label={`Promo code ${promo.code} ends`} type="date" entry={window.endsOn} noneLabel="No end date" hint={`Last time: ${promo.sourceEndsOn ?? "no end date"}.`} onChange={(next) => update("endsOn", next)} />
                  </div>
                );
              })}
              {honorItems.map((offering) => {
                const title = `${offering.honorName}${offering.sessionName ? ` (${offering.sessionName})` : ""}`;
                return (
                  <div key={offering.offeringId} className="form-grid two-column clone-review-group">
                    <label>Class capacity: {title}
                      <input inputMode="numeric" value={capacities[offering.offeringId] ?? ""} onChange={(event) => setCapacities((current) => ({ ...current, [offering.offeringId]: digits(event.target.value) }))} />
                      <small>Last time: {offering.sourceCapacity}. Minimum age carries over: {offering.minimumAge ?? "none"}.</small>
                    </label>
                    <ReviewedInput
                      label={`Per-club limit: ${title}`}
                      type="number"
                      entry={perClubLimits[offering.offeringId] ?? blank}
                      noneLabel="No per-club limit"
                      hint={`Last time: ${offering.sourcePerClubLimit ?? "none"}.`}
                      onChange={(next) => setPerClubLimits((current) => ({ ...current, [offering.offeringId]: next }))}
                    />
                  </div>
                );
              })}
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
