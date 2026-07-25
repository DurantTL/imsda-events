import { createHash } from "node:crypto";
import { getServerEnv } from "@/lib/env";
import { logWarn } from "@/lib/logger";

/**
 * The live half of the password policy: is this exact password already in a
 * public breach corpus?
 *
 * The password never leaves the process. Only the first five hex characters of
 * its SHA-1 are sent — a bucket shared with roughly 800 other hashes — and the
 * remaining 35 are compared against the returned list locally. That is the
 * k-anonymity range protocol the corpus publishes for exactly this use.
 *
 * SHA-1 here is not protecting anything: it is the corpus's index. Stored
 * credentials are scrypt, in `passwords.ts`.
 *
 * **The check fails open.** A password set is the last step of activation and
 * of every recovery; refusing to complete it because a third-party API is
 * unreachable would lock people out to prevent a weaker password. An outage is
 * logged and the offline rules still apply.
 */

export const BREACH_CHECK_TIMEOUT_MS = 3000;

export type BreachCheckResult = {
  /** False when the corpus could not be consulted. */
  checked: boolean;
  breached: boolean;
  /** How many times the corpus has seen it, when known. */
  occurrences?: number;
};

export function isBreachCheckEnabled() {
  const env = getServerEnv();
  if (env.PASSWORD_BREACH_CHECK) return env.PASSWORD_BREACH_CHECK === "enabled";
  // Unset: on in production, off elsewhere, so local work and CI do not depend
  // on reaching a third party.
  return env.NODE_ENV === "production";
}

function parseRange(body: string, suffix: string) {
  for (const line of body.split("\n")) {
    const [candidate, count] = line.trim().split(":");
    if (candidate?.toUpperCase() === suffix) {
      const occurrences = Number.parseInt(count ?? "", 10);
      return { breached: true, occurrences: Number.isFinite(occurrences) ? occurrences : undefined };
    }
  }
  return { breached: false };
}

export async function checkPasswordAgainstBreachCorpus(
  password: string,
  options: { fetchImpl?: typeof fetch; enabled?: boolean } = {},
): Promise<BreachCheckResult> {
  const enabled = options.enabled ?? isBreachCheckEnabled();
  if (!enabled) return { checked: false, breached: false };

  const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);
  const endpoint = new URL(prefix, getServerEnv().PASSWORD_BREACH_CHECK_URL).toString();

  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "GET",
      headers: {
        // Pads the response with decoy hashes so its size reveals nothing.
        "Add-Padding": "true",
        "User-Agent": "imsda-events-password-policy",
      },
      signal: AbortSignal.timeout(BREACH_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      logWarn("The breach corpus could not be consulted; the password was accepted on the offline rules alone.", {
        status: response.status,
      });
      return { checked: false, breached: false };
    }
    const result = parseRange(await response.text(), suffix);
    return { checked: true, ...result };
  } catch (error) {
    // Deliberately not logError: this is an availability event about a third
    // party, and the error carries nothing worth recording beyond its class.
    logWarn("The breach corpus could not be reached; the password was accepted on the offline rules alone.", {
      error: error instanceof Error ? error.name : typeof error,
    });
    return { checked: false, breached: false };
  }
}
