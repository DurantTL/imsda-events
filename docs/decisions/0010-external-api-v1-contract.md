# ADR 0010: External API v1 audience, resource, and webhook contract

Status: **Proposed — draft for review.** Not yet Accepted. Deliverable for
#237. Until Accepted, #238–#241 stay unclaimable (per roadmap #98: "remain
unclaimable until #237 approves the exact allowlisted contract"), and
production partner activation stays blocked behind #269 regardless.

Date: 2026-08-09

## Context

Nothing exists yet for this: `app/api/webhooks/` today holds only inbound
provider webhooks (Square, Resend) — nothing outbound. `app/api/public/`
serves the public registration/event pages, not a versioned external contract.
#124 (scoped API credential model) is `codex-ready` and can be built
independent of this ADR — it "exposes no resource data," per its own
description, so credential issuance/rotation/revocation plumbing doesn't need
this contract decided first. What genuinely can't proceed without this ADR is
anything that exposes a resource field or fires a webhook payload, because
that's exactly what #237 exists to bound.

#237's own body already proposes strong defaults ("Recommended first-release
defaults to approve or replace") rather than leaving every question open. This
ADR treats those as the starting position and focuses on what still needs a
named decision on top of them.

## Decision

### 1. Audience and access model

**Recommended (adopting #237's own default):** private/approved-partner access,
not an open public developer program. `/api/v1`, read-only, no external write
operations in the first release. Event- and capability-scoped credentials only
— no implicit global or organization-wide access, consistent with roadmap
principle 13 ("must never silently grant access to another domain").

**Decision needed:** name the actual first partner(s), if any are already
known, since "approved partner" without a named partner is not yet an
operable policy — #269 (the partner-onboarding gate) will need this regardless.

### 2. Initial resources and field allowlists

**Recommended starting set (from #237):** public event details/schedule, plus
explicitly scoped registration summary, check-in status, and report/export job
status. Every field in every resource needs an explicit allowlist entry — no
DTO may serialize an internal model directly, matching roadmap principle 15.

**Decision needed, field by field:** the actual allowlist. This ADR proposes
the *shape* (deny by default, allowlist by exception) but the specific field
list is a data-minimization decision that should be made against the real
`Registration`/`Event` models by whoever owns privacy sign-off, not enumerated
speculatively here. **Explicitly excluded regardless of who reviews the list**,
per #237's own scope: protected medical/accommodation detail, screening source
detail, incident/custody data, raw form answers, payment instruments,
passwordless tokens, private staff notes, and provider credentials/payloads —
this ADR treats that exclusion list as non-negotiable, not a starting point for
negotiation.

### 3. Initial webhook events and payload minimization

**Recommended (from #237):** registration created/updated, payment posted,
refund completed, waitlist promoted, check-in recorded. Payloads carry event
scope, stable identifiers, timestamps, version, and operational status only —
richer data requires a separate authorized API call, not a fatter webhook
payload. This keeps a compromised webhook endpoint from becoming a bulk-export
channel.

### 4. Versioning, deprecation, and rate limits

**Decision needed:** minimum deprecation notice period, and whether `v1` gets
a hard sunset date or an indefinite-support commitment. **Decision needed:**
rate-limit policy per credential/scope. Neither is proposed here — these are
support-capacity commitments, not technical defaults, and #237 correctly lists
them as items to approve rather than infer.

### 5. Credential and subscription authority

**Decision needed:** who may create/revoke API keys and webhook subscriptions,
maximum credential lifetime, and whether any organization-scoped (as opposed
to event-scoped) credential will ever exist. **Recommended:** no
organization-scoped credentials in the first release — every credential stays
event-scoped until there's a concrete reason to widen one, consistent with the
"scoped, not global" default in §1.

### 6. Backfill and historical access

**Decision needed:** whether a newly subscribed webhook consumer receives
historical backfill or only forward events from subscription time. #237 lists
this explicitly as undecided; this ADR doesn't resolve it because the answer
depends on what the first real consumer actually needs (§1).

## Consequences

- #124 stays buildable now, independent of this ADR's Acceptance.
- #238–#240 stay correctly blocked until this ADR names the actual field/event
  allowlist — building against a guessed allowlist would mean re-deriving DTOs
  once the real one is approved, which is the more expensive order.
- #241 (documentation/sample consumer) stays blocked transitively, since it
  documents whatever #238–#240 end up exposing.

## Alternatives considered

**Open public developer registration instead of approved-partner access.**
Rejected for v1, matching #237's own recommendation — a public program adds
abuse-surface and support-commitment scope that isn't needed for the platform's
current known consumers.

**Ship webhook payloads with full resource content to avoid a second API
call.** Rejected — matches #237's explicit design goal of minimized payloads;
a fat webhook payload is a wider disclosure surface than a scoped pull request,
and every subscriber gets it whether they need the detail or not.

**Decide the field allowlist inside this ADR rather than deferring to a
privacy review of the real models.** Rejected — an agent enumerating "safe"
fields from the schema without the actual privacy/product review #237 asks for
would just move the real decision into a document that looks decided when it
isn't.

## Approvals needed

- [ ] Product owner (audience, first consumer, backfill policy)
- [ ] Privacy/security owner (field allowlist, protected-category exclusions)
- [ ] Operations/support owner (versioning, deprecation notice, rate limits)
- [ ] Named incident-response and support-ownership contacts

## Related

- Parent: #103 (external API/webhooks epic)
- Existing technical foundation: #124
- Blocks: #238, #239, #240, #241
- Downstream production gate: #269
- Roadmap: #98 (Phase 3D)
