# WR26 email readiness audit

Companion evidence for [#140](https://github.com/DurantTL/imsda-events/issues/140) and the
human delivery checks in [#306](https://github.com/DurantTL/imsda-events/issues/306). This is an
evidence index, not permission to send production email or to change event configuration.

## Automated evidence — checked

- [x] `tests/phase-0-email-audit.test.ts` renders the default message set through the production
  HTML and plain-text pipeline for each supported seeded form template and representative paid,
  unpaid, worker, complimentary, waitlist, and deferred-organization states.
- [x] `tests/transactional-messages.test.ts` covers lifecycle enqueue behavior, recipient routing,
  private-link sentinels, waitlist language, transfer/substitution, cancellation/reactivation,
  receipts, refunds, announcements, and protected-answer exclusion.
- [x] `tests/delivery-sentinel-round-trip.test.ts` proves delivered HTML and plain text receive
  working private management and QR URLs without storing bearer tokens in snapshots.
- [x] Selected-audience and confirmation workflows are covered by the selected-audience,
  messaging-route, attendee-email, and registration-message resend tests introduced through
  #316, #331, #332, and #333.

## Required human evidence — not inferred from code

Record the date, deployed release SHA/build ID, event, result, and a non-sensitive evidence
reference on #140 or #306 for each applicable item.

- [ ] Inspect each required WR26 template in Communications: subject, rendered HTML, plain-text
  fallback, sender, reply-to, event dates/location/contact, and clean omission of optional blocks.
- [ ] Send/capture a real-client sample covering the primary payment/portal button and remote QR
  image in Gmail, Outlook, or Apple Mail. Link the evidence from #140 and #306 rather than
  duplicating the exercise.
- [ ] Verify selected-registration reminder and mixed paid/unpaid confirmation sends show the
  actual recipients, delivery mode, skips, and current registration state before dispatch.
- [ ] Confirm the historical confirmation resend remains available to authorized staff.
- [ ] Record the #327 payment-fallback disposition: approved and verified, or deliberately
  deferred with an operator payment-help path. Do not describe an unapproved fallback as shipped.
- [ ] Record known limitations, including any intentionally disabled template or held merchandise
  workflow.

## Scope boundaries

- Merchandise email is only applicable if the held merchandise capability is explicitly enabled.
- A real-client test uses synthetic data; do not attach production recipient data, private links,
  QR images, payment details, or secrets to an issue or commit.
- Passing automated tests confirms rendering and routing contracts. It does not prove the
  deployed sender, external delivery provider, mail client, or event configuration.
