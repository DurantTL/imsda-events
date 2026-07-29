# Attendee-account release checklist

Updated: 2026-07-29

The attendee-account code path is implemented and locally verified. This
checklist separates repository work from the provider and deployment work that
cannot be proved by a local test suite.

## Shipped behavior

- Separate attendee credentials, sessions, Google identities, and optional TOTP
- Verified-email registration claims and staff access to only their own matching account
- Retry-stable verification, password-reset, and edit codes whose short lifetime begins at delivery
- Password-reset responses that never wait on provider work only for known accounts
- Safe Google-subject rebind for verified Google-only accounts; mixed-method conflicts remain explicit
- Reusable attendee profile and matching-field registration prefill
- Account-authorized Square checkout without exposing a private management token
- Session-bound, single-use emailed codes for registration contact edits
- Platform default and per-event `TIERED` / `VERIFY_EVERY_EDIT` policy

## Deploy

1. Back up PostgreSQL and run `npm run db:deploy`.
2. Confirm all 42 migrations are applied with `npx prisma migrate status`.
3. Configure `APP_BASE_URL`, `SECRET_ENCRYPTION_KEY`,
   `RATE_LIMIT_HASH_SECRET`, `OUTBOX_SWEEP_TOKEN`, `RESEND_API_KEY`,
   `ACCOUNT_EMAIL_SENDER_ADDRESS`, and the normal production secrets documented
   in `docs/DEPLOY-DOCKER.md`.
4. If Google sign-in is enabled, configure both `GOOGLE_OAUTH_CLIENT_ID` and
   `GOOGLE_OAUTH_CLIENT_SECRET`, and register this exact redirect:
   `<APP_BASE_URL>/api/attendee/oauth/google/callback`.
5. Keep Square in Sandbox until the end-to-end payment rehearsal passes.

## Staging acceptance

- Create and verify a new attendee account through a real Resend delivery.
- Request the same email twice through a forced retry and confirm both sends
  carry the same usable code.
- Compare known and unknown password-reset requests from the browser; both
  responses must be identical and neither may wait on Resend.
- Sign in with password and Google, test the Google-only subject-rebind case,
  and confirm a mixed-method conflict does not rebind.
- Enrol TOTP, use a current code, use one recovery code once, and disable MFA.
- Save the attendee profile, open a new registration, and verify only matching
  form keys are prefilled.
- Pay a balance with a Square Sandbox test card and verify the receipt/outbox,
  idempotent retry, webhook, and balance.
- Request an edit code in one browser session. Confirm it works once there,
  fails in another session, and fails after expiry or five wrong guesses.
- Confirm a staff member reaches only the attendee account with the same
  verified email and cannot choose another attendee.

## Production-only confirmation

Run one controlled real-provider round trip before announcing the feature:

- Resend sender/domain verification and webhook delivery
- Google consent screen, production redirect URI, and token exchange
- Scheduled outbox sweep authorization and retry delivery
- Backup/restore evidence for the migrated production database

Do not treat a green build as evidence for these external checks. Record the
date, operator, provider event identifiers, and result in the deployment log.
