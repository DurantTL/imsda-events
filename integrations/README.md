# Integration boundary

WordPress, FluentCRM, Google Sheets, UltraCamp, eAdventist, and Sterling remain disconnected. Any future adapter belongs behind a reviewed interface with queued delivery, retries, redaction, and reconciliation. Active provider boundaries currently live with the domain that owns them: Resend under communications and Square under payments.

## Square

`modules/payments/square-adapter.ts` is the server-only Payments API boundary. It accepts only a short-lived source token from Square Web Payments; raw card numbers never pass through the application server or form responses.

The adapter defaults to Square Sandbox. Configure the variables documented in `.env.example`. Production calls remain locked unless both `SQUARE_ENVIRONMENT=production` and `SQUARE_ENABLE_PRODUCTION=true` are deliberately set after launch approval.

The builder and public registration transaction calculate and snapshot server-authoritative totals and the fully grossed-up card fee without Square credentials. The private registration page loads hosted card fields only for an eligible card-selected balance. Durable payment attempts, idempotent retry, signed/deduplicated payment/refund webhooks, first-success receipts, and Square-managed refund safeguards are implemented.

## Resend

`integrations/email/resend.ts` is the server-only Resend provider boundary; `modules/communications/email-delivery.ts` calls it to send committed outbox snapshots when an event selects external email and `RESEND_API_KEY` is configured. Provider idempotency, claim locks, backoff, delivery-event reconciliation, and in-memory private-link insertion prevent duplicate sends and keep raw bearer links out of storage. Inbound provider events are verified in `integrations/email/resend-webhook.ts`.
