/**
 * Why a member's card on the club registration form "needs attention" (#853),
 * and how to fix it. Pure and client-safe. These only explain; the server's
 * save rules are unchanged, and a background check never blocks a submission.
 */
import type { ClubComplianceState } from "@/modules/background-checks/display";
import type { PersonClassReadiness } from "@/modules/honors/class-readiness";

/** `advisory` items are shown as a note and never take away "Complete". */
export type AttentionItem = { reason: string; fix: string; advisory?: boolean };

function joinLabels(labels: readonly string[]) {
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** Required questions still unanswered: names them and says where to answer. */
export function missingAnswersAttention(labels: readonly string[]): AttentionItem[] {
  if (labels.length === 0) return [];
  return [{
    reason: `Answer needed: ${joinLabels(labels)}`,
    fix: "Open this card and answer the highlighted questions.",
  }];
}

/** Carried-over roster values that didn't match a form option. */
export function carryoverAttention(count: number): AttentionItem[] {
  if (count <= 0) return [];
  return [{
    reason: count === 1 ? "A roster value didn't match the form" : `${count} roster values didn't match the form`,
    fix: "Open this card and pick the right option.",
  }];
}

/** A youth member who still owes a class for a session they can take. */
export function classAttention(person: Pick<PersonClassReadiness, "required" | "missing"> | undefined): AttentionItem[] {
  if (!person || !person.required || person.missing.length === 0) return [];
  return [{
    reason: `Class needed for ${joinLabels(person.missing.map((entry) => entry.sessionName))}`,
    fix: "Choose a class under Classes in this card.",
  }];
}

/** A staff or adult member without a current Sterling Volunteers check. Advisory: nothing is blocked. */
export function backgroundCheckAttention(state: ClubComplianceState | null | undefined): AttentionItem[] {
  if (state === "NO_RECORD") {
    return [{ reason: "Background check needed", fix: "Ask them to complete a Sterling Volunteers check; your roster updates when it is on file. You can still register them." }];
  }
  if (state === "NOT_COMPLIANT") {
    return [{ reason: "Background check expired or not in compliance", fix: "Ask them to renew their Sterling Volunteers check. You can still register them." }];
  }
  if (state === "FLAGGED") {
    return [{ reason: "Background check expiring soon", fix: "Ask them to renew their Sterling Volunteers check before it expires.", advisory: true }];
  }
  return [];
}
