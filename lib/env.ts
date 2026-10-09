import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * The single description of every variable this application reads.
 *
 * Individual modules keep their own checks (`getRateLimitConfiguration`,
 * `configuredSecrets`, `registrationLinkSigningSecret`) as belt and braces —
 * they run at first use and can be exercised in isolation. This schema exists
 * so that a deployment which is missing one of those values fails at startup
 * instead of on check-in morning.
 */

const SECRET_MIN_LENGTH = 32;

const optionalTrimmed = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url().startsWith("postgresql://"),
    APP_BASE_URL: z.string().url().default("http://localhost:3000"),
    APP_RELEASE_SHA: optionalTrimmed,

    // Where uploaded event files are written. A deployment points this at a
    // mounted volume so uploads outlive the container that received them.
    ASSET_STORAGE_DIR: optionalTrimmed,

    // Derives retry-stable private registration links without storing raw tokens.
    MANAGE_LINK_DERIVATION_SECRET: optionalTrimmed,
    MANAGE_LINK_DERIVATION_SECRET_PREVIOUS: optionalTrimmed,

    // Signs stateless attendee QR passes.
    ATTENDEE_PASS_SIGNING_SECRET: optionalTrimmed,
    ATTENDEE_PASS_SIGNING_SECRET_PREVIOUS: optionalTrimmed,

    // Keyed one-way request identifiers for durable abuse protection.
    RATE_LIMIT_HASH_SECRET: optionalTrimmed,
    RATE_LIMIT_TRUSTED_PROXY_HOPS: z
      .string()
      .trim()
      .regex(/^\d+$/, "must be a whole number from 0 through 10")
      .transform(Number)
      .refine((value) => value <= 10, "must be a whole number from 0 through 10")
      .default(0),
    RATE_LIMIT_CLIENT_IP_HEADER: z
      .enum(["x-forwarded-for", "x-real-ip", "cf-connecting-ip"])
      .default("x-forwarded-for"),

    EMBED_ALLOWED_ORIGINS: optionalTrimmed,

    // External email delivery. Blank keeps event messaging on local capture —
    // but it is required in production, because account recovery email has no
    // other path and an operator cannot hand-deliver a link to every colleague.
    RESEND_API_KEY: optionalTrimmed,
    RESEND_API_URL: z.string().url().default("https://api.resend.com"),
    RESEND_WEBHOOK_SECRET: optionalTrimmed,

    // Which provider sends external email (#861). Unset keeps Resend. `ses` sends through Amazon SES over SMTP
    // with IAM SMTP credentials; the Resend variables above are then unused.
    EMAIL_PROVIDER: z.preprocess(
      (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
      z.enum(["resend", "ses"]).default("resend"),
    ),
    SES_REGION: z.string().trim().regex(/^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/, "must be an AWS region such as us-east-2").optional(),
    SES_SMTP_USERNAME: optionalTrimmed,
    SES_SMTP_PASSWORD: optionalTrimmed,
    // Test-only overrides and tuning; the defaults are email-smtp.<region>.amazonaws.com, 587 and 10 a second.
    SES_SMTP_HOST: optionalTrimmed,
    SES_SMTP_PORT: z.string().trim().regex(/^\d{1,5}$/, "must be a port number").optional(),
    SES_CONFIGURATION_SET: optionalTrimmed,
    SES_MAX_SEND_RATE: z.string().trim().regex(/^\d+(\.\d+)?$/, "must be a number of messages per second").optional(),

    // Sender identity for account email. Event messages take theirs from
    // EventMessageSettings; activation and password reset belong to no event.
    ACCOUNT_EMAIL_SENDER_NAME: z.string().trim().min(1).max(100).default("IMSDA Events"),
    ACCOUNT_EMAIL_SENDER_ADDRESS: optionalTrimmed,
    ACCOUNT_EMAIL_REPLY_TO: optionalTrimmed,

    // Google sign-in for attendee accounts. Blank hides the button entirely
    // rather than offering one that cannot work — a registrant who clicks a
    // dead sign-in button has no way to know the deployment is at fault.
    // Never used for staff: that path carries the MFA gate.
    GOOGLE_OAUTH_CLIENT_ID: optionalTrimmed,
    GOOGLE_OAUTH_CLIENT_SECRET: optionalTrimmed,

    // Square stays in Sandbox unless production is separately unlocked.
    SQUARE_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
    SQUARE_APPLICATION_ID: optionalTrimmed,
    SQUARE_ACCESS_TOKEN: optionalTrimmed,
    SQUARE_LOCATION_ID: optionalTrimmed,
    SQUARE_API_URL: optionalTrimmed,
    SQUARE_API_VERSION: optionalTrimmed,
    SQUARE_WEBHOOK_SIGNATURE_KEY: optionalTrimmed,
    SQUARE_WEBHOOK_SECRET: optionalTrimmed,
    SQUARE_WEBHOOK_NOTIFICATION_URL: optionalTrimmed,
    SQUARE_ENABLE_PRODUCTION: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),

    // Authorises the scheduled outbox sweep. Required in production so the
    // sweep endpoint is never reachable without a credential.
    OUTBOX_SWEEP_TOKEN: optionalTrimmed,

    // Encrypts the values that must be recoverable rather than hashed — today,
    // TOTP secrets. Required in production, where MFA is enforced for admins.
    // Set directly for development. Production loads it from a protected file
    // instead: SECRET_ENCRYPTION_KEY_FILE names a file (for example a read-only
    // mounted secret) whose trimmed contents are the key. Setting both is an
    // error. `resolveEncryptionKey` does the loading before this schema runs.
    SECRET_ENCRYPTION_KEY: optionalTrimmed,
    SECRET_ENCRYPTION_KEY_FILE: optionalTrimmed,

    // Pathfinder Health Record (#611). Off unless exactly "true": with it off
    // there are no health routes, no Health tab, and nothing is stored. Do not
    // turn it on in production before ADR 0005 Addendum B is Accepted and the
    // encryption key backup has been test-restored.
    HEALTH_RECORDS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),

    // Church map locations (#724). Off unless exactly "true": with it off the
    // staff "Find map locations" step does nothing and sends nothing. When on,
    // staff clicking the button sends church street addresses to the U.S.
    // Census Bureau geocoder (geocoding.geo.census.gov), so production needs
    // outbound HTTPS to that host. GEOCODING_PROVIDER "fake" is a built-in
    // offline stand-in for local screenshots and must not be set in production.
    GEOCODING_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    GEOCODING_PROVIDER: z.enum(["census", "fake"]).default("census"),

    // Where alerts go. Any endpoint that accepts a JSON POST — a Slack or
    // Teams incoming webhook, or a small relay. Blank means alerts are only
    // written to the log, where nothing is watching them.
    ALERT_WEBHOOK_URL: optionalTrimmed,
    // How long the same condition stays quiet after paging once.
    ALERT_REPEAT_MINUTES: z
      .string()
      .trim()
      .regex(/^\d+$/, "must be a whole number of minutes")
      .transform(Number)
      .refine((value) => value >= 1 && value <= 1440, "must be between 1 and 1440 minutes")
      .default(60),

    // Checks a chosen password against a public breach corpus, sending only a
    // five-character hash prefix. Unset means on in production, off elsewhere.
    PASSWORD_BREACH_CHECK: z.enum(["enabled", "disabled"]).optional(),
    PASSWORD_BREACH_CHECK_URL: z
      .string()
      .url()
      .default("https://api.pwnedpasswords.com/range/"),
  })
  .superRefine((value, context) => {
    const isProduction = value.NODE_ENV === "production";

    const requiredInProduction = [
      "MANAGE_LINK_DERIVATION_SECRET",
      "ATTENDEE_PASS_SIGNING_SECRET",
      "RATE_LIMIT_HASH_SECRET",
      "OUTBOX_SWEEP_TOKEN",
      "SECRET_ENCRYPTION_KEY",
    ] as const;

    for (const key of requiredInProduction) {
      const secret = value[key];
      if (isProduction && (secret ?? "").length < SECRET_MIN_LENGTH) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `must contain at least ${SECRET_MIN_LENGTH} characters in production`,
        });
      }
    }

    // The offline stand-in returns invented points; it must never run in production.
    if (isProduction && value.GEOCODING_PROVIDER === "fake") {
      context.addIssue({
        code: "custom",
        path: ["GEOCODING_PROVIDER"],
        message: "must not be \"fake\" in production",
      });
    }

    const rotationKeys = [
      "MANAGE_LINK_DERIVATION_SECRET_PREVIOUS",
      "ATTENDEE_PASS_SIGNING_SECRET_PREVIOUS",
    ] as const;

    for (const key of rotationKeys) {
      const secret = value[key];
      if (secret && secret.length < SECRET_MIN_LENGTH) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `must contain at least ${SECRET_MIN_LENGTH} characters when configured`,
        });
      }
    }

    // Account recovery is the one email path with no manual alternative: an
    // invited colleague who never receives a link cannot obtain a credential at
    // all. Production therefore has to have somewhere to send from.
    const emailAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const key of ["ACCOUNT_EMAIL_SENDER_ADDRESS", "ACCOUNT_EMAIL_REPLY_TO"] as const) {
      const address = value[key];
      if (address && !emailAddress.test(address)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "must be an email address",
        });
      }
    }
    if (isProduction && !value.ACCOUNT_EMAIL_SENDER_ADDRESS) {
      context.addIssue({
        code: "custom",
        path: ["ACCOUNT_EMAIL_SENDER_ADDRESS"],
        message:
          "is required in production so activation and password reset email can be sent",
      });
    }
    if (isProduction && value.EMAIL_PROVIDER === "resend" && !value.RESEND_API_KEY) {
      context.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message: "is required in production so account recovery email can be delivered",
      });
    }
    if (value.EMAIL_PROVIDER === "ses") {
      for (const key of ["SES_REGION", "SES_SMTP_USERNAME", "SES_SMTP_PASSWORD"] as const) {
        if (isProduction && !value[key]) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: "is required in production when EMAIL_PROVIDER=ses so account recovery email can be delivered",
          });
        }
      }
    }

    // Half a client is worse than none: the button would appear and every
    // attempt would fail at the token exchange, after the registrant had
    // already handed Google their password.
    const googleHalves = [
      value.GOOGLE_OAUTH_CLIENT_ID,
      value.GOOGLE_OAUTH_CLIENT_SECRET,
    ];
    if (googleHalves.some(Boolean) && !googleHalves.every(Boolean)) {
      context.addIssue({
        code: "custom",
        path: ["GOOGLE_OAUTH_CLIENT_SECRET"],
        message:
          "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set together",
      });
    }

    if (
      value.RATE_LIMIT_TRUSTED_PROXY_HOPS > 1
      && value.RATE_LIMIT_CLIENT_IP_HEADER !== "x-forwarded-for"
    ) {
      context.addIssue({
        code: "custom",
        path: ["RATE_LIMIT_CLIENT_IP_HEADER"],
        message: "only x-forwarded-for can represent more than one trusted proxy hop",
      });
    }

    if (value.ALERT_WEBHOOK_URL) {
      try {
        new URL(value.ALERT_WEBHOOK_URL);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["ALERT_WEBHOOK_URL"],
          message: "must be a valid URL",
        });
      }
    }

    if (value.SQUARE_API_URL) {
      try {
        new URL(value.SQUARE_API_URL);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["SQUARE_API_URL"],
          message: "must be a valid URL",
        });
      }
    }

    if (value.SQUARE_ENVIRONMENT === "production" && !value.SQUARE_ENABLE_PRODUCTION) {
      context.addIssue({
        code: "custom",
        path: ["SQUARE_ENABLE_PRODUCTION"],
        message:
          "must be true before SQUARE_ENVIRONMENT may be production; Square production is a separate, explicit unlock",
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * A configuration fault, not a request fault. Route handlers must let this
 * surface as a 500 — degrading it into a client-facing 4xx tells operators to
 * look in the wrong place.
 */
export class ServerEnvironmentError extends Error {
  constructor(
    message: string,
    public readonly issues: readonly string[],
  ) {
    super(message);
    this.name = "ServerEnvironmentError";
  }
}

export function isServerEnvironmentError(error: unknown): error is ServerEnvironmentError {
  return error instanceof ServerEnvironmentError;
}

export type ServerEnvValidation =
  | { ok: true; env: ServerEnv }
  | { ok: false; issues: string[] };

/**
 * The variables actually read out of the process environment.
 *
 * This list and the schema above have to agree. A variable declared in the
 * schema but missing here is silently dropped before parsing — it validates,
 * defaults, and is never populated, which looks exactly like a deployment that
 * forgot to set it. `server-env-contract.test.ts` fails when they drift.
 */
export const SERVER_ENV_KEYS = [
    "NODE_ENV",
    "DATABASE_URL",
    "APP_BASE_URL",
    "APP_RELEASE_SHA",
    "ASSET_STORAGE_DIR",
    "MANAGE_LINK_DERIVATION_SECRET",
    "MANAGE_LINK_DERIVATION_SECRET_PREVIOUS",
    "ATTENDEE_PASS_SIGNING_SECRET",
    "ATTENDEE_PASS_SIGNING_SECRET_PREVIOUS",
    "RATE_LIMIT_HASH_SECRET",
    "RATE_LIMIT_TRUSTED_PROXY_HOPS",
    "RATE_LIMIT_CLIENT_IP_HEADER",
    "EMBED_ALLOWED_ORIGINS",
    "RESEND_API_KEY",
    "RESEND_API_URL",
    "RESEND_WEBHOOK_SECRET",
    "EMAIL_PROVIDER",
    "SES_REGION",
    "SES_SMTP_USERNAME",
    "SES_SMTP_PASSWORD",
    "SES_SMTP_HOST",
    "SES_SMTP_PORT",
    "SES_CONFIGURATION_SET",
    "SES_MAX_SEND_RATE",
    "ACCOUNT_EMAIL_SENDER_NAME",
    "ACCOUNT_EMAIL_SENDER_ADDRESS",
    "ACCOUNT_EMAIL_REPLY_TO",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "SQUARE_ENVIRONMENT",
    "SQUARE_APPLICATION_ID",
    "SQUARE_ACCESS_TOKEN",
    "SQUARE_LOCATION_ID",
    "SQUARE_API_URL",
    "SQUARE_API_VERSION",
    "SQUARE_WEBHOOK_SIGNATURE_KEY",
    "SQUARE_WEBHOOK_SECRET",
    "SQUARE_WEBHOOK_NOTIFICATION_URL",
    "SQUARE_ENABLE_PRODUCTION",
    "OUTBOX_SWEEP_TOKEN",
    "SECRET_ENCRYPTION_KEY",
    "SECRET_ENCRYPTION_KEY_FILE",
    "HEALTH_RECORDS_ENABLED",
    "GEOCODING_ENABLED",
    "GEOCODING_PROVIDER",
    "ALERT_WEBHOOK_URL",
    "ALERT_REPEAT_MINUTES",
    "PASSWORD_BREACH_CHECK",
    "PASSWORD_BREACH_CHECK_URL",
] as const;

export type EncryptionKeyResolution =
  | { ok: true; key: string | undefined; source: "file" | "env" | "none" }
  | { ok: false; issue: string };

/**
 * Finds the encryption key: from the file named by SECRET_ENCRYPTION_KEY_FILE,
 * or from SECRET_ENCRYPTION_KEY itself. The file keeps the key out of the env
 * file and out of `docker inspect`. Messages name the variable and the path,
 * never the key or any part of the file's contents.
 */
export function resolveEncryptionKey(
  source: Record<string, string | undefined> = process.env,
): EncryptionKeyResolution {
  const filePath = source.SECRET_ENCRYPTION_KEY_FILE?.trim();
  const plain = source.SECRET_ENCRYPTION_KEY?.trim();

  if (!filePath) {
    return plain ? { ok: true, key: plain, source: "env" } : { ok: true, key: undefined, source: "none" };
  }
  if (plain) {
    return {
      ok: false,
      issue:
        "SECRET_ENCRYPTION_KEY_FILE: SECRET_ENCRYPTION_KEY and SECRET_ENCRYPTION_KEY_FILE are both set; set only one (remove SECRET_ENCRYPTION_KEY from the environment)",
    };
  }

  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT" ? "the file does not exist"
      : code === "EACCES" || code === "EPERM" ? "the file is not readable by this process (check its owner and mode)"
      : `the file could not be read (${code ?? "unknown error"})`;
    return { ok: false, issue: `SECRET_ENCRYPTION_KEY_FILE: ${filePath}: ${reason}` };
  }

  const key = contents.trim();
  if (!key) {
    return { ok: false, issue: `SECRET_ENCRYPTION_KEY_FILE: ${filePath}: the file is empty` };
  }
  return { ok: true, key, source: "file" };
}

export type EncryptionKeyStatus = { configured: boolean; source: "file" | "env" | null };

let cachedKeyStatus: EncryptionKeyStatus | undefined;

/**
 * Non-secret summary for health and readiness: whether a key is configured and
 * how it was loaded. With no argument it describes the process environment as
 * resolved at startup (computed once, so a health poll never re-reads the key
 * file); pass a source to inspect another environment without caching.
 */
export function getEncryptionKeyStatus(source?: Record<string, string | undefined>): EncryptionKeyStatus {
  if (source) return describeEncryptionKey(source);
  cachedKeyStatus ??= describeEncryptionKey(process.env);
  return cachedKeyStatus;
}

function describeEncryptionKey(source: Record<string, string | undefined>): EncryptionKeyStatus {
  const resolved = resolveEncryptionKey(source);
  if (resolved.ok && resolved.key && resolved.source !== "none") {
    return { configured: true, source: resolved.source };
  }
  // A configured-but-unusable file is still a file deployment; say so.
  const fileConfigured = Boolean(source.SECRET_ENCRYPTION_KEY_FILE?.trim());
  return { configured: false, source: fileConfigured ? "file" : null };
}

function readSource(
  source: Record<string, string | undefined>,
  encryptionKey: string | undefined,
) {
  return Object.fromEntries(
    SERVER_ENV_KEYS
      .map((key) => [
        key,
        key === "SECRET_ENCRYPTION_KEY"
          ? encryptionKey
          : source[key]?.trim() ? source[key] : undefined,
      ])
      .filter(([, value]) => value !== undefined),
  );
}

/**
 * Validates without throwing. Issue text names the variable and the rule it
 * broke, never the value — these strings reach container logs.
 */
export function validateServerEnv(
  source: Record<string, string | undefined> = process.env,
): ServerEnvValidation {
  const encryption = resolveEncryptionKey(source);
  const result = serverEnvSchema.safeParse(
    readSource(source, encryption.ok ? encryption.key : undefined),
  );
  if (result.success && encryption.ok) return { ok: true, env: result.data };

  const issues = result.success
    ? []
    : result.error.issues
        .filter((issue) => encryption.ok || issue.path[0] !== "SECRET_ENCRYPTION_KEY")
        .map((issue) => {
          const variable = issue.path.join(".") || "environment";
          return `${variable}: ${issue.message}`;
        });
  if (!encryption.ok) issues.push(encryption.issue);
  return { ok: false, issues };
}

let cachedEnv: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (cachedEnv) return cachedEnv;

  const result = validateServerEnv();
  if (!result.ok) {
    throw new ServerEnvironmentError(
      `Invalid server environment: ${result.issues.join("; ")}`,
      result.issues,
    );
  }

  cachedEnv = result.env;
  return result.env;
}

/** Test seam. Never called by application code. */
export function resetServerEnvCache() {
  cachedEnv = undefined;
  cachedKeyStatus = undefined;
}

/**
 * Startup contract. Called from `instrumentation.ts` before the server accepts
 * a request: in production a bad variable stops the deploy, everywhere else it
 * is a loud warning so local work is not blocked by an unset Square key.
 */
export function assertServerEnvAtStartup(
  source: Record<string, string | undefined> = process.env,
): ServerEnvValidation {
  const result = validateServerEnv(source);
  // Record how the key was loaded at startup, for /api/health.
  if (source === process.env) getEncryptionKeyStatus();
  if (result.ok) return result;

  const report = result.issues.map((issue) => `  - ${issue}`).join("\n");
  if (source.NODE_ENV === "production") {
    throw new ServerEnvironmentError(
      `Refusing to start: the environment is not valid for production.\n${report}`,
      result.issues,
    );
  }
  console.warn(
    `[env] The environment is incomplete. Production would refuse to start.\n${report}`,
  );
  return result;
}
