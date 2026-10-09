"use client";

import { classRequirementGaps } from "@/modules/honors/class-picker-view";
import type { ClubClassLevel } from "@/modules/club-rosters/domain";

type NotedOffering = Parameters<typeof classRequirementGaps>[0] & { id: string; honorName: string };

type NotedPerson = {
  firstName: string;
  lastName: string;
  consumesSeat: boolean;
  attendeeType: string | null;
  ageOnEventDate: number | null;
  classLevel?: ClubClassLevel | null;
  completedHonorIds?: readonly string[];
};

/**
 * Under a person's class choices (#832): what each class they picked asks of
 * them (a minimum class level, prerequisite honors) that the roster and honor
 * record don't show. The director ticks a confirmation, recorded with the seat;
 * staff acting as the director give a reason to place someone below a level. The
 * server checks and records both; this only collects them.
 */
export function ClassRequirementNotes({
  canConfirm,
  canOverride,
  confirmed,
  heldIds,
  offerings,
  onConfirmedChange,
  onReasonChange,
  person,
  reasons,
}: {
  /** False for a "Group" registration, which has no director to confirm anything. */
  canConfirm: boolean;
  /** True for staff acting as the director. */
  canOverride: boolean;
  confirmed: readonly string[];
  /** Classes the person already holds; they are never re-checked. */
  heldIds: readonly string[];
  /** The classes the person has picked. */
  offerings: readonly NotedOffering[];
  onConfirmedChange: (offeringId: string, checked: boolean) => void;
  onReasonChange: (offeringId: string, reason: string) => void;
  person: NotedPerson;
  reasons: Readonly<Record<string, string>>;
}) {
  const name = `${person.firstName} ${person.lastName}`.trim() || "this person";
  const rows = offerings
    .filter((offering) => !heldIds.includes(offering.id))
    .map((offering) => ({ offering, gaps: classRequirementGaps(offering, person) }))
    .filter((row) => row.gaps.length > 0);
  if (rows.length === 0) return null;
  return (
    <div className="class-requirement-notes" role="group" aria-label={`Class requirements for ${name}`}>
      {rows.map(({ offering, gaps }) => {
        const confirmable = gaps.filter((gap) => gap.confirmable);
        const hard = gaps.filter((gap) => !gap.confirmable);
        const checkboxId = `confirm-${offering.id}-${name.replace(/\W+/g, "-")}`;
        return (
          <div className="field-help" key={offering.id}>
            <p><strong translate="no">{offering.honorName}</strong> asks for {gaps.map((gap) => gap.requirement).join(" and ")}.</p>
            {confirmable.length > 0 && canConfirm && hard.length === 0 && (
              <label className="checkbox-row" htmlFor={checkboxId}>
                <input
                  checked={confirmed.includes(offering.id)}
                  id={checkboxId}
                  onChange={(event) => onConfirmedChange(offering.id, event.target.checked)}
                  type="checkbox"
                />
                <span>
                  I confirm <span translate="no">{name}</span> meets this ({confirmable.map((gap) => gap.requirement).join("; ")}).
                  {" "}
                  {confirmable.some((gap) => gap.kind === "LEVEL_MISSING") ? "Their class level isn't on the roster. " : ""}
                  {confirmable.some((gap) => gap.kind === "HONORS_MISSING") ? "No completed honor record was found. " : ""}
                  This is recorded.
                </span>
              </label>
            )}
            {canOverride && (
              <label>
                Reason staff are placing <span translate="no">{name}</span> without this requirement
                <input
                  maxLength={300}
                  onChange={(event) => onReasonChange(offering.id, event.target.value)}
                  placeholder="Recorded in the audit log"
                  type="text"
                  value={reasons[offering.id] ?? ""}
                />
                <small className="field-help">Don&apos;t include medical or personal details.</small>
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}
