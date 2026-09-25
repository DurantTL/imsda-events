/**
 * Who has to carry a second factor.
 *
 * Pure, so the rule can be stated once and tested without a database.
 * Decision 2026-09-25 (issue #456): two-step sign-in is required of every
 * staff account that holds any ACTIVE event membership, of any role, plus
 * every `SYSTEM_ADMIN` — not only `EVENT_ADMIN` and `SYSTEM_ADMIN` as before.
 * A staff account with no active membership at all (not yet assigned to an
 * event, or removed from every one) stays on the password alone.
 */

export type MfaSubject = {
  globalRole: "SYSTEM_ADMIN" | null;
  /** The roles of this account's *active* memberships. */
  activeEventRoles: readonly string[];
};

export function requiresMfa(subject: MfaSubject) {
  if (subject.globalRole === "SYSTEM_ADMIN") return true;
  return subject.activeEventRoles.length > 0;
}

export type MfaGate =
  /** No second factor is expected; sign-in completes on the password alone. */
  | { kind: "not_required" }
  /** Enrolled and confirmed: a code is required to finish signing in. */
  | { kind: "challenge" }
  /**
   * Required by role but never enrolled. Sign-in cannot complete until it is,
   * so no session ever exists for a privileged account without a second factor.
   */
  | { kind: "enrol" };

export function mfaGateFor(
  subject: MfaSubject,
  enrollment: { status: "PENDING" | "ACTIVE" } | null,
): MfaGate {
  if (enrollment?.status === "ACTIVE") return { kind: "challenge" };
  if (requiresMfa(subject)) return { kind: "enrol" };
  return { kind: "not_required" };
}
