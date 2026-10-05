import {
  CLUB_REGISTRATION_NOT_A_DIRECTOR_MESSAGE,
  clubRegistrationEntryPath,
} from "@/modules/club-registrations/entry-path";

/**
 * Club-audience notices (#799 G7, G8).
 *
 * Two kinds, kept apart on purpose:
 *
 * - The club-director sign-in notice is the one club notice that IS public: it
 *   is how a director who landed on a club event's public page finds the club
 *   door instead of registering as an individual. It is shown only on events
 *   with a club audience (`clubDirectorSignInNotice`).
 * - Everything else addressed to clubs (`CLUB_ONLY_NOTICES`) belongs to the
 *   signed-in club portal and must never reach a signed-out or public page.
 *   The regression test renders the public pages for a published club event
 *   and fails if any of these strings appears.
 */

export const CLUB_DIRECTOR_SIGN_IN_TITLE = "Club directors: sign in to register your club";
export const CLUB_DIRECTOR_SIGN_IN_BODY =
  "Do not register your club as individuals. Sign in with your club account and your roster is ready to choose from. After you sign in you come straight back to this event.";
export const CLUB_DIRECTOR_SIGN_IN_BUTTON = "Sign in to register your club";

/** The notice for a public page of this event, or null when it is not a club event. */
export function clubDirectorSignInNotice(event: { audience: "GENERAL" | "CLUB" | string; slug: string }) {
  if (event.audience !== "CLUB") return null;
  return {
    title: CLUB_DIRECTOR_SIGN_IN_TITLE,
    body: CLUB_DIRECTOR_SIGN_IN_BODY,
    buttonLabel: CLUB_DIRECTOR_SIGN_IN_BUTTON,
    // Signed-out visitors are sent to club sign-in by the account portal and come back here afterwards.
    href: clubRegistrationEntryPath(event.slug),
  };
}

/**
 * Club-only wording that must stay in the signed-in club context. Plain text
 * only; the test looks for each string in the rendered public pages.
 */
export const CLUB_ONLY_NOTICES: readonly string[] = [
  CLUB_REGISTRATION_NOT_A_DIRECTOR_MESSAGE,
  "Your club is registered",
  "Your club is already registered for this event.",
  "Billed to your church. No payment is taken online.",
  "Not open for clubs yet",
  "Class choices are closed.",
];
