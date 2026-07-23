# Promo codes

Promo codes are event-scoped registration discounts. Staff with
`MANAGE_FINANCE` use **More → Promo codes** to create, edit, or deactivate
them. Published forms opt in through the one-click **Promo code** builder
module; staff never need to know its canonical `promo_code` field key.

## Rules

- Codes normalize with Unicode NFKC, trim surrounding whitespace, and compare
  case-insensitively as 3–32 uppercase letters, numbers, hyphens, or
  underscores. One normalized code may exist only once per event.
- A code is either a positive fixed-cent discount or 1–10,000 basis points
  (0.01%–100%). Percentage calculations floor fractional cents.
- Optional start/end dates are inclusive calendar dates in the event timezone.
- Optional minimum subtotal, maximum total uses, and per-registration maximum
  percentage discount are enforced on the server.
- The eligible subtotal is the complete priced form subtotal before card fees.
  A discount is capped at that subtotal, so totals never become negative.
- If card processing is passed to the registrant, its gross-up is recalculated
  from the discounted subtotal.

## Quote, claim, and history

The public **Apply / Remove** control calls a same-origin, durable
rate-limited quote endpoint. That quote is display-only. Submission reloads
the published form, recalculates the subtotal, revalidates the code, and claims
one use inside the registration’s serializable transaction.

`PromoCode.redeemedCount` is incremented with an optimistic compare-and-swap.
The unique registration redemption and serializable retry protect the final
available use under concurrency. A replay with the same registration
idempotency key returns its original immutable result without claiming another
use.

`PromoCodeRedemption` stores the exact code, rule bounds, eligible subtotal,
discount amount, and event-local pricing date promised to that registration.
Waitlist requests intentionally consume and preserve a use; promotion cannot
silently lose the promised discount. Cancellation does not restore a use.
Used codes are never deleted or renamed; deactivate them and create a new code.

The local seed and `npm run db:refresh-demo` upsert the fictitious `LOCAL10`
code for Women’s Retreat (`10%` off, `$50` maximum, `$100` minimum). A refresh
extends the local-only ceiling so at least 25 test uses remain without deleting
any immutable redemption history. It must not be treated as a live event offer.
