/**
 * Whether to offer the "Create an optional account to manage future
 * registrations" panel (#854). It is for a signed-out visitor registering for
 * a regular event: someone already signed in (a club director or an attendee
 * account) has an account, and a club event's registrations (a club's, or a
 * "Group" on a club event) are managed from the club portal.
 */
export function accountPromptVisible(input: { signedIn: boolean; clubEvent: boolean }): boolean {
  return !input.signedIn && !input.clubEvent;
}
