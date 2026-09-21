# Women's Retreat roadmap — what is left to finish

Prepared September 15, 2026, against `main` at `3933c14`.

This is a **separate, narrower roadmap** than [issue #98](https://github.com/DurantTL/imsda-events/issues/98).
Issue #98 stays the canonical ordered backlog for the whole platform. This document
pulls out only the work that stands between today and a Women's Retreat that runs
end to end on IMSDA Events, plus the attendee-community expansion called out as the
priority gap. It is a **planning report — no code changes are proposed or made here.**

Sources: open GitHub issues (208 open at time of writing), `docs/BUILD-STATUS-AND-WR26-GAP-AUDIT.md`,
`docs/PRODUCTION-READINESS-PROGRESS.md`, and direct reading of `modules/community/`,
`modules/attendee-accounts/`, `modules/people/`, and the workspace/attendee routes.

---

## Execution update — September 21, 2026

This report was prepared before the WR26 handoff work below. The following delivery status
supersedes its earlier descriptions of those items:

- **C1 is partially delivered** in PR #336: the attendee hub now combines official
  announcements and community posts into one chronological timeline. Staff pinning and cursor
  pagination remain open in [#307](https://github.com/DurantTL/imsda-events/issues/307).
- **C2 is complete**: PR #338 adds author edit/delete, tombstones, audit evidence, and
  staff-visible revision history; PR #339 adds browser-local draft recovery, rate limits, and
  event-scoped search over posts already visible to the requester. [#337](https://github.com/DurantTL/imsda-events/issues/337) is closed.
- The operational-readiness tracking gap is resolved by
  [#306](https://github.com/DurantTL/imsda-events/issues/306). It records the completed sandbox
  workflow exercises and the remaining named human gates.
- A production preflight PostgreSQL backup was restored into a scratch database and the result
  was count-verified and copied off-host. This is evidence for #306; it does not replace the
  remaining off-host retention/runbook decision.

---

## 1. Where the retreat actually stands

**The registration-through-check-in path is built and green.** Public individual/household/group
registration, immutable form versions, serializable capacity and waitlist, Square Sandbox
checkout, fifteen versioned email templates with a transactional outbox, balance reminders,
transfer and substitution, signed QR passes, offline-recoverable check-in, program assignment
runs, and the printable grouped retreat packets are all complete and covered by tests.

**Three things are not finished**, and they are different in kind:

| | What | Why it matters |
| --- | --- | --- |
| **A** | Phase 0 tail — the final email and event-template readiness gate | The last open *feature* work the retreat itself consumes. Merchandise is **on hold** (§2.1) |
| **B** | [#306](https://github.com/DurantTL/imsda-events/issues/306) — WR26 operational readiness — config/migration review and sign-off | The remaining launch evidence is human operational work, not a missing feature |
| **C** | Attendee community depth | The shared official/community timeline and durable author controls are shipped; pinning, pagination, reactions, deeper moderation, and attendee discovery remain scoped separately |

Everything else on the retreat's critical path is done.

---

## 2. Track A — Phase 0 tail (finish first)

With merchandise on hold (§2.1), this track is now **one issue**.

| Order | Issue | State | Note |
| --- | --- | --- | --- |
| A1 | [#140](https://github.com/DurantTL/imsda-events/issues/140) — final email and event-template readiness gate | open, no `codex-ready` | **Unblocked and can start now.** It was previously sequenced behind merchandise receipts, which would have added message states the gate had to cover. With merchandise held, the gate covers the retreat's shipped template set only. |

Tracking epics [#66](https://github.com/DurantTL/imsda-events/issues/66) (email coverage)
and [#61](https://github.com/DurantTL/imsda-events/issues/61) (passwordless management)
close out as their children land. They are not separately claimable.

Note that #139, #274–#278, #59, #60, #141, #142, #143, #144, and #145 are already closed —
the Phase 0 email matrix, the gap-closing confirmation emails, seminar self-service, and the
merchandise catalog/ledger foundation all landed. #140 really is the whole feature remainder.

### 2.1 Merchandise — on hold

**Decision, September 15, 2026: separately payable merchandise is not part of the Women's
Retreat and is deferred.** It stays in the Phase 0 backlog on issue #98; it is simply not on
this retreat's path.

Held, not cancelled — no issue is closed and no code is reverted by this decision:

- [#146](https://github.com/DurantTL/imsda-events/issues/146) — inventory reservations and
  server-side quotes. Has an open draft PR,
  [#302](https://github.com/DurantTL/imsda-events/pull/302), which is now the only merchandise
  work in flight. **Whether to finish, park, or close that PR is a separate human decision**;
  this roadmap does not make it.
- [#147](https://github.com/DurantTL/imsda-events/issues/147) — public and self-service
  purchase with Square.
- [#148](https://github.com/DurantTL/imsda-events/issues/148) — receipts, totals, refunds,
  and staff adjustments.
- [#54](https://github.com/DurantTL/imsda-events/issues/54) — the tracking epic.

What this changes for the retreat: shirt sizes are already collected as ordinary registration
answers and reported through the existing shirt-size audience and packet reports, so **holding
merchandise does not remove any shipped retreat capability.** What it defers is buying a shirt
as a separate transaction after registration.

If merchandise is picked back up later, the order remains #146 → #147 → #148, and #140 should
be re-examined at that point for the receipt and refund message states it would add.

---

## 3. Track B — WR26 operational readiness (the actual launch gate)

`docs/BUILD-STATUS-AND-WR26-GAP-AUDIT.md` marks this **"Now."**
`docs/PRODUCTION-READINESS-PROGRESS.md` item 9 marks it **"in progress."** It is now tracked
in [#306](https://github.com/DurantTL/imsda-events/issues/306) as a `needs-human` gate.
Automation may prepare evidence; a human performs every production action.

- B1 — Deployment rehearsal on the sandbox environment, with the release SHA proven through
  `/api/health` (the endpoint already reports release SHA and Next.js build ID).
- B2 — Production configuration and migration review, including migration 45 and a written
  rollback/forward-fix path.
- B3 — Square Sandbox end-to-end exercise: paid, unpaid, partial, refund, and webhook replay.
  Square Production stays locked behind both `SQUARE_ENVIRONMENT=production` and
  `SQUARE_ENABLE_PRODUCTION=true`; unlocking is a named human decision, not part of the rehearsal.
- B4 — Real-client email smoke test for primary buttons and remote QR rendering (this is also a
  stated #140 release gate — run them together).
- B5 — Backup/restore verification and the one outstanding operator decision noted under
  readiness item 4.
- B6 — Staff runbook, health checks, support contacts, and event-day sign-off.
- B7 — Confirm no required retreat workflow depends on fictitious accounts or direct database editing.

The completed #306 evidence includes the deployed release identification, migration review,
Square sandbox exercises, core payment/registration workflow checks, and the verified preflight
backup restore. Its remaining checkboxes are authoritative for the launch decision.

Field-level encryption of medical/screening answers (readiness item 8) has been **explicitly
removed from the retreat release gate** and stays a platform backlog item. Existing access
controls, redaction, backups, and restricted handling still apply. That decision is recorded;
it should not be reopened inside this roadmap.

---

## 4. Track C — Attendee community: what exists and what is missing

This is the priority you named, so it gets the most detail.

### 4.1 What shipped

`modules/community/` (740 lines across `domain.ts`, `repository.ts`, `README.md`),
`components/attendee-community-board.tsx`, `components/community-moderation-workspace.tsx`,
and the `CommunityParticipation` / `CommunityPost` / `CommunityReport` /
`CommunityNotification` Prisma models give the retreat:

- event-level enable/pause, plus separate "allow new posts" and "allow replies" switches
- versioned conduct text that must be re-accepted when it changes
- access limited to a verified attendee account matching an active registration
- **plain-text posts and exactly one level of replies**
- in-app notification preference (`NONE` / `REPLIES` / `ALL`)
- attendee reporting with five reasons, staff moderation queue, hide/remove with audit trail
- retention cleanup measured from event end, run by the outbox sweep
- read-only staff preview that cannot post as an attendee
- one chronological attendee timeline combining official announcements and community posts
- author edit/delete controls with tombstones, audit entries, and staff-visible prior versions
- browser-local draft recovery, per-attendee post/reply rate limits, and event-scoped visible-post search

That foundation is sound. The security and moderation boundaries are the expensive part and
they are done correctly. The remaining community work is depth and lifecycle behavior, not a
missing basic timeline or author-control surface.

### 4.2 Confirmed gaps (verified in source, not assumed)

**Timeline follow-up remains.** PR #336 combines published official announcements and community
posts chronologically, preserving the existing attendee boundary. It did not add staff pinning
or replace the current post/reply caps with cursor pagination; those remain #307 acceptance items.

**There is no attendee lookup, at all.** `modules/people/` contains a README and no code —
permanent people, households, and affiliations are documented as owned there but not yet built.
There is no attendee directory, no profile, no display of who else is at the retreat, and no
search across community participants. `authorName` on a post is the only identity an attendee
ever sees about another attendee. Staff-side search is limited to the check-in lookup;
event-scoped operations search is still open work ([#180](https://github.com/DurantTL/imsda-events/issues/180)–[#182](https://github.com/DurantTL/imsda-events/issues/182), Phase 1).

**Also missing, each verified:**

- no profiles of any kind — no display name distinct from registration name, no avatar, no
  church/club, no interests, no "what sessions am I in"
- no reactions or staff pinning
- no media or photos (no object storage pipeline exists for community content)
- no mentions or hashtags
- no groups — not by church, seminar, lodging, or interest
- no cursor pagination; the board still hard-caps at 50 top-level posts and 100 replies
  (`modules/community/repository.ts`), so an active retreat silently loses history from view
- no block/mute or community-only suspension
- no read-only post-event window — retention deletes rather than archives
- event cloning behavior for community settings and conduct text is not defined

### 4.3 Where this sits on the roadmap today, and why that is wrong for the retreat

All of the above is currently absorbed into a single issue:
[#83 — Expand event community into timeline feeds, attendee profiles, groups, media, and moderation](https://github.com/DurantTL/imsda-events/issues/83).
It is labeled `phase-4`, `specification-needed`, `sensitive-data`, `needs-human`, `needs-decision`.

#83 is a good specification. But as one Phase 4 epic it is unbuildable and unclaimable, and
Phase 4 sits behind Phases 1, 2, and 3 — which means, as the backlog stands, **none of this
reaches the retreat.** Issue #98 itself says the full community platform is deferred because
"media, attendee discovery, minors, moderation, appeals, abuse escalation, and social retention
form a separate optional product." That reasoning is sound for *media and discovery*. It is not
a reason to defer a timeline or a participant list.

**Recommended action: split #83 into bounded slices, pull the low-risk ones forward against
the retreat, and leave the genuinely sensitive ones in Phase 4.** #83 stays open as the
tracking epic.

### 4.4 Proposed community slices, in build order

The dividing line is deliberate: **anything that exposes one attendee to another in a new way,
or accepts uploaded media, or touches minors, stays behind a human policy gate.** Everything
before that line is presentation and moderation hygiene over data attendees already share.

| Slice | Scope | Risk | Suggested labels |
| --- | --- | --- | --- |
| **C1 — Unified retreat timeline (read)** | **Partially delivered in PR #336:** chronological official announcements plus community posts with official badges. Staff pinning and cursor pagination remain in #307. | Low | `codex-ready` after its remaining contract is narrowed |
| **C2 — Post durability and author control** | **Completed by #338 and #339:** author edit/history/delete tombstones, local drafts, rate limits, and visible-post search. | Low | closed #337 |
| **C3 — Reactions and engagement** | Reactions on posts and replies, privacy-safe aggregate counts for staff (active participants, posts, reach). No ranked feed — chronological stays the default. | Low | `codex-ready` |
| **C4 — Moderation depth** | Moderation queue with escalation states, moderator notes, block/mute, community-only suspension that never touches event registration, spam controls, and repeat-abuse handling. Extends the existing report/moderate path. | Medium | `codex-ready` |
| **C5 — Attendee community profiles** | Opt-in, event-scoped profile: display name separate from registration name, optional avatar, church/club, short bio, interests. Attendee previews exactly what others see. Legal name, DOB, email, phone, address, balance, medical data, room, minor status, and emergency contacts are never exposed. | **Needs decision** | `needs-decision`, `sensitive-data` |
| **C6 — Attendee lookup and directory** | Search and browse opted-in profiles within one event. Nothing about a non-participating attendee is discoverable. Depends on C5 and on the disclosure rules C5 approves. | **Needs decision** | `needs-decision`, `sensitive-data` |
| **C7 — Groups** | Event-configured groups for churches, seminars, volunteer teams, prayer groups. **System-derived membership — especially lodging and any protected grouping — must not become a visible community automatically.** | **Needs decision** | `needs-decision`, `sensitive-data` |
| **C8 — Media** | Photos and approved media: object storage, type/size validation, metadata stripping, scanning, thumbnails, alt text, copyright reporting, authorized delivery rather than guessable URLs, retention and deletion. | **Needs human** | `needs-human`, `sensitive-data` |
| **C9 — Lifecycle and retention** | Independent community open/close dates, a read-only post-event window before deletion, archive/export, and explicit clone behavior (settings and conduct text copy; posts, profiles, memberships, and reports never do). Also defines what happens to content when someone cancels, transfers, or is removed. | Low–Medium | `codex-ready` after C5 settles profile retention |

**For the retreat specifically, the remaining C1 work and C4 are the community items that change
the experience most and carry the least policy risk.** C4 remains blocked on its documented
visibility and escalation decisions. C9 should follow close behind, because
retention currently deletes with no read-only period, and an event clone's community behavior
is undefined — both are easier to fix before a second retreat than after.

### 4.5 The decisions that must be made before C5–C8

These are yours (or the conference's) to make, not automation's. Each blocks its slice:

1. **Do attendees see each other at all?** C5/C6 exist only if the answer is yes. If yes: opt-in
   by default, or opt-out?
2. **Which fields may one attendee see about another?** The proposed floor is display name,
   avatar, church/club, bio, interests. Anything beyond that needs naming explicitly.
3. **Minors.** Are any Women's Retreat attendees under 18? If so, C5–C8 need age-appropriate
   defaults, restricted discovery, and guardian/organizational review before any of them ship.
4. **Photos.** Is there an approved storage and moderation path for attendee-uploaded images,
   including a takedown route? If not, C8 stays in Phase 4 and the timeline stays text-only —
   which is a perfectly good retreat.
5. **Safeguarding escalation.** Who receives a harassment, self-harm, or threat report during
   the retreat, and on what timeline? C4 can ship without this, but it should not ship
   *long* without it.

Items 3 and 5 are worth answering even if C5–C8 are deferred entirely.

---

## 5. Track D — retreat-specific code that should become reusable

Not a launch blocker, but it compounds. Two open issues cover it:

- [#155](https://github.com/DurantTL/imsda-events/issues/155) — generalize the retreat-named
  attendee hub, report packets, and shared module boundaries (`codex-ready`, Phase 1)
- [#104](https://github.com/DurantTL/imsda-events/issues/104) — generalize retreat-specific
  naming and services in shared modules (Phase 1, tracking)
- [#153](https://github.com/DurantTL/imsda-events/issues/153) — migrate hard-coded Women's
  Retreat, Camp Meeting, and club forms to seeded template data (`codex-ready`, Phase 1)

The audit's own "do not copy from WR26" list names hard-coded Women's Retreat field names in
shared services as an anti-pattern. `retreat-hub-repository.ts`, the retreat packet report, and
the `wr26-bundle` import path are the concrete instances. **Best time to do this is right after
the retreat runs**, while the real requirements are fresh and before Camp Meeting inherits the
same shapes. Do not let it delay Track A or B.

---

## 6. Suggested sequence

Holding merchandise shortens the front of this list considerably — the retreat's remaining
feature work is now one issue, and the readiness gate is the real long pole.

1. **B** complete the remaining #306 human evidence and sign-off
2. **A1** final email gate (#140), recording the existing real-client smoke-test evidence alongside it
3. **C1 remaining scope and C4** only after their open contracts are resolved
4. **C9** community lifecycle and clone behavior
5. **Answer the §4.5 decisions**; then C5/C6 if approved, C3 anywhere it fits
6. **D** generalization (#155, #153, #104) after the retreat runs
7. C7/C8 remain Phase 4 unless a decision moves them
8. Merchandise (#146–#148) resumes only if the hold in §2.1 is lifted

---

## 7. Tracking actions

- [x] File the WR26 operational-readiness issue — [#306](https://github.com/DurantTL/imsda-events/issues/306).
- [x] Split #83 into bounded community children. C2 is closed as [#337](https://github.com/DurantTL/imsda-events/issues/337); C1 remains open as [#307](https://github.com/DurantTL/imsda-events/issues/307).
- [ ] Record the §4.5 decisions on the relevant issues with the `needs-decision` label, per the
      repository's stop-and-label rule.
- [ ] Add these slices to issue #98 as a named Women's Retreat track, so #98 stays canonical and
      this document stays a focused view rather than a competing backlog.
- [ ] Record the merchandise hold (§2.1) on #54, #146, #147, and #148 so the deferral is visible
      to the issue tooling, and decide what happens to draft PR #302. Removing `codex-ready` from
      #147 and #148 would stop an automated build from claiming held work.

This document is a status and planning view. Issue #98 remains the ordered source of truth, and
GitHub is authoritative for scope once an issue is approved.
