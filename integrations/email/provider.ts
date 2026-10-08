import "server-only";

import { createHash } from "node:crypto";

import {
  getResendEmailAvailability,
  getResendEmailConfiguration,
  sendEmailWithResend,
  type ResendEmailConfiguration,
} from "./resend";
import {
  getSesEmailAvailability,
  getSesEmailConfiguration,
  isSesEmailConfiguration,
  sendEmailWithSes,
  verifySesConnection,
  type SesEmailConfiguration,
} from "./ses";
import {
  EmailProviderConfigurationError,
  type EmailDeliveryInput,
  type EmailDeliveryResult,
  type EmailProviderName,
} from "./types";

/**
 * The one place that knows which outbound email provider is active (#861). `EMAIL_PROVIDER=ses` selects Amazon
 * SES; unset, blank or `resend` keeps Resend, so nothing changes until a server sets it.
 */

export type EmailProviderConfiguration = ResendEmailConfiguration | SesEmailConfiguration;

/** `null` for a value that is neither provider, so a typo is reported rather than silently routed. */
function parseProvider(value: string | undefined): EmailProviderName | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "" || normalized === "resend") return "RESEND";
  if (normalized === "ses") return "SES";
  return null;
}

/** The provider name recorded on outbox rows and delivery attempts. */
export function getActiveEmailProviderName(): EmailProviderName {
  return parseProvider(process.env.EMAIL_PROVIDER) ?? "RESEND";
}

export function getEmailAvailability() {
  const provider = parseProvider(process.env.EMAIL_PROVIDER);
  if (provider === null) return { deliveryConfigured: false, webhookConfigured: false };
  return provider === "SES" ? getSesEmailAvailability() : getResendEmailAvailability();
}

export function getEmailConfiguration(): EmailProviderConfiguration {
  const provider = parseProvider(process.env.EMAIL_PROVIDER);
  if (provider === null) {
    throw new EmailProviderConfigurationError("EMAIL_PROVIDER must be ses or resend.");
  }
  return provider === "SES" ? getSesEmailConfiguration() : getResendEmailConfiguration();
}

export async function sendEmail(
  input: EmailDeliveryInput,
  configuration?: EmailProviderConfiguration,
): Promise<EmailDeliveryResult> {
  const resolved = configuration ?? getEmailConfiguration();
  return isSesEmailConfiguration(resolved)
    ? sendEmailWithSes(input, resolved)
    : sendEmailWithResend(input, resolved);
}

/** The provider a configuration belongs to, which is what was actually used, whatever the environment says now. */
export function providerNameForConfiguration(configuration: EmailProviderConfiguration): EmailProviderName {
  return isSesEmailConfiguration(configuration) ? "SES" : "RESEND";
}

/** Run before a batch claims any message: bad credentials stop here, with every message left untouched. */
export async function preflightEmailProvider(
  configuration: EmailProviderConfiguration,
  now: () => number = Date.now,
) {
  if (!isSesEmailConfiguration(configuration)) return;
  // A login that worked is trusted for a few minutes, so a busy sweep or a run of inline sends logs in once.
  const key = createHash("sha256")
    .update([configuration.smtpHost, configuration.smtpPort, configuration.username, configuration.password].join("\u0000"))
    .digest("hex");
  const verifiedAt = verifiedConfigurations.get(key);
  if (verifiedAt !== undefined && now() - verifiedAt < PREFLIGHT_CACHE_MS) return;
  await verifySesConnection(configuration);
  verifiedConfigurations.set(key, now());
}

export const PREFLIGHT_CACHE_MS = 5 * 60 * 1000;
const verifiedConfigurations = new Map<string, number>();

/** Test hook: forget every cached pre-flight. */
export function resetEmailPreflightCache() {
  verifiedConfigurations.clear();
}
