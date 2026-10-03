/**
 * Synthetic values for verification harnesses that run in their own process.
 *
 * A harness needs a few secrets to exist (an encryption key, a mail placeholder)
 * but must never depend on, or leak, real configuration. `??=` only fills a
 * variable that is null or undefined, so a blank `SECRET_ENCRYPTION_KEY=` in
 * `.env` slipped through as an empty key. This fills a variable that is unset,
 * empty, or only whitespace, and fails loudly if it is still blank afterwards.
 *
 * The values are fictitious, set on this process only (never written to a
 * file), and a real value already configured is left alone.
 */
type Env = Record<string, string | undefined>;

export function fillBlankSyntheticEnv(name: string, value: string, env: Env = process.env) {
  if (!value.trim()) throw new Error(`The synthetic value for ${name} must not be blank.`);
  if (!env[name]?.trim()) env[name] = value;
  if (!env[name]?.trim()) throw new Error(`${name} is empty after filling the synthetic test value.`);
}
