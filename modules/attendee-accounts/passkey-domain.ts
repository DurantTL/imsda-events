/**
 * Attendee-specific passkey rules. Signature checks are never done here: the
 * WebAuthn library verifies every ceremony.
 *
 * The parts that don't depend on the attendee principal (relying-party
 * matching, challenge lifetime, naming) live in `modules/passkeys/domain.ts`
 * and are re-exported here unchanged, so staff passkeys
 * (`modules/access/passkeys.ts`) reuse the same rules instead of copying them.
 */
export { PASSKEY_CHALLENGE_MINUTES, isValidRelyingPartyId, matchRelyingParty, passkeyNameFrom } from "@/modules/passkeys/domain";

/** How recently this session must have passed a second step to add or remove a passkey. */
export const PASSKEY_CHANGE_WINDOW_HOURS = 12;

/** Whether a session's last second-step check is recent enough to change passkeys. */
export function hasRecentSecondFactor(verifiedAt: Date | null | undefined, now: Date) {
  return Boolean(verifiedAt) && now.getTime() - verifiedAt!.getTime() <= PASSKEY_CHANGE_WINDOW_HOURS * 3_600_000;
}
