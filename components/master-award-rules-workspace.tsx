"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, FileUp, Plus, Trash2, Trophy, X } from "lucide-react";
import styles from "@/components/club-supplies.module.css";
import ruleStyles from "@/components/master-award-rules.module.css";
import { masterAwardStatusLabels } from "@/modules/earned-awards/domain";
import type { MasterAwardImportPlan } from "@/modules/earned-awards/master-award-import";
import type { MasterAwardRuleRecord } from "@/modules/earned-awards/rules-repository";

export type RuleChoices = {
  honors: Array<{ id: string; name: string }>;
  items: Array<{ id: string; name: string }>;
};

type ImportResponse = Partial<MasterAwardImportPlan> & {
  fingerprint?: string;
  plan?: MasterAwardImportPlan;
  rules?: MasterAwardRuleRecord[];
  error?: string;
  message?: string;
  issues?: Array<{ message?: string }>;
};

type Preview = { json: string; plan: MasterAwardImportPlan; fingerprint: string };

type DraftGroup = { minimum: number; honors: Array<{ id: string; name: string }>; unmatchedHonorNames: string[] };

function draftGroups(rule: MasterAwardRuleRecord): DraftGroup[] {
  return rule.groups.map((group) => ({ minimum: group.minimum, honors: group.honors, unmatchedHonorNames: group.unmatchedHonorNames }));
}

/**
 * One rule's review form (#532): its honor groups (minimum and honor list),
 * catalog item and note, then save, activate or deactivate. A rule flagged for
 * a manual check can only be activated after the administrator ticks that they
 * checked it against the official requirements.
 */
function RuleEditor({
  rule,
  choices,
  onSaved,
}: {
  rule: MasterAwardRuleRecord;
  choices: RuleChoices;
  onSaved: (rules: MasterAwardRuleRecord[], message: string) => void;
}) {
  const [groups, setGroups] = useState<DraftGroup[]>(() => draftGroups(rule));
  const [itemId, setItemId] = useState(rule.itemId ?? "");
  const [note, setNote] = useState(rule.reviewNote);
  const [checked, setChecked] = useState(!rule.needsManualCheck);
  const [adding, setAdding] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const listId = `master-award-honors-${rule.id}`;

  function addHonor(index: number) {
    const text = (adding[index] ?? "").trim().toLowerCase();
    const honor = choices.honors.find((entry) => entry.name.toLowerCase() === text);
    if (!honor) {
      setError("Choose an honor from the list.");
      return;
    }
    setError("");
    setGroups((current) => current.map((group, position) => (position === index && !group.honors.some((entry) => entry.id === honor.id)
      ? { ...group, honors: [...group.honors, honor].sort((a, b) => a.name.localeCompare(b.name)) }
      : group)));
    setAdding((current) => ({ ...current, [index]: "" }));
  }

  async function save(status?: "ACTIVE" | "INACTIVE") {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/master-award-rules/${encodeURIComponent(rule.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groups: groups.map((group) => ({ minimum: group.minimum, honorIds: group.honors.map((honor) => honor.id) })),
          itemId: itemId || null,
          reviewNote: note,
          ...(rule.needsManualCheck && checked ? { needsManualCheck: false } : {}),
          ...(status ? { status } : {}),
        }),
      });
      const result = await response.json().catch(() => ({})) as ImportResponse;
      if (!response.ok || !result.rules) throw new Error(result.message ?? result.issues?.[0]?.message ?? "The rule could not be saved.");
      onSaved(result.rules, status === "ACTIVE" ? `${rule.name} is active.` : status === "INACTIVE" ? `${rule.name} is inactive.` : `${rule.name} saved.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The rule could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={ruleStyles.editor}>
      {rule.problems.length > 0 && rule.status !== "ACTIVE" && (
        <ul className={ruleStyles.problems}>
          {rule.problems.map((problem) => <li key={problem}>{problem}</li>)}
        </ul>
      )}
      {rule.groups.some((group) => group.unmatchedHonorNames.length > 0) && (
        <p className={ruleStyles.flag} role="status">
          <AlertTriangle aria-hidden="true" size={14} /> Some honors in the club&apos;s sheet matched nothing in the honor list. Add the right honor to the group, or leave them out.
        </p>
      )}
      {groups.map((group, index) => (
        <fieldset className={ruleStyles.group} key={index}>
          <legend>Group {index + 1}</legend>
          <label className={ruleStyles.field}>
            <span>Minimum honors needed</span>
            <input
              inputMode="numeric"
              min={1}
              onChange={(event) => setGroups((current) => current.map((entry, position) => (position === index ? { ...entry, minimum: Number(event.target.value) || 0 } : entry)))}
              type="number"
              value={group.minimum}
            />
          </label>
          <ul className={ruleStyles.chips}>
            {group.honors.map((honor) => (
              <li key={honor.id}>
                <span translate="no">{honor.name}</span>
                <button
                  aria-label={`Remove ${honor.name} from group ${index + 1}`}
                  onClick={() => setGroups((current) => current.map((entry, position) => (position === index ? { ...entry, honors: entry.honors.filter((other) => other.id !== honor.id) } : entry)))}
                  type="button"
                >
                  <X aria-hidden="true" size={14} />
                </button>
              </li>
            ))}
          </ul>
          {group.unmatchedHonorNames.length > 0 && (
            <p className={ruleStyles.unmatched}>No match in the honor list: {group.unmatchedHonorNames.join(", ")}</p>
          )}
          <div className={ruleStyles.addRow}>
            <label className={ruleStyles.field}>
              <span>Add an honor</span>
              <input
                list={listId}
                onChange={(event) => setAdding((current) => ({ ...current, [index]: event.target.value }))}
                placeholder="Start typing an honor name"
                value={adding[index] ?? ""}
              />
            </label>
            <button className="secondary-button" onClick={() => addHonor(index)} type="button"><Plus aria-hidden="true" size={14} /> Add</button>
            {groups.length > 1 && (
              <button className="secondary-button" onClick={() => setGroups((current) => current.filter((_, position) => position !== index))} type="button">
                <Trash2 aria-hidden="true" size={14} /> Remove group
              </button>
            )}
          </div>
        </fieldset>
      ))}
      <datalist id={listId}>
        {choices.honors.map((honor) => <option key={honor.id} value={honor.name} />)}
      </datalist>
      <div className={styles.actions}>
        <button className="secondary-button" onClick={() => setGroups((current) => [...current, { minimum: 1, honors: [], unmatchedHonorNames: [] }])} type="button">
          <Plus aria-hidden="true" size={14} /> Add a group
        </button>
      </div>
      <label className={ruleStyles.field}>
        <span>Catalog item (the award&apos;s patch)</span>
        <select onChange={(event) => setItemId(event.target.value)} value={itemId}>
          <option value="">Not linked</option>
          {choices.items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label className={ruleStyles.field}>
        <span>Review note</span>
        <textarea maxLength={1000} onChange={(event) => setNote(event.target.value)} rows={2} value={note} />
      </label>
      {rule.needsManualCheck && (
        <label className={ruleStyles.check}>
          <input checked={checked} onChange={(event) => setChecked(event.target.checked)} type="checkbox" />
          <span>I checked this rule against the official requirements.</span>
        </label>
      )}
      {error && <p className="inline-notice error" role="alert">{error}</p>}
      <div className={styles.actions}>
        <button className="secondary-button" disabled={busy} onClick={() => save()} type="button">Save changes</button>
        {rule.status !== "ACTIVE" ? (
          <button className="primary-button" disabled={busy || !checked} onClick={() => save("ACTIVE")} type="button">
            <CheckCircle2 aria-hidden="true" size={16} /> Save and activate
          </button>
        ) : (
          <button className="secondary-button" disabled={busy} onClick={() => save("INACTIVE")} type="button">Deactivate</button>
        )}
      </div>
    </div>
  );
}

/**
 * Staff page for Master Award rules (#532), system administrators only:
 * import the reviewed rules file (dry run first, nothing saved until the
 * preview is confirmed), then review, edit and activate each rule one by one.
 * Imported rules are drafts; only active rules are used for club progress.
 */
export function MasterAwardRulesWorkspace({ initialRules, choices }: { initialRules: MasterAwardRuleRecord[]; choices: RuleChoices }) {
  const [rules, setRules] = useState(initialRules);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function send(body: Record<string, unknown>) {
    const response = await fetch("/api/admin/master-award-rules/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { response, result: await response.json().catch(() => ({})) as ImportResponse };
  }

  async function chooseFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const json = await file.text();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { response, result } = await send({ json, confirm: false });
      if (!response.ok || !result.steps || !result.summary || !result.fingerprint) {
        throw new Error(result.message ?? result.issues?.[0]?.message ?? "That file couldn't be read.");
      }
      setPreview({ json, fingerprint: result.fingerprint, plan: { steps: result.steps, summary: result.summary, unmatched: result.unmatched ?? [] } });
    } catch (caught) {
      setPreview(null);
      setError(caught instanceof Error ? caught.message : "That file couldn't be read.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const { response, result } = await send({ json: preview.json, confirm: true, fingerprint: preview.fingerprint });
      if (!response.ok || !result.rules || !result.plan) throw new Error(result.message ?? "The rules could not be saved.");
      setRules(result.rules);
      setNotice(`Imported ${result.plan.summary.added} rule${result.plan.summary.added === 1 ? "" : "s"} as drafts. Review and activate each one below.`);
      setPreview(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The rules could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const counts: Array<[string, number]> = preview ? [
    ["Rules to add", preview.plan.summary.added],
    ["Already on file", preview.plan.summary.existing],
    ["Need a manual check", preview.plan.summary.needsManualCheck],
    ["Honors matched", preview.plan.summary.honorsMatched],
    ["Honors unmatched", preview.plan.summary.honorsUnmatched],
  ] : [];

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Club ministries</p>
          <h2>Master Award rules</h2>
          <p>
            Each rule has honor groups with a minimum; the award is earned when every group reaches its minimum.
            Rules come from the club&apos;s spreadsheet, so review each one, then activate it. Clubs see progress only
            for active rules.
          </p>
        </div>
      </div>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Import</p>
            <h2>Import rules as drafts</h2>
          </div>
        </div>
        <p className="field-help">
          Upload <code>docs/reference/master-award-rules.json</code>. Rules already on file are never changed. Honors are
          matched to the honor list by name; the preview lists any that don&apos;t match. Nothing is saved until you confirm.
        </p>
        <div className={styles.actions}>
          <label className={`secondary-button ${styles.upload}`}>
            <FileUp aria-hidden="true" size={14} /> {busy && !preview ? "Reading…" : "Upload rules file"}
            <input accept=".json,application/json" disabled={busy} onChange={chooseFile} type="file" />
          </label>
        </div>
      </section>

      {preview && (
        <section aria-labelledby="master-award-preview" className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Dry run</p>
              <h2 id="master-award-preview">What this import would do</h2>
            </div>
          </div>
          <ul className={styles.counts}>
            {counts.map(([label, value]) => <li key={label}><strong>{value}</strong><span>{label}</span></li>)}
          </ul>
          <ul className={ruleStyles.steps}>
            {preview.plan.steps.map((step) => (
              <li key={step.normalizedName}>
                <strong translate="no">{step.name}</strong>
                <small>{step.action === "ADD" ? "Will be added as a draft" : "Already on file: left as it is"}{step.itemId ? "" : " · no catalog item found"}</small>
                {step.action === "ADD" && step.reasons.map((reason) => (
                  <small className={ruleStyles.reason} key={reason}><AlertTriangle aria-hidden="true" size={12} /> {reason}</small>
                ))}
              </li>
            ))}
          </ul>
          {preview.plan.unmatched.length > 0 && (
            <>
              <h3 className={ruleStyles.subhead}>Honors that matched nothing ({preview.plan.unmatched.length})</h3>
              <ul className={ruleStyles.unmatchedList}>
                {preview.plan.unmatched.map((entry) => <li key={`${entry.award}:${entry.honor}`}><span translate="no">{entry.honor}</span> <small>in {entry.award}</small></li>)}
              </ul>
            </>
          )}
          <div className={styles.actions}>
            <button className="primary-button" disabled={busy || preview.plan.summary.added === 0} onClick={confirm} type="button">
              <CheckCircle2 aria-hidden="true" size={16} /> {busy ? "Saving…" : `Save ${preview.plan.summary.added} draft rule${preview.plan.summary.added === 1 ? "" : "s"}`}
            </button>
            <button className="text-button" disabled={busy} onClick={() => setPreview(null)} type="button">Cancel</button>
          </div>
        </section>
      )}

      <section className="panel" aria-labelledby="master-award-rule-list">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Rules</p>
            <h2 id="master-award-rule-list"><Trophy aria-hidden="true" size={16} /> Review and activate ({rules.length})</h2>
          </div>
        </div>
        {rules.length === 0 ? (
          <p className="quiet-copy">No rules yet. Import the rules file above.</p>
        ) : (
          <ul className={ruleStyles.rules}>
            {rules.map((rule) => (
              <li key={rule.id}>
                <details>
                  <summary>
                    <span translate="no"><strong>{rule.name}</strong></span>
                    <span className={ruleStyles.badges}>
                      <span className={`${ruleStyles.badge} ${ruleStyles[rule.status]}`}>{masterAwardStatusLabels[rule.status]}</span>
                      {rule.needsManualCheck && <span className={`${ruleStyles.badge} ${ruleStyles.check_flag}`}>Manual check</span>}
                    </span>
                  </summary>
                  <p className="field-help">
                    {rule.groups.map((group) => `${group.minimum} of ${group.honors.length + group.unmatchedHonorNames.length}`).join(" + ")}
                    {rule.itemName ? ` · ${rule.itemName}` : " · no catalog item linked"}
                  </p>
                  <RuleEditor
                    choices={choices}
                    key={JSON.stringify([rule.groups, rule.itemId, rule.status, rule.needsManualCheck])}
                    onSaved={(next, message) => { setRules(next); setNotice(message); setError(""); }}
                    rule={rule}
                  />
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
