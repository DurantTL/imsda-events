import "server-only";

export type SquareEnvironment = "sandbox" | "production";

export type SquareConfigurationIssue =
  | "INVALID_ENVIRONMENT"
  | "PRODUCTION_DISABLED"
  | "INVALID_API_URL"
  | "CREDENTIAL_ENVIRONMENT_MISMATCH"
  | "MISSING_PAYMENT_CREDENTIALS"
  | "MISSING_WEBHOOK_CONFIGURATION";

export type SquareRuntimeConfiguration = {
  environment: SquareEnvironment;
  applicationId: string;
  locationId: string;
  accessToken: string;
  apiUrl: string;
  apiVersion: string;
  scriptUrl: string;
  webhookSignatureKey: string;
  webhookNotificationUrl: string;
  paymentConfigured: boolean;
  webhookConfigured: boolean;
  issue: SquareConfigurationIssue | null;
};

type SquareEnvironmentSource = Record<string, string | undefined>;

const sandboxApiUrl = "https://connect.squareupsandbox.com";
const productionApiUrl = "https://connect.squareup.com";
const sandboxScriptUrl = "https://sandbox.web.squarecdn.com/v1/square.js";
const productionScriptUrl = "https://web.squarecdn.com/v1/square.js";
const squareWebhookPath = "/api/webhooks/square";

function value(source: SquareEnvironmentSource, key: string) {
  return source[key]?.trim() ?? "";
}

function exactApiUrl(rawValue: string, environment: SquareEnvironment) {
  const fallback = environment === "production" ? productionApiUrl : sandboxApiUrl;
  if (!rawValue) return { apiUrl: fallback, valid: true };
  try {
    const parsed = new URL(rawValue);
    const normalized = parsed.origin;
    const expected = environment === "production" ? productionApiUrl : sandboxApiUrl;
    return {
      apiUrl: normalized,
      valid: normalized === expected
        && (parsed.pathname === "/" || parsed.pathname === "")
        && !parsed.search
        && !parsed.hash,
    };
  } catch {
    return { apiUrl: fallback, valid: false };
  }
}

function webhookUrl(source: SquareEnvironmentSource) {
  const explicit = value(source, "SQUARE_WEBHOOK_NOTIFICATION_URL");
  if (explicit) return explicit;
  const appBaseUrl = value(source, "APP_BASE_URL") || "http://localhost:3000";
  try {
    return new URL(squareWebhookPath, appBaseUrl).toString();
  } catch {
    return "";
  }
}

/**
 * Square stays in Sandbox unless Production is selected and separately
 * unlocked. The browser-safe identifiers are returned to clients by a
 * no-store endpoint; the access token and webhook key never leave the server.
 */
export function getSquareConfiguration(
  source: SquareEnvironmentSource = process.env,
): SquareRuntimeConfiguration {
  const requestedEnvironment = value(source, "SQUARE_ENVIRONMENT") || "sandbox";
  const validEnvironment = requestedEnvironment === "sandbox"
    || requestedEnvironment === "production";
  const environment: SquareEnvironment = requestedEnvironment === "production"
    ? "production"
    : "sandbox";
  const productionEnabled = value(source, "SQUARE_ENABLE_PRODUCTION") === "true";
  const applicationId = value(source, "SQUARE_APPLICATION_ID");
  const locationId = value(source, "SQUARE_LOCATION_ID");
  const accessToken = value(source, "SQUARE_ACCESS_TOKEN");
  const api = exactApiUrl(value(source, "SQUARE_API_URL"), environment);
  const credentialMatchesEnvironment = !applicationId
    || (environment === "sandbox"
      ? applicationId.startsWith("sandbox-")
      : !applicationId.startsWith("sandbox-"));
  const environmentSafe = validEnvironment
    && api.valid
    && credentialMatchesEnvironment
    && (environment !== "production" || productionEnabled);
  const paymentCredentialsPresent = Boolean(
    applicationId && locationId && accessToken,
  );
  const webhookSignatureKey = value(source, "SQUARE_WEBHOOK_SIGNATURE_KEY")
    || value(source, "SQUARE_WEBHOOK_SECRET");
  const webhookNotificationUrl = webhookUrl(source);
  const webhookConfigurationPresent = Boolean(
    webhookSignatureKey && webhookNotificationUrl,
  );
  const integrationConfigured = environmentSafe
    && paymentCredentialsPresent
    && webhookConfigurationPresent;

  let issue: SquareConfigurationIssue | null = null;
  if (!validEnvironment) issue = "INVALID_ENVIRONMENT";
  else if (environment === "production" && !productionEnabled) {
    issue = "PRODUCTION_DISABLED";
  } else if (!api.valid) issue = "INVALID_API_URL";
  else if (!credentialMatchesEnvironment) {
    issue = "CREDENTIAL_ENVIRONMENT_MISMATCH";
  } else if (!paymentCredentialsPresent) {
    issue = "MISSING_PAYMENT_CREDENTIALS";
  } else if (!webhookConfigurationPresent) {
    issue = "MISSING_WEBHOOK_CONFIGURATION";
  }

  return {
    environment,
    applicationId,
    locationId,
    accessToken,
    apiUrl: api.apiUrl,
    apiVersion: value(source, "SQUARE_API_VERSION") || "2026-07-15",
    scriptUrl: environment === "production"
      ? productionScriptUrl
      : sandboxScriptUrl,
    webhookSignatureKey,
    webhookNotificationUrl,
    paymentConfigured: integrationConfigured,
    webhookConfigured: integrationConfigured,
    issue,
  };
}

export function publicSquareConfiguration(
  configuration: SquareRuntimeConfiguration,
) {
  if (!configuration.paymentConfigured) return null;
  return {
    environment: configuration.environment,
    applicationId: configuration.applicationId,
    locationId: configuration.locationId,
    scriptUrl: configuration.scriptUrl,
  };
}
