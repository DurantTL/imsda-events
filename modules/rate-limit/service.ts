import "server-only";

import {
  getRateLimitConfiguration,
  hashRateLimitIdentifier,
  rateLimitClientIdentityHash,
  rateLimitSubjectHash,
  type RateLimitConfiguration,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import {
  enforceRateLimitRules,
  type RateLimitRule,
} from "@/modules/rate-limit/repository";

const fifteenMinutes = 15 * 60;
const oneHour = 60 * 60;

type RuleInput = {
  policy: string;
  limit: number;
  windowSeconds: number;
  identifierHashes: string[];
};

function rule(
  input: RuleInput,
  configuration: RateLimitConfiguration,
): RateLimitRule {
  return {
    policy: input.policy,
    limit: input.limit,
    windowSeconds: input.windowSeconds,
    subjectHash: rateLimitSubjectHash(
      input.policy,
      input.identifierHashes,
      configuration,
    ),
  };
}

async function evaluate(
  inputs: RuleInput[],
  configuration = getRateLimitConfiguration(),
): Promise<RateLimitOutcome> {
  return enforceRateLimitRules(
    inputs.map((input) => rule(input, configuration)),
  );
}

function requestIdentities(
  request: Request,
  configuration: RateLimitConfiguration,
) {
  return {
    client: rateLimitClientIdentityHash(request, configuration),
  };
}

export async function checkLoginClientRateLimit(request: Request) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  return evaluate([{
    policy: "auth.login.client",
    limit: 20,
    windowSeconds: fifteenMinutes,
    identifierHashes: [client],
  }], configuration);
}

export async function checkLoginAccountRateLimit(
  request: Request,
  email: string,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const account = hashRateLimitIdentifier(
    "staff-email",
    email.trim().toLowerCase(),
    configuration,
  );
  return evaluate([
    {
      policy: "auth.login.account",
      limit: 10,
      windowSeconds: fifteenMinutes,
      identifierHashes: [account],
    },
    {
      policy: "auth.login.client-account",
      limit: 5,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client, account],
    },
  ], configuration);
}

export async function checkPasswordResetClientRateLimit(request: Request) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  return evaluate([{
    policy: "auth.password-reset.client",
    limit: 10,
    windowSeconds: oneHour,
    identifierHashes: [client],
  }], configuration);
}

export async function checkPasswordResetAccountRateLimit(
  request: Request,
  email: string,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const account = hashRateLimitIdentifier(
    "staff-email",
    email.trim().toLowerCase(),
    configuration,
  );
  return evaluate([
    {
      policy: "auth.password-reset.account",
      limit: 3,
      windowSeconds: oneHour,
      identifierHashes: [account],
    },
    {
      policy: "auth.password-reset.client-account",
      limit: 3,
      windowSeconds: oneHour,
      identifierHashes: [client, account],
    },
  ], configuration);
}

export async function checkPublicRegistrationRateLimit(
  request: Request,
  eventSlug: string,
  formSlug: string,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const form = hashRateLimitIdentifier(
    "public-event-form",
    `${eventSlug.trim().toLowerCase()}/${formSlug.trim().toLowerCase()}`,
    configuration,
  );
  return evaluate([
    {
      policy: "public.registration.client",
      limit: 12,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client],
    },
    {
      policy: "public.registration.client-form",
      limit: 5,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client, form],
    },
  ], configuration);
}

export async function checkPublicPromoQuoteRateLimit(
  request: Request,
  eventSlug: string,
  formSlug: string,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const form = hashRateLimitIdentifier(
    "public-event-form",
    `${eventSlug.trim().toLowerCase()}/${formSlug.trim().toLowerCase()}`,
    configuration,
  );
  return evaluate([
    {
      policy: "public.promo-quote.client",
      limit: 30,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client],
    },
    {
      policy: "public.promo-quote.client-form",
      limit: 15,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client, form],
    },
  ], configuration);
}

export async function checkPublicManageRateLimit(
  request: Request,
  token: string,
  operation: "read" | "update",
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const tokenHash = hashRateLimitIdentifier(
    "registration-manage-token",
    token,
    configuration,
  );
  const read = operation === "read";
  return evaluate([
    {
      policy: `public.manage.${operation}.client`,
      limit: read ? 120 : 30,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client],
    },
    {
      policy: `public.manage.${operation}.token`,
      limit: read ? 120 : 20,
      windowSeconds: fifteenMinutes,
      identifierHashes: [tokenHash],
    },
    {
      policy: `public.manage.${operation}.client-token`,
      limit: read ? 60 : 10,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client, tokenHash],
    },
  ], configuration);
}

export async function checkPublicPaymentRateLimit(
  request: Request,
  token: string,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const tokenHash = hashRateLimitIdentifier(
    "registration-manage-token",
    token,
    configuration,
  );
  return evaluate([
    {
      policy: "public.payment.client",
      limit: 10,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client],
    },
    {
      policy: "public.payment.token",
      limit: 6,
      windowSeconds: fifteenMinutes,
      identifierHashes: [tokenHash],
    },
    {
      policy: "public.payment.client-token",
      limit: 5,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client, tokenHash],
    },
  ], configuration);
}
