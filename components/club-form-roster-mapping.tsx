"use client";

import { blankRosterMapping, setRosterMapping } from "@/components/club-form-builder-state";
import type { BuilderIssue, ClubFormDraftSpec } from "@/modules/club-forms/builder-domain";
import {
  rosterFieldTargets,
  rosterMappingCandidates,
  rosterTargetLabels,
  type GuardianMappingPart,
  type RosterMapping,
  type RosterMappingFieldTarget,
} from "@/modules/club-forms/roster-mapping";
import { GUARDIAN_SLOTS } from "@/modules/club-rosters/guardians-domain";

/**
 * The "Allow adding to the roster" setting of the club form builder (#721).
 * The choices offered for each roster field are only the questions the
 * protection rules allow: a birth date can only come from a question marked
 * as a birth date, and sensitive and health questions are never offered. The
 * server checks the mapping again on save and publish.
 */

type Mutator = (spec: ClubFormDraftSpec) => ClubFormDraftSpec;

const partLabels: Record<GuardianMappingPart, string> = { name: "Name", relationship: "Relationship", email: "Email", phone: "Cell phone" };

export function ClubFormRosterMapping({ spec, edit, issues }: { spec: ClubFormDraftSpec; edit: (change: Mutator) => void; issues: BuilderIssue[] }) {
  const mapping = spec.rosterMapping;
  const enabled = Boolean(mapping?.enabled);
  const update = (change: (current: RosterMapping) => RosterMapping) => edit((s) => setRosterMapping(s, change(s.rosterMapping ?? blankRosterMapping())));

  function setField(target: RosterMappingFieldTarget, key: string) {
    update((current) => {
      const fields = { ...current.fields };
      if (key) fields[target] = key;
      else delete fields[target];
      return { ...current, fields };
    });
  }

  function setGuardian(index: number, part: GuardianMappingPart | "relationshipLabel", value: string) {
    update((current) => {
      const guardians = Array.from({ length: GUARDIAN_SLOTS }, (_, slot) => ({ ...(current.guardians[slot] ?? {}) }));
      const next = { ...guardians[index] } as Record<string, string | undefined>;
      if (value) next[part] = value;
      else delete next[part];
      guardians[index] = next;
      // Slot positions stay put; only empty slots at the end are dropped.
      while (guardians.length > 0 && Object.keys(guardians[guardians.length - 1]).length === 0) guardians.pop();
      return { ...current, guardians };
    });
  }

  const select = (label: string, value: string | undefined, candidates: ReturnType<typeof rosterMappingCandidates>, onChange: (key: string) => void) => (
    <label key={label}>{label}
      <select onChange={(event) => onChange(event.target.value)} value={value ?? ""}>
        <option value="">Not used</option>
        {value && !candidates.some((field) => field.key === value) && <option value={value}>{value} (not allowed)</option>}
        {candidates.map((field) => <option key={field.key} value={field.key}>{field.label || field.key}</option>)}
      </select>
    </label>
  );

  return (
    <section className="panel form-stack" aria-labelledby="roster-mapping-title">
      <h3 id="roster-mapping-title">Add to the club roster</h3>
      <p className="field-help">
        When this is on, a club&apos;s director or deputy sees <strong>Add to roster</strong> on a submitted form. It opens a review screen
        pre-filled from the questions you choose here, and nothing is added until they confirm. Birth dates stay sealed, sensitive and health
        questions can never be chosen, and the Health Record is never filled from a form.
      </p>
      <label className="checkbox-label">
        <input
          checked={enabled}
          onChange={(event) => update((current) => ({ ...current, enabled: event.target.checked }))}
          type="checkbox"
        /> Allow adding to the roster
      </label>
      {issues.map((issue, index) => <small className="club-report-problem" key={index} role="alert">{issue.message}</small>)}
      {mapping && (
        <div className="form-stack">
          <label>Add people as
            <select
              onChange={(event) => update((current) => ({ ...current, rosterType: event.target.value === "STAFF" ? "STAFF" : "YOUTH" }))}
              value={mapping.rosterType}
            >
              <option value="YOUTH">Youth member</option>
              <option value="STAFF">Staff</option>
            </select>
          </label>
          <div className="form-grid two-column">
            {rosterFieldTargets
              .filter((target) => !(mapping.rosterType === "STAFF" && target === "classLevel"))
              .map((target) => select(rosterTargetLabels[target], mapping.fields[target], rosterMappingCandidates(target, spec), (key) => setField(target, key)))}
          </div>
          {mapping.rosterType === "YOUTH" && Array.from({ length: GUARDIAN_SLOTS }, (_, index) => (
            <fieldset className="form-stack" key={index}>
              <legend>Guardian {index + 1} (optional)</legend>
              <div className="form-grid two-column">
                {(["name", "email", "phone"] as const).map((part) => select(
                  partLabels[part],
                  mapping.guardians[index]?.[part],
                  rosterMappingCandidates(`guardian.${part}`, spec),
                  (key) => setGuardian(index, part, key),
                ))}
                {select(
                  "Relationship (from a question)",
                  mapping.guardians[index]?.relationship,
                  rosterMappingCandidates("guardian.relationship", spec),
                  (key) => setGuardian(index, "relationship", key),
                )}
                <label>Or a fixed relationship
                  <input
                    maxLength={60}
                    onChange={(event) => setGuardian(index, "relationshipLabel", event.target.value)}
                    placeholder="e.g. Mother or guardian"
                    value={mapping.guardians[index]?.relationshipLabel ?? ""}
                  />
                </label>
              </div>
            </fieldset>
          ))}
        </div>
      )}
    </section>
  );
}
