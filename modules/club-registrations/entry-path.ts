/**
 * Where a public event page sends a club roster registration (#720): one
 * signed-in door that finds the director's club and opens that club's
 * registration for the event. Signed-out visitors are sent to club sign-in by
 * the account portal layout and come back here afterwards.
 */
export function clubRegistrationEntryPath(eventSlug: string) {
  return `/account/club-registration/${encodeURIComponent(eventSlug)}`;
}

/** What a visitor who holds no club role is told. */
export const CLUB_REGISTRATION_NOT_A_DIRECTOR_MESSAGE =
  "This registration is for club directors, deputies, and registrars. Your account does not hold one of those roles for a club.";

/** The note on a public event card that opens club registration. */
export const CLUB_REGISTRATION_CARD_NOTE =
  "For club directors. Sign in with your club account and we will bring you back to this registration.";
