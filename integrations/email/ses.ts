import "server-only";

import nodemailer from "nodemailer";
import { z } from "zod";
import type Mail from "nodemailer/lib/mailer";
import {
  EmailProviderConfigurationError,
  EmailProviderRequestError,
  cleanHeaderText,
  type EmailDeliveryInput,
  type EmailDeliveryResult,
} from "./types";

/**
 * Amazon SES over SMTP (#861): `email-smtp.<region>.amazonaws.com:587` with STARTTLS required and IAM SMTP
 * credentials. Nodemailer is Node-only; `server-only` above keeps it out of every client bundle.
 */

/** The code the outbox records when SES says the 24-hour sending quota is used up. Retryable, with backoff. */
export const PROVIDER_QUOTA_CODE = "PROVIDER_QUOTA";

export const DEFAULT_SES_MAX_SEND_RATE = 10;
const MAX_CONFIGURABLE_SEND_RATE = 1000;

export type SesEmailConfiguration = {
  smtpHost: string;
  smtpPort: number;
  username: string;
  password: string;
  region: string;
  configurationSet: string | null;
  /** Messages per second this process may start. */
  maxSendRate: number;
  /** Only a local test stub with a self-signed certificate turns this off; it can't be set from the environment. */
  tlsRejectUnauthorized?: boolean;
};

/** The part of a nodemailer transport this adapter uses, so a test can supply its own. */
export type SesTransport = {
  sendMail(options: Mail.Options): Promise<{ response?: string; messageId?: string }>;
};

const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

export function getSesEmailAvailability() {
  const env = process.env;
  return {
    deliveryConfigured: Boolean(
      env.SES_REGION?.trim() && env.SES_SMTP_USERNAME?.trim() && env.SES_SMTP_PASSWORD?.trim(),
    ),
    // SES reports bounces and complaints through SNS, which is not built yet (see the follow-up issue).
    webhookConfigured: false,
  };
}

export function getSesEmailConfiguration(): SesEmailConfiguration {
  const env = process.env;
  const region = env.SES_REGION?.trim();
  const username = env.SES_SMTP_USERNAME?.trim();
  const password = env.SES_SMTP_PASSWORD?.trim();
  if (!region || !username || !password) {
    throw new EmailProviderConfigurationError(
      "External email is not configured. Add SES_REGION, SES_SMTP_USERNAME and SES_SMTP_PASSWORD (IAM SMTP credentials) before enabling live delivery.",
    );
  }
  if (!REGION_PATTERN.test(region)) {
    throw new EmailProviderConfigurationError("SES_REGION must be an AWS region such as us-east-2.");
  }
  const portText = env.SES_SMTP_PORT?.trim();
  const smtpPort = portText ? Number(portText) : 587;
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new EmailProviderConfigurationError("SES_SMTP_PORT must be a port number.");
  }
  const rateText = env.SES_MAX_SEND_RATE?.trim();
  const maxSendRate = rateText ? Number(rateText) : DEFAULT_SES_MAX_SEND_RATE;
  if (!Number.isFinite(maxSendRate) || maxSendRate <= 0 || maxSendRate > MAX_CONFIGURABLE_SEND_RATE) {
    throw new EmailProviderConfigurationError("SES_MAX_SEND_RATE must be a number of messages per second above 0.");
  }
  return {
    smtpHost: env.SES_SMTP_HOST?.trim() || `email-smtp.${region}.amazonaws.com`,
    smtpPort,
    username,
    password,
    region,
    configurationSet: env.SES_CONFIGURATION_SET?.trim() || null,
    maxSendRate,
  };
}

export function isSesEmailConfiguration(value: unknown): value is SesEmailConfiguration {
  return typeof value === "object" && value !== null && "smtpHost" in value && "username" in value;
}

/**
 * Spaces send starts at least 1/rate seconds apart within this process, so a 50-message worker batch stays under
 * the SES per-second limit. Each caller reserves the next free slot synchronously, then waits for it.
 */
export function createSendPacer(
  clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
) {
  let nextSlot = 0;
  return async function pace(maxSendRate: number) {
    const interval = 1000 / maxSendRate;
    const now = clock.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + interval;
    const wait = slot - now;
    if (wait > 0) await clock.sleep(wait);
  };
}

const defaultPacer = createSendPacer();

function cleanAddress(value: string) {
  return cleanHeaderText(value).toLowerCase();
}

function headerSafeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 200);
}

/** The nodemailer message for one delivery. Pure, so the MIME can be inspected without a network. */
export function buildSesMailOptions(
  input: EmailDeliveryInput,
  configuration: Pick<SesEmailConfiguration, "configurationSet">,
): Mail.Options {
  const fromEmail = cleanAddress(input.fromEmail);
  const domain = fromEmail.split("@")[1] || "imsda.org";
  const stableId = headerSafeId(input.messageId);
  const headers: Record<string, string> = {
    // SES may assign its own Message-ID; this one is ours, so a retry can be traced either way.
    "X-IMSDA-Message-Id": stableId,
  };
  if (configuration.configurationSet) {
    headers["X-SES-CONFIGURATION-SET"] = cleanHeaderText(configuration.configurationSet);
  }
  return {
    from: { name: cleanHeaderText(input.fromName), address: fromEmail },
    to: cleanAddress(input.toEmail),
    ...(input.replyToEmail?.trim() ? { replyTo: cleanAddress(input.replyToEmail) } : {}),
    subject: cleanHeaderText(input.subject),
    text: input.bodyText,
    ...(input.bodyHtml?.trim() ? { html: input.bodyHtml } : {}),
    messageId: `<${stableId}@${headerSafeId(domain)}>`,
    headers,
    ...(input.attachments && input.attachments.length > 0
      ? {
          attachments: input.attachments.map((attachment) => ({
            filename: cleanHeaderText(attachment.filename),
            content: Buffer.from(attachment.content),
            contentType: cleanHeaderText(attachment.contentType),
            ...(attachment.contentId
              ? { cid: cleanHeaderText(attachment.contentId), contentDisposition: "inline" as const }
              : {}),
          })),
        }
      : {}),
  };
}

type SmtpError = Error & {
  code?: string;
  responseCode?: number;
  response?: string;
  command?: string;
};

const NETWORK_ERROR_CODES = new Set([
  "ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNRESET", "ECONNREFUSED", "EDNS", "EPROTOCOL", "ETLS", "ENOTFOUND", "EAI_AGAIN",
  "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "ECONNABORTED",
]);

/** Turns an SMTP failure into the error the outbox worker understands. Never includes the message or credentials. */
export function mapSesError(error: unknown): EmailProviderRequestError | EmailProviderConfigurationError {
  const smtp = (error ?? {}) as SmtpError;
  const reply = `${smtp.response ?? ""} ${smtp.message ?? ""}`;
  const status = typeof smtp.responseCode === "number" ? smtp.responseCode : 0;

  // A 4xx during AUTH ("454 4.7.0 Temporary authentication failure") is SES being briefly unwell, not wrong credentials.
  if (smtp.code === "EAUTH" && status >= 400 && status < 500) {
    return new EmailProviderRequestError(
      "Amazon SES could not authenticate right now. The message will be retried.",
      "SES_AUTH_TEMPORARY",
      true,
      status,
    );
  }
  if (smtp.code === "EAUTH" || status === 535) {
    return new EmailProviderConfigurationError(
      "Amazon SES rejected the SMTP username or password. Check SES_SMTP_USERNAME and SES_SMTP_PASSWORD (IAM SMTP credentials for this region).",
    );
  }
  // Before the reply-code branches: a failed STARTTLS upgrade carries the server's 5xx reply but is a transport fault.
  if (smtp.code && NETWORK_ERROR_CODES.has(smtp.code)) {
    return new EmailProviderRequestError("The email provider could not be reached.", "NETWORK_ERROR", true, 0);
  }
  if (/daily message quota exceeded/i.test(reply)) {
    return new EmailProviderRequestError(
      "Amazon SES has reached the daily sending quota. The message will be retried later.",
      PROVIDER_QUOTA_CODE,
      true,
      status || 454,
    );
  }
  if (status === 454 || /maximum sending rate exceeded|throttl/i.test(reply)) {
    return new EmailProviderRequestError(
      "Amazon SES is limiting the sending rate. The message will be retried.",
      "PROVIDER_THROTTLED",
      true,
      status || 454,
    );
  }
  if (status >= 400 && status < 500) {
    return new EmailProviderRequestError(
      "Amazon SES could not accept the message right now. It will be retried.",
      `SMTP_${status}`,
      true,
      status,
    );
  }
  if (/not verified/i.test(reply)) {
    return new EmailProviderRequestError(
      "Amazon SES refused the message because the sender address is not on a verified domain or address. Verify it in SES, then retry.",
      "SES_IDENTITY_NOT_VERIFIED",
      false,
      status || 554,
    );
  }
  if (status >= 500 && status < 600) {
    return new EmailProviderRequestError(
      status === 554
        ? "Amazon SES rejected the message."
        : "Amazon SES did not accept the message.",
      status === 554 ? "SES_MESSAGE_REJECTED" : `SMTP_${status}`,
      false,
      status,
    );
  }
  if (smtp.code === "EENVELOPE" || smtp.code === "EMESSAGE") {
    return new EmailProviderRequestError("The message could not be built for delivery.", "INVALID_MESSAGE", false, 0);
  }
  // Unknown and uncategorised: final, as for every other adapter, so an unrecognised fault is looked at, not looped.
  return new EmailProviderRequestError("The email provider request failed.", "UNEXPECTED_PROVIDER_ERROR", false, 0);
}

function createTransport(configuration: SesEmailConfiguration): SesTransport {
  return nodemailer.createTransport({
    host: configuration.smtpHost,
    port: configuration.smtpPort,
    // Port 465 is implicit TLS; everything else must upgrade with STARTTLS or the send fails.
    secure: configuration.smtpPort === 465,
    requireTLS: configuration.smtpPort !== 465,
    auth: { user: configuration.username, pass: configuration.password },
    tls: {
      minVersion: "TLSv1.2",
      ...(configuration.tlsRejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

function messageIdFromResponse(response: string | undefined, fallback: string | undefined) {
  // SES answers `250 Ok <id>`.
  const match = /^250\s+Ok\s+([A-Za-z0-9._-]+)/i.exec(response?.trim() ?? "");
  return match?.[1] ?? fallback?.replace(/^<|>$/g, "") ?? null;
}

export async function sendEmailWithSes(
  input: EmailDeliveryInput,
  configuration: SesEmailConfiguration = getSesEmailConfiguration(),
  options: { transport?: SesTransport; pace?: (maxSendRate: number) => Promise<void> } = {},
): Promise<EmailDeliveryResult> {
  if (!input.fromEmail.trim()) {
    throw new EmailProviderConfigurationError(
      "A verified sender email is required before external delivery can be enabled.",
      false,
    );
  }
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 256) {
    throw new Error("Email idempotency keys must contain 1 to 256 characters.");
  }
  // Exactly one address each: a comma-separated or display-name value would address a second person.
  const recipient = z.email().safeParse(input.toEmail.trim());
  const replyTo = input.replyToEmail?.trim() ? z.email().safeParse(input.replyToEmail.trim()) : null;
  if (!recipient.success || (replyTo && !replyTo.success)) {
    throw new EmailProviderRequestError(
      "The recipient or reply-to address is not a single valid email address, so the message was not sent.",
      "INVALID_ADDRESS",
      false,
      0,
    );
  }
  const mail = buildSesMailOptions(input, configuration);
  await (options.pace ?? defaultPacer)(configuration.maxSendRate);
  const transport = options.transport ?? createTransport(configuration);
  let info: { response?: string; messageId?: string };
  try {
    info = await transport.sendMail(mail);
  } catch (error) {
    throw mapSesError(error);
  } finally {
    if (!options.transport) (transport as { close?: () => void }).close?.();
  }
  const providerMessageId = messageIdFromResponse(info.response, info.messageId);
  if (!providerMessageId) {
    throw new EmailProviderRequestError("The email provider did not accept this message.", "SES_NO_MESSAGE_ID", false, 0);
  }
  return { provider: "SES", providerMessageId };
}

/**
 * Checks the connection and credentials once, before a batch claims anything. Only a configuration error (bad
 * credentials) is raised; a network failure is left to the per-message handling, which already retries it.
 */
export async function verifySesConnection(configuration: SesEmailConfiguration) {
  const transport = nodemailer.createTransport({
    host: configuration.smtpHost,
    port: configuration.smtpPort,
    secure: configuration.smtpPort === 465,
    requireTLS: configuration.smtpPort !== 465,
    auth: { user: configuration.username, pass: configuration.password },
    tls: {
      minVersion: "TLSv1.2",
      ...(configuration.tlsRejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.verify();
  } catch (error) {
    const mapped = mapSesError(error);
    if (mapped instanceof EmailProviderConfigurationError) throw mapped;
  } finally {
    transport.close();
  }
}
