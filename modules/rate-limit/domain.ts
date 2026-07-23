import { createHmac } from "node:crypto";
import { isIP } from "node:net";

type RateLimitEnvironment = "development" | "test" | "production";
type TrustedClientIpHeader =
  | "x-forwarded-for"
  | "x-real-ip"
  | "cf-connecting-ip";

export type RateLimitConfiguration = {
  environment: RateLimitEnvironment;
  hashSecret: string;
  trustedProxyHops: number;
  clientIpHeader: TrustedClientIpHeader;
};

export type RateLimitDecision = {
  policy: string;
  allowed: boolean;
  limit: number;
  remaining: number;
  count: number;
  windowSeconds: number;
  resetAfterSeconds: number;
};

export type RateLimitOutcome = {
  allowed: boolean;
  decisions: RateLimitDecision[];
};

export class RateLimitConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitConfigurationError";
  }
}

const localHashSecret = "imsda-events-local-rate-limit-secret-v1";
const supportedIpHeaders = new Set<TrustedClientIpHeader>([
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
]);

export function getRateLimitConfiguration(
  source: Record<string, string | undefined> = process.env,
): RateLimitConfiguration {
  const environment = source.NODE_ENV === "production"
    ? "production"
    : source.NODE_ENV === "test"
      ? "test"
      : "development";
  const configuredSecret = source.RATE_LIMIT_HASH_SECRET?.trim() ?? "";
  if (environment === "production" && configuredSecret.length < 32) {
    throw new RateLimitConfigurationError(
      "RATE_LIMIT_HASH_SECRET must contain at least 32 characters in production.",
    );
  }

  const hopsValue = source.RATE_LIMIT_TRUSTED_PROXY_HOPS?.trim() || "0";
  if (!/^\d+$/.test(hopsValue)) {
    throw new RateLimitConfigurationError(
      "RATE_LIMIT_TRUSTED_PROXY_HOPS must be a whole number from 0 through 10.",
    );
  }
  const trustedProxyHops = Number(hopsValue);
  if (trustedProxyHops > 10) {
    throw new RateLimitConfigurationError(
      "RATE_LIMIT_TRUSTED_PROXY_HOPS must be a whole number from 0 through 10.",
    );
  }

  const rawHeader = (
    source.RATE_LIMIT_CLIENT_IP_HEADER?.trim().toLowerCase()
    || "x-forwarded-for"
  ) as TrustedClientIpHeader;
  if (!supportedIpHeaders.has(rawHeader)) {
    throw new RateLimitConfigurationError(
      "RATE_LIMIT_CLIENT_IP_HEADER must be x-forwarded-for, x-real-ip, or cf-connecting-ip.",
    );
  }
  if (trustedProxyHops > 1 && rawHeader !== "x-forwarded-for") {
    throw new RateLimitConfigurationError(
      "Only x-forwarded-for can represent more than one trusted proxy hop.",
    );
  }

  return {
    environment,
    hashSecret: configuredSecret || localHashSecret,
    trustedProxyHops,
    clientIpHeader: rawHeader,
  };
}

function normalizeIpCandidate(value: string) {
  let candidate = value.trim();
  if (!candidate) return null;
  if (candidate.startsWith("[") && candidate.includes("]")) {
    candidate = candidate.slice(1, candidate.indexOf("]"));
  } else if (
    candidate.includes(".")
    && candidate.split(":").length === 2
  ) {
    candidate = candidate.split(":")[0];
  }
  if (candidate.toLowerCase().startsWith("::ffff:")) {
    const mapped = candidate.slice(7);
    if (isIP(mapped) === 4) candidate = mapped;
  }
  return isIP(candidate) ? candidate.toLowerCase() : null;
}

function trustedClientIp(
  request: Request,
  configuration: RateLimitConfiguration,
) {
  if (configuration.trustedProxyHops === 0) return null;
  const headerValue = request.headers.get(configuration.clientIpHeader);
  if (!headerValue) return null;
  if (configuration.clientIpHeader !== "x-forwarded-for") {
    return normalizeIpCandidate(headerValue);
  }

  const chain = headerValue.split(",").map((entry) => entry.trim());
  const clientIndex = chain.length - configuration.trustedProxyHops;
  if (clientIndex < 0 || clientIndex >= chain.length) return null;
  return normalizeIpCandidate(chain[clientIndex]);
}

export function hashRateLimitIdentifier(
  namespace: string,
  value: string,
  configuration: RateLimitConfiguration,
) {
  const normalizedNamespace = namespace.trim().toLowerCase();
  const normalizedValue = value.trim();
  return createHmac("sha256", configuration.hashSecret)
    .update(`${normalizedNamespace.length}:${normalizedNamespace}`)
    .update(`${normalizedValue.length}:${normalizedValue}`)
    .digest("hex");
}

export function rateLimitClientIdentityHash(
  request: Request,
  configuration = getRateLimitConfiguration(),
) {
  const ip = trustedClientIp(request, configuration);
  if (ip) {
    return hashRateLimitIdentifier("client-ip", ip, configuration);
  }

  if (configuration.environment !== "production") {
    const userAgent = (request.headers.get("user-agent") ?? "unknown")
      .slice(0, 512);
    return hashRateLimitIdentifier(
      "local-client",
      userAgent,
      configuration,
    );
  }

  // Route handlers cannot safely infer the network peer. If production proxy
  // trust is not explicitly configured (or its header is missing/invalid),
  // all such requests share a fail-closed bucket instead of trusting a
  // spoofable forwarding header.
  return hashRateLimitIdentifier(
    "unresolved-production-client",
    "shared",
    configuration,
  );
}

export function rateLimitSubjectHash(
  policy: string,
  identifierHashes: readonly string[],
  configuration: RateLimitConfiguration,
) {
  return hashRateLimitIdentifier(
    "bucket-subject",
    JSON.stringify([policy, ...identifierHashes]),
    configuration,
  );
}

function bindingDecision(outcome: RateLimitOutcome) {
  const denied = outcome.decisions.filter((decision) => !decision.allowed);
  if (denied.length > 0) {
    return denied.reduce((selected, decision) => (
      decision.resetAfterSeconds > selected.resetAfterSeconds
        ? decision
        : selected
    ));
  }
  return outcome.decisions.reduce((selected, decision) => {
    const selectedRatio = selected.remaining / selected.limit;
    const decisionRatio = decision.remaining / decision.limit;
    if (decisionRatio < selectedRatio) return decision;
    if (
      decisionRatio === selectedRatio
      && decision.resetAfterSeconds < selected.resetAfterSeconds
    ) {
      return decision;
    }
    return selected;
  });
}

export function mergeRateLimitOutcomes(
  ...outcomes: Array<RateLimitOutcome | null | undefined>
): RateLimitOutcome {
  const decisions = outcomes.flatMap((outcome) => outcome?.decisions ?? []);
  return {
    allowed: decisions.every((decision) => decision.allowed),
    decisions,
  };
}

export function rateLimitHeaders(outcome: RateLimitOutcome) {
  if (outcome.decisions.length === 0) return {};
  const binding = bindingDecision(outcome);
  const policies = Array.from(new Set(
    outcome.decisions.map(
      (decision) => `${decision.limit};w=${decision.windowSeconds}`,
    ),
  ));
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(binding.limit),
    "RateLimit-Remaining": String(binding.remaining),
    "RateLimit-Reset": String(binding.resetAfterSeconds),
    "RateLimit-Policy": policies.join(", "),
  };
  if (!outcome.allowed) {
    headers["Retry-After"] = String(Math.max(
      1,
      ...outcome.decisions
        .filter((decision) => !decision.allowed)
        .map((decision) => decision.resetAfterSeconds),
    ));
  }
  return headers;
}

export function applyRateLimitHeaders(
  response: Response,
  outcome: RateLimitOutcome,
) {
  Object.entries(rateLimitHeaders(outcome)).forEach(([name, value]) => {
    response.headers.set(name, value);
  });
  return response;
}
