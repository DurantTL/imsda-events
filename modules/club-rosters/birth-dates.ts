import "server-only";

import { openSecret, sealSecret } from "@/lib/secret-box";

/**
 * The only place roster birth dates are sealed or opened (ADR 0005 Addendum
 * A). The purpose string gives them their own derived key.
 */
const BIRTH_DATE_PURPOSE = "club-roster:birth-date";

export function sealBirthDate(birthDate: string) {
  return sealSecret(birthDate, BIRTH_DATE_PURPOSE);
}

export function openBirthDate(sealed: string) {
  return openSecret(sealed, BIRTH_DATE_PURPOSE);
}
