/**
 * Whether to offer the "Create an optional account to manage future
 * registrations" panel (#854). It is for a signed-out registrant. Someone
 * already signed in (a club director or an attendee account) has an account,
 * and a club's own registration is managed from the club portal. A "Group"
 * contact has no club portal, so the offer stays for them: it is their only
 * route to an account.
 */
export function accountPromptVisible(input: { signedIn: boolean; clubRegistration: boolean }): boolean {
  return !input.signedIn && !input.clubRegistration;
}
