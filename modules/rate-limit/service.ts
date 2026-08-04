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

/**
 * Attendee sign-up is a public, unauthenticated endpoint that sends email to
 * an address chosen by whoever calls it — the most abusable surface the platform
 * has (ADR 0003). The per-address limit is the one that matters: without it,
 * sign-up is a way to mail a stranger repeatedly, and the fact that the platform
 * would not create an account for them is no comfort to the person receiving it.
 */
export async function checkAttendeeSignUpRateLimit(
  request: Request,
  email: string,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const account = hashRateLimitIdentifier(
    "attendee-email",
    email.trim().toLowerCase(),
    configuration,
  );
  return evaluate([
    {
      policy: "attendee.sign-up.client",
      limit: 10,
      windowSeconds: oneHour,
      identifierHashes: [client],
    },
    {
      policy: "attendee.sign-up.account",
      limit: 3,
      windowSeconds: oneHour,
      identifierHashes: [account],
    },
    {
      policy: "attendee.sign-up.client-account",
      limit: 3,
      windowSeconds: oneHour,
      identifierHashes: [client, account],
    },
  ], configuration);
}

/**
 * Guessing the emailed code. The token's own attempt ceiling already stops a
 * sustained attack on one verification; this stops someone working through many
 * verifications, or reissuing to reset the ceiling.
 */
export async function checkAttendeeVerificationRateLimit(request: Request) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  return evaluate([{
    policy: "attendee.verify.client",
    limit: 20,
    windowSeconds: fifteenMinutes,
    identifierHashes: [client],
  }], configuration);
}

export async function checkAttendeeEditStepUpRateLimit(
  request: Request,
  accountId: string,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const account = hashRateLimitIdentifier(
    "attendee-edit-step-up",
    accountId,
    configuration,
  );
  return evaluate([
    {
      policy: "attendee.edit-step-up.client",
      limit: 10,
      windowSeconds: oneHour,
      identifierHashes: [client],
    },
    {
      policy: "attendee.edit-step-up.account",
      limit: 3,
      windowSeconds: oneHour,
      identifierHashes: [account],
    },
  ], configuration);
}

/**
 * The other public, unauthenticated, email-sending attendee endpoint, and held
 * tighter than sign-up: nobody legitimately needs three password resets an
 * hour, and each request retires the previous code, so an unlimited one is also
 * a way to keep a real owner's reset perpetually out of date.
 */
export async function checkAttendeePasswordResetRateLimit(
  request: Request,
  email: string,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const account = hashRateLimitIdentifier(
    "attendee-email",
    email.trim().toLowerCase(),
    configuration,
  );
  return evaluate([
    {
      policy: "attendee.password-reset.client",
      limit: 10,
      windowSeconds: oneHour,
      identifierHashes: [client],
    },
    {
      policy: "attendee.password-reset.account",
      limit: 3,
      windowSeconds: oneHour,
      identifierHashes: [account],
    },
    {
      policy: "attendee.password-reset.client-account",
      limit: 3,
      windowSeconds: oneHour,
      identifierHashes: [client, account],
    },
  ], configuration);
}

/**
 * Direct access accepts two pieces of registration knowledge and returns a
 * private bearer link. The combined subject bucket limits broad guessing.
 */
export async function checkRegistrationCodeAccessRateLimit(
  request: Request,
  input: { email: string; confirmationCode: string },
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const email = hashRateLimitIdentifier(
    "registration-code-access-email",
    input.email.trim().toLowerCase(),
    configuration,
  );
  const confirmationCode = hashRateLimitIdentifier(
    "registration-code-access-code",
    input.confirmationCode.trim().toUpperCase(),
    configuration,
  );
  const pair = hashRateLimitIdentifier(
    "registration-code-access-pair",
    `${input.confirmationCode.trim().toUpperCase()}\u0000${input.email.trim().toLowerCase()}`,
    configuration,
  );
  return evaluate([
    {
      policy: "registration.code-access.client",
      limit: 10,
      windowSeconds: oneHour,
      identifierHashes: [client],
    },
    {
      policy: "registration.code-access.email",
      limit: 5,
      windowSeconds: oneHour,
      identifierHashes: [email],
    },
    {
      policy: "registration.code-access.code",
      limit: 5,
      windowSeconds: oneHour,
      identifierHashes: [confirmationCode],
    },
    {
      policy: "registration.code-access.pair",
      limit: 3,
      windowSeconds: oneHour,
      identifierHashes: [pair],
    },
    {
      policy: "registration.code-access.client-email",
      limit: 3,
      windowSeconds: oneHour,
      identifierHashes: [client, email],
    },
    {
      policy: "registration.code-access.client-code",
      limit: 3,
      windowSeconds: oneHour,
      identifierHashes: [client, confirmationCode],
    },
    {
      policy: "registration.code-access.client-pair",
      limit: 3,
      windowSeconds: oneHour,
      identifierHashes: [client, pair],
    },
  ], configuration);
}

export async function checkRegistrationRecoveryRateLimit(
  request: Request,
  email: string,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const recoverySubject = hashRateLimitIdentifier(
    "registration-recovery-email",
    email.trim().toLowerCase(),
    configuration,
  );
  return evaluate([
    {
      policy: "registration.recovery.client",
      limit: 10,
      windowSeconds: oneHour,
      identifierHashes: [client],
    },
    {
      policy: "registration.recovery.subject",
      limit: 3,
      windowSeconds: oneHour,
      identifierHashes: [recoverySubject],
    },
    {
      policy: "registration.recovery.client-subject",
      limit: 3,
      windowSeconds: oneHour,
      identifierHashes: [client, recoverySubject],
    },
  ], configuration);
}

/**
 * Starting a Google sign-in costs nothing here but a redirect, so the limit is
 * loose. It exists so a script cannot mint handoff cookies indefinitely.
 */
export async function checkAttendeeOAuthStartRateLimit(request: Request) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  return evaluate([{
    policy: "attendee.oauth.start.client",
    limit: 30,
    windowSeconds: fifteenMinutes,
    identifierHashes: [client],
  }], configuration);
}

/**
 * The callback does real work — a token exchange with Google and a key fetch —
 * so it is held tighter than the start. There is no per-address rule because
 * the address is not known until the exchange has already happened.
 */
export async function checkAttendeeOAuthCallbackRateLimit(request: Request) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  return evaluate([{
    policy: "attendee.oauth.callback.client",
    limit: 20,
    windowSeconds: fifteenMinutes,
    identifierHashes: [client],
  }], configuration);
}

export async function checkAttendeeSignInRateLimit(
  request: Request,
  email: string,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const account = hashRateLimitIdentifier(
    "attendee-email",
    email.trim().toLowerCase(),
    configuration,
  );
  return evaluate([
    {
      policy: "attendee.sign-in.client",
      limit: 20,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client],
    },
    {
      policy: "attendee.sign-in.account",
      limit: 10,
      windowSeconds: fifteenMinutes,
      identifierHashes: [account],
    },
    {
      policy: "attendee.sign-in.client-account",
      limit: 5,
      windowSeconds: fifteenMinutes,
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
