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

/**
 * Staff sign-in budgets, per 15 minutes (#825). Every attempt is charged,
 * successful or not. A check-in desk signs one staff account in on 2-4 phones
 * and tablets at once, often behind one venue Wi-Fi or carrier-grade NAT
 * address, and a typo or two must not lock the fourth device out on arrival
 * morning. The real brute-force guards are the five-wrong-passwords account
 * lockout and the three-wrong-codes second-step lock, not these counts.
 */
export const staffLoginBudgets = { client: 60, account: 20, clientAccount: 12 } as const;

export async function checkLoginClientRateLimit(request: Request) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  return evaluate([{
    policy: "auth.login.client",
    limit: staffLoginBudgets.client,
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
      limit: staffLoginBudgets.account,
      windowSeconds: fifteenMinutes,
      identifierHashes: [account],
    },
    {
      policy: "auth.login.client-account",
      limit: staffLoginBudgets.clientAccount,
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

/**
 * Passkey sign-in (#374) names no account until the credential is checked,
 * so it is limited per client: loosely for asking for a prompt, and as
 * tightly as password sign-in for answering one.
 */
export async function checkAttendeePasskeySignInRateLimit(request: Request, stage: "options" | "verify") {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  return evaluate([{
    policy: stage === "options" ? "attendee.passkey-sign-in.options.client" : "attendee.passkey-sign-in.verify.client",
    limit: stage === "options" ? 30 : 20,
    windowSeconds: fifteenMinutes,
    identifierHashes: [client],
  }], configuration);
}

/**
 * Staff passkey sign-in (#429) names no account until the credential is
 * checked, so — like the attendee version above — it is limited per client:
 * loosely for asking for a prompt, and as tightly as password sign-in for
 * answering one.
 */
export async function checkStaffPasskeySignInRateLimit(request: Request, stage: "options" | "verify") {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  return evaluate([{
    policy: stage === "options" ? "staff.passkey-sign-in.options.client" : "staff.passkey-sign-in.verify.client",
    limit: stage === "options" ? 30 : 20,
    windowSeconds: fifteenMinutes,
    identifierHashes: [client],
  }], configuration);
}

/**
 * Staff passkey management (#429): starting or finishing an add, renaming,
 * and removing. Each add or remove carries a fresh code, passkey answer, or
 * password, so this is a cheap per-account ceiling on how fast those proofs
 * can be tried from a signed-in session, on top of their own lockouts.
 */
export async function checkStaffPasskeyManagementRateLimit(request: Request, userId: string) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const account = hashRateLimitIdentifier("staff-passkey-management", userId, configuration);
  return evaluate([
    {
      policy: "staff.passkey-management.client",
      limit: 60,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client],
    },
    {
      policy: "staff.passkey-management.account",
      limit: 20,
      windowSeconds: fifteenMinutes,
      identifierHashes: [account],
    },
  ], configuration);
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
  // About one registration a minute from one address (WR26): an office or a
  // church coordinator entering several people back to back is not stopped,
  // while a script still is.
  return evaluate([
    {
      policy: "public.registration.client",
      limit: 30,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client],
    },
    {
      policy: "public.registration.client-form",
      limit: 15,
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
      limit: 60,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client],
    },
    {
      // Room for one check per registration plus re-checks when the price changes.
      policy: "public.promo-quote.client-form",
      limit: 45,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client, form],
    },
  ], configuration);
}

/**
 * Per-operation budgets for private manage-link requests, per 15 minutes.
 *
 * `pass` is the attendee QR image. It gets its own, larger client budget
 * because it is fetched far more often and from shared addresses: every open
 * of a confirmation or announcement email loads it through the mail
 * provider's image proxy, and at check-in a whole retreat pulls up passes on
 * the same venue Wi-Fi. Under the ordinary read budget, one email blast or
 * one arrival rush could refuse passes to everyone behind that address. The
 * token itself is a long random secret, so the looser client budget does not
 * make guessing one practical; the per-token budgets still cap any one link.
 *
 * #825: phones on cellular reach us through carrier-grade NAT, where
 * unrelated attendees in one lobby share a public address, so the per-client
 * numbers for `read` and `pass` are sized for a crowd (a 500-person retreat
 * opening passes in 15 minutes), while the per-link numbers stay small. The
 * client budget for `update` is untouched.
 */
export const publicManageBudgets = {
  read: { client: 600, token: 120, clientToken: 60 },
  update: { client: 30, token: 20, clientToken: 10 },
  pass: { client: 3000, token: 600, clientToken: 300 },
} as const;

export async function checkPublicManageRateLimit(
  request: Request,
  token: string,
  operation: keyof typeof publicManageBudgets,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const tokenHash = hashRateLimitIdentifier(
    "registration-manage-token",
    token,
    configuration,
  );
  const budget = publicManageBudgets[operation];
  return evaluate([
    {
      policy: `public.manage.${operation}.client`,
      limit: budget.client,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client],
    },
    {
      policy: `public.manage.${operation}.token`,
      limit: budget.token,
      windowSeconds: fifteenMinutes,
      identifierHashes: [tokenHash],
    },
    {
      policy: `public.manage.${operation}.client-token`,
      limit: budget.clientToken,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client, tokenHash],
    },
  ], configuration);
}

/**
 * Roommate lookups by name and confirmation code (#199) get their own, tighter budget on top of the ordinary update
 * budget: 5 per private link and 10 per client every 15 minutes (and 5 per client and link together), so the form
 * cannot be used to guess confirmation codes.
 */
export async function checkPublicRoommateLookupRateLimit(request: Request, token: string) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const tokenHash = hashRateLimitIdentifier("registration-manage-token", token, configuration);
  return evaluate([
    { policy: "public.manage.roommate-lookup.client", limit: 10, windowSeconds: fifteenMinutes, identifierHashes: [client] },
    { policy: "public.manage.roommate-lookup.token", limit: 5, windowSeconds: fifteenMinutes, identifierHashes: [tokenHash] },
    { policy: "public.manage.roommate-lookup.client-token", limit: 5, windowSeconds: fifteenMinutes, identifierHashes: [client, tokenHash] },
  ], configuration);
}

/**
 * A registration form submission that asks to room with someone by name and confirmation code (#199) can be used to
 * guess codes, so it gets its own, tighter budget on top of the registration budget: 10 per client and 5 per client
 * and form every 15 minutes.
 */
export async function checkPublicFormRoommateLookupRateLimit(request: Request, eventSlug: string, formSlug: string) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const form = hashRateLimitIdentifier("public-event-form", `${eventSlug.trim().toLowerCase()}/${formSlug.trim().toLowerCase()}`, configuration);
  return evaluate([
    { policy: "public.registration.roommate-lookup.client", limit: 10, windowSeconds: fifteenMinutes, identifierHashes: [client] },
    { policy: "public.registration.roommate-lookup.client-form", limit: 5, windowSeconds: fifteenMinutes, identifierHashes: [client, form] },
  ], configuration);
}

/** The hashed client identity of a request (never the address itself), for an audit entry about a pattern of misses. */
export function publicRequestClientHash(request: Request) {
  return requestIdentities(request, getRateLimitConfiguration()).client;
}

/**
 * The read-only payment status poll behind Square's return page (#327). It has its own buckets, so
 * a page that polls every few seconds never spends the budget the payment-writing routes share,
 * and a payer waiting on Square cannot be locked out of paying by their own status checks. A page
 * polls about 24 times in its two minutes; the budgets leave room for several pages and reloads.
 */
export const publicPaymentStatusBudgets = { client: 300, clientId: 120 } as const;

export async function checkPublicPaymentStatusRateLimit(
  request: Request,
  statusId: string,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const idHash = hashRateLimitIdentifier(
    "square-return-id",
    statusId,
    configuration,
  );
  return evaluate([
    {
      policy: "public.payment-status.client",
      limit: publicPaymentStatusBudgets.client,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client],
    },
    {
      policy: "public.payment-status.client-id",
      limit: publicPaymentStatusBudgets.clientId,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client, idHash],
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

/**
 * Community posting is authenticated, but an active registration should not
 * make it possible to flood an event's attendee timeline. Posts and replies
 * deliberately have separate, event-scoped attendee buckets: a helpful
 * conversation can have more replies without permitting rapid new threads.
 */
export async function checkAttendeeCommunityPostRateLimit(
  request: Request,
  accountId: string,
  eventId: string,
  kind: "post" | "reply",
) {
  const configuration = getRateLimitConfiguration();
  const accountEvent = hashRateLimitIdentifier(
    "attendee-community-account-event",
    `${accountId}\u0000${eventId}`,
    configuration,
  );
  return evaluate([{
    policy: `attendee.community.${kind}.account`,
    limit: kind === "post" ? 6 : 12,
    windowSeconds: fifteenMinutes,
    identifierHashes: [accountEvent],
  }], configuration);
}

/**
 * Entering an authenticator code to open club rosters (#356). Tight on the
 * account because a six-digit code is guessable given enough tries.
 */
export async function checkAttendeeRosterUnlockRateLimit(
  request: Request,
  accountId: string,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const account = hashRateLimitIdentifier(
    "attendee-roster-unlock",
    accountId,
    configuration,
  );
  return evaluate([
    {
      policy: "attendee.roster-unlock.client",
      limit: 20,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client],
    },
    {
      policy: "attendee.roster-unlock.account",
      limit: 5,
      windowSeconds: fifteenMinutes,
      identifierHashes: [account],
    },
  ], configuration);
}

const oneDay = 24 * 60 * 60;

/**
 * A club member transfer request (#489) is matched against another club's
 * roster, so an unlimited one is a slow way to test names against it, even
 * though every answer reads "request sent". Held per acting director (their
 * attendee account, or a staff user acting as director), per receiving club,
 * and per client.
 */
export async function checkClubTransferRequestRateLimit(
  request: Request,
  actorKey: string,
  organizationId: string,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const actor = hashRateLimitIdentifier("club-transfer-actor", actorKey, configuration);
  const club = hashRateLimitIdentifier("club-transfer-club", organizationId, configuration);
  return evaluate([
    {
      policy: "club-transfer.request.client",
      limit: 20,
      windowSeconds: oneHour,
      identifierHashes: [client],
    },
    {
      policy: "club-transfer.request.actor",
      limit: 10,
      windowSeconds: oneHour,
      identifierHashes: [actor],
    },
    {
      policy: "club-transfer.request.club",
      limit: 30,
      windowSeconds: oneDay,
      identifierHashes: [club],
    },
  ], configuration);
}

/**
 * Per-operation budgets for a club form's private link (#610), per 15
 * minutes. The token is a 256-bit secret, so these exist to stop scripted
 * guessing and hammering, not to slow a parent filling in a form: `read` is
 * opening the page, `submit` is sending the answers.
 */
const clubFormLinkBudgets = {
  read: { client: 60, token: 60, clientToken: 30 },
  submit: { client: 20, token: 10, clientToken: 6 },
} as const;

export async function checkClubFormLinkRateLimit(
  request: Request,
  token: string,
  operation: keyof typeof clubFormLinkBudgets,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const tokenHash = hashRateLimitIdentifier("club-form-link-token", token, configuration);
  const budget = clubFormLinkBudgets[operation];
  return evaluate([
    {
      policy: `club-form.link.${operation}.client`,
      limit: budget.client,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client],
    },
    {
      policy: `club-form.link.${operation}.token`,
      limit: budget.token,
      windowSeconds: fifteenMinutes,
      identifierHashes: [tokenHash],
    },
    {
      policy: `club-form.link.${operation}.client-token`,
      limit: budget.clientToken,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client, tokenHash],
    },
  ], configuration);
}

/**
 * Sending a club form link (#610) emails an address a director typed, so an
 * unlimited one is a way to mail a stranger repeatedly. Held per acting
 * director, per club, per client, and, tightest, per recipient address.
 */
export async function checkClubFormLinkCreateRateLimit(
  request: Request,
  actorKey: string,
  organizationId: string,
  recipientEmail: string,
) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const actor = hashRateLimitIdentifier("club-form-link-actor", actorKey, configuration);
  const club = hashRateLimitIdentifier("club-form-link-club", organizationId, configuration);
  const recipient = hashRateLimitIdentifier("club-form-link-recipient", recipientEmail.trim().toLowerCase(), configuration);
  return evaluate([
    {
      policy: "club-form.link-create.client",
      limit: 30,
      windowSeconds: oneHour,
      identifierHashes: [client],
    },
    {
      policy: "club-form.link-create.actor",
      limit: 20,
      windowSeconds: oneHour,
      identifierHashes: [actor],
    },
    {
      policy: "club-form.link-create.club",
      limit: 60,
      windowSeconds: oneDay,
      identifierHashes: [club],
    },
    {
      policy: "club-form.link-create.recipient",
      limit: 3,
      windowSeconds: oneHour,
      identifierHashes: [recipient],
    },
    {
      policy: "club-form.link-create.club-recipient",
      limit: 2,
      windowSeconds: oneHour,
      identifierHashes: [club, recipient],
    },
  ], configuration);
}

/**
 * Feature requests (#741): each one emails the conference office, so an event
 * admin may not send many. A few an hour per account is plenty for a real need.
 */
export async function checkModuleRequestRateLimit(request: Request, userId: string) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const account = hashRateLimitIdentifier("staff-module-request", userId, configuration);
  return evaluate([
    {
      policy: "staff.module-request.client",
      limit: 20,
      windowSeconds: oneHour,
      identifierHashes: [client],
    },
    {
      policy: "staff.module-request.account",
      limit: 10,
      windowSeconds: oneHour,
      identifierHashes: [account],
    },
  ], configuration);
}

/**
 * The public "Register a new club" form (#817). Submitting writes a row and
 * emails the conference, so it is held tight: six an hour from one address,
 * charged once per submit (the route calls this once, before parsing the
 * body), and only three a day naming the same director email
 * (`checkNewClubApplicationEmailRateLimit`, charged after the body is read).
 */
export async function checkNewClubApplicationSubmitRateLimit(request: Request) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  return evaluate([{
    policy: "club-application.submit.client",
    limit: 6,
    windowSeconds: oneHour,
    identifierHashes: [client],
  }], configuration);
}

export async function checkNewClubApplicationEmailRateLimit(directorEmail: string) {
  const configuration = getRateLimitConfiguration();
  const email = hashRateLimitIdentifier(
    "club-application-director-email",
    directorEmail.trim().toLowerCase(),
    configuration,
  );
  return evaluate([{
    policy: "club-application.submit.email",
    limit: 3,
    windowSeconds: 24 * oneHour,
    identifierHashes: [email],
  }], configuration);
}

/** Opening an invite's private link (#817): the token is a 256-bit secret, so this only stops scripted guessing. */
export async function checkNewClubApplicationLinkRateLimit(request: Request, token: string) {
  const configuration = getRateLimitConfiguration();
  const { client } = requestIdentities(request, configuration);
  const tokenHash = hashRateLimitIdentifier("club-application-link-token", token, configuration);
  return evaluate([
    {
      policy: "club-application.link.client",
      limit: 60,
      windowSeconds: fifteenMinutes,
      identifierHashes: [client],
    },
    {
      policy: "club-application.link.token",
      limit: 60,
      windowSeconds: fifteenMinutes,
      identifierHashes: [tokenHash],
    },
  ], configuration);
}
