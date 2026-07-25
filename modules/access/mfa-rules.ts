/**
 * Who has to carry a second factor.
 *
 * Pure, so the rule can be stated once and tested without a database. The
 * review's line was that MFA is "not optional for accounts that can export a
 * full attendee roster" — that is `SYSTEM_ADMIN`, who can do everything in
 * every event, and `EVENT_ADMIN`, who can export registrations and manage staff
 * in one.
 */

export type MfaSubject = {
  globalRole: "SYSTEM_ADMIN" | null;
  /** The roles of this account's *active* memberships. */
  activeEventRoles: readonly string[];
};

/**
 * Widening this is a one-line change, and there is a case for it:
 * `REGISTRATION_MANAGER` and `FINANCE_MANAGER` also hold `VIEW_REPORTS` and
 * `VIEW_SENSITIVE_DATA`, so they can export a roster with medical answers in it
 * too. It is deliberately left at the two roles the review named, because every
 * role added here is a role that can be locked out of an event by a lost phone —
 * that is a decision for whoever runs the event, not a default.
 */
export const MFA_REQUIRED_EVENT_ROLES: ReadonlySet<string> = new Set(["EVENT_ADMIN"]);

export function requiresMfa(subject: MfaSubject) {
  if (subject.globalRole === "SYSTEM_ADMIN") return true;
  return subject.activeEventRoles.some((role) => MFA_REQUIRED_EVENT_ROLES.has(role));
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
