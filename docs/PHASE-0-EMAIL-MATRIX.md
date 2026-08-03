# Phase 0 email matrix and gap audit

Audited against `origin/main` at `cc6d4da` on August 3, 2026. This is the Phase 0 planning evidence required by issues #66 and #139. It records current production behavior; it does not claim that blocked messages already exist.

## Applicability matrix

Legend:

- `R` — required now.
- `O` — optional now when the event enables the related workflow.
- `N` — not applicable to this form template in Phase 0.
- `B1`–`B5` — required or conditionally required, but blocked by the bounded gap with that identifier below.
- `#143` — blocked by the existing deferred-organization billing issue.

| Message | Simple RSVP | Retreat registration | Household interest | Women’s Retreat 2026 | Man Camp 2026 | Spring Camporee 2026 | Camp Meeting 2026 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1. Registration received — paid | N | N | N | R | R | N | R |
| 2. Registration received — balance due/pay later | N | N | N | B5 | B5 | N | B5 |
| 3. Zero-dollar/complimentary or worker confirmation | R | R | R | R | R | #143 | O |
| 4. Waitlist entry | O | O | O | R | O | O | R |
| 5. Waitlist promotion | O | O | O | R | O | O | R |
| 6. Waitlist removal/decline | B1 | B1 | B1 | B1 | B1 | B1 | B1 |
| 7. Registration updated | B2 | B2 | B2 | B2 | B2 | B2 | B2 |
| 8. Contact email changed | R | R | R | R | R | R | R |
| 9. Whole-registration transfer — prior contact | R | R | R | R | R | R | R |
| 10. Whole-registration transfer — new contact | R | R | R | R | R | R | R |
| 11. Attendee substitution — prior attendee | N | R | N | R | R | R | R |
| 12. Attendee substitution — new attendee | N | R | N | R | R | R | R |
| 13. Cancellation | R | R | R | R | R | R | R |
| 14. Reactivation | B3 | B3 | B3 | B3 | B3 | B3 | B3 |
| 15. Payment receipt | N | N | N | R | R | N | R |
| 16. Refund notice | N | N | N | B4 | B4 | N | B4 |
| 17. Balance reminder | N | N | N | R | R | N | R |
| 18. Staff resend/corrected-address confirmation | R | R | R | R | R | R | R |
| 19. Published announcement broadcast | O | O | O | O | O | O | O |
| 20. Event-specific pre-arrival/reminder email | O | O | O | R | R | R | R |

The full event templates require pre-arrival content, but the current `EVENT_ANNOUNCEMENT` workflow can carry it after staff publish event-owned content and explicitly start the broadcast. Phase 0 does not require scheduled delivery.

## Current production mappings

| Matrix message | Current implementation |
| --- | --- |
| Paid confirmation | `REGISTRATION_CONFIRMATION_PAID` |
| Balance-due confirmation | `REGISTRATION_CONFIRMATION_UNPAID`; rendering exists, while event-owned payment guidance is blocked by B5 |
| Complimentary confirmation | `REGISTRATION_CONFIRMATION_PAID` with a generated `COMPLIMENTARY` payment-status block |
| Worker confirmation | `WORKER_CONFIRMATION` |
| Waitlist entry/promotion | `WAITLIST_JOINED`, `WAITLIST_PROMOTED` |
| Contact change | `REGISTRATION_CONTACT_UPDATED` |
| Whole-registration transfer | `REGISTRATION_TRANSFERRED_PRIOR_CONTACT`, `REGISTRATION_TRANSFERRED_NEW_CONTACT` |
| Attendee substitution | `ATTENDEE_SUBSTITUTED`; the same immutable template is rendered separately for each distinct eligible recipient |
| Cancellation | `REGISTRATION_CANCELLED` |
| Payment receipt | `PAYMENT_RECEIPT` |
| Balance reminder | `BALANCE_REMINDER` through a reviewed, fingerprinted batch |
| Staff resend/corrected address | Copies the selected immutable source snapshots; it does not create a second content template |
| Announcement/pre-arrival | `EVENT_ANNOUNCEMENT` with staff-authored event content |

`INTERNAL_NEW_REGISTRATION`, `SHIRT_SIZE_REQUEST`, and `REGISTRATION_ACCESS_RECOVERY` are current supplementary templates outside the 20-row matrix.

## Synthetic fixtures and rendered captures

`tests/phase-0-email-audit.test.ts` contains one event fixture for every form template and registrations for the applicable paid, unpaid, complimentary/worker, waitlisted, individual, group, and deferred-organization states. Every address uses `example.test`, every confirmation code contains `DEMO`, and no fixture contains production attendee data.

The audit renders all 16 current default templates for all 21 applicable synthetic registration states through `renderMessageTemplate`, producing 336 in-memory captures. Each capture includes:

- event identity, template key, registration state, and individual/group registration type;
- recipient kind;
- sender and reply-to identity;
- rendered subject;
- rendered plain text;
- rendered HTML;
- completion state and unresolved tokens.

The test fails if any event, registration, or template combination lacks rendered evidence, or if a capture contains unresolved tokens, multiline subjects, malformed HTML output, or another fixture's event location or contact address. The Spring Camporee deferred-organization fixture deliberately has no current lifecycle template mapping; the capture audit exercises the production rendering pipeline without hiding the #143 delivery gap.

## Event-owned token sources

| Content | Current authoritative source | Audit result |
| --- | --- | --- |
| Event name | `Event.name` | Available |
| Dates | `Event.startsAt`, `Event.endsAt`, formatted with `Event.timezone` | Available |
| Venue/location | `Event.location` | Available |
| Public contact | `Event.supportContact`, then event reply-to/sender fallback | Available |
| Sender and reply-to | `EventMessageSettings.senderName`, `senderEmail`, `replyToEmail` | Available |
| Lodging | `Event.hotelName`, `hotelBookingUrl`, `hotelPhone`, `hotelGroupName`, `hotelRate`, `hotelInstructions` | Available; omitted when no hotel name is configured |
| Registration contact | Immutable registration contact snapshot, then account-holder fallback | Available |
| Attendee/household summary | Submitted form definition and responses during initial confirmation; persisted attendee names for later lifecycle mail | Available; later messages do not reconstruct every submitted answer |
| Amounts and payment state | Registration total plus successful payments and refunds; state-specific server-generated block | Available |
| Payment instructions | Generic server wording derived from current balance/state | B5: no event-owned approved guidance source exists |
| Schedule and resources | Published event content and staff-authored announcement body | Available for announcements; no dedicated confirmation token |
| Childcare, meals, volunteer information | Versioned form definition and submitted attendee responses | Available in the initial registration summary; event instructions require staff-authored content |
| Portal and QR links | Delivery-time registration token sentinels and check-in token builders | Available; preview uses safe non-live URLs |
| Wallet links | No provider implementation | Safely omitted; remains in #53/Phase 3 |

## Existing blocked work

- #61 owns passwordless registration management and update messages. Its bounded Phase 0 slices are #141 for recovery/private-link access and #142 for seminar updates; the `REGISTRATION_ACCESS_RECOVERY` template already exists.
- #142 must enqueue an applicable registration-update message after a successful seminar preference change; its content dependency is B2.
- #67 owns full deferred organization billing. Its bounded Phase 0 slice #143 supplies the dedicated confirmation and excludes those registrations from attendee balance language; reconciliation and invoicing remain later work.
- #54 owns separately payable merchandise. Its bounded slices #144–#148 supply merchandise state, and #148 owns merchandise receipts and after-sale messages.
- #53 owns optional Apple/Google Wallet support in Phase 3. Phase 0 templates omit wallet links when unavailable.
- #140 owns the final configured/customized/previewed/test-sent checklist, publication warnings, cross-event sample detection, default restoration, real-client smoke test, and release evidence.

## Bounded child issues to create

### B1 — Waitlist removal and decline confirmation

Add one event-scoped template and transactional trigger for a registration leaving the waitlist without promotion. Preserve the prior position and reason category in safe audit metadata, render through the HTML/text pipeline, and test removal, decline, retry, and duplicate transition behavior. Do not add session-level waitlists.

### B2 — Registration-updated confirmation

Add a generic registration-updated template and an idempotent transactional enqueue point for successful attendee-visible changes. The message must summarize the permitted change category without exposing protected answer values and must support #142's seminar-preference update. Contact changes, transfers, substitutions, and cancellations keep their existing specialized templates.

### B3 — Registration-reactivated confirmation

Add a reactivation template and enqueue it only after the existing lifecycle transaction succeeds. Render the restored status, current balance language, attendee summary, and private management link without implying that a prior payment or capacity reservation was recreated when it was not. Test retries and reactivation to each allowed target state.

### B4 — Registration refund notice

Add a refund notice driven by a newly successful manual or Square refund record. Include the refunded amount, provider/reference information when appropriate, remaining registration balance, and event contact. Delivery must be idempotent across webhook retries and must not claim that processing fees are refundable.

### B5 — Event-owned payment guidance

Add an event-owned, versioned source for approved payment instructions used by unpaid confirmations, previews, and applicable reminders. Preserve server-derived amounts and payment state, omit the section for complimentary/waitlisted/deferred-organization registrations, and prevent one event's instructions from appearing in another event. This issue changes message content configuration only; it does not add payment methods or alter Square behavior.

## Phase boundary

Phase 0 resolves B1–B5, #141–#148, and the final #140 gate. Wallet providers, full church invoice reconciliation, merchandise provider expansion, full session scheduling, scheduled campaigns, SMS, push, preferences, and unsubscribe management remain later work.
