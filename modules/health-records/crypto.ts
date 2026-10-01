import "server-only";

import { openSecret, sealSecret } from "@/lib/secret-box";
import { HealthRecordError } from "@/modules/health-records/errors";

/**
 * The only place a health field is sealed or opened (#611). Each field is its
 * own ciphertext under its own key purpose, which names the record and the
 * field, so a sealed value copied to another record or another field cannot
 * be opened there (the same idea as `club-forms/sealed-answers.ts`).
 */
function purposeFor(recordId: string, fieldKey: string) {
  return `health-record:${recordId}:${fieldKey}`;
}

export function sealHealthField(recordId: string, fieldKey: string, value: unknown) {
  return sealSecret(JSON.stringify(value), purposeFor(recordId, fieldKey));
}

/** An unreadable value is an error with a fixed message, never the ciphertext or a partial value. */
export function openHealthField(recordId: string, fieldKey: string, sealed: string): unknown {
  try {
    return JSON.parse(openSecret(sealed, purposeFor(recordId, fieldKey))) as unknown;
  } catch {
    throw new HealthRecordError("UNREADABLE", "A health record could not be read. Ask a system administrator to check the encryption key.");
  }
}
