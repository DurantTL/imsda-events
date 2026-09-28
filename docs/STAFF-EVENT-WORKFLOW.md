# Staff event workflow

One page for anyone running an event through this system, start to close-out.
It's linked from the "Draft created" guide shown right after an event is
created (#473).

## The design rule

Every page in the event workspace should answer three questions before a
staff member acts on it:

1. **Which event am I changing?** The event switcher and page header always
   name it; never act on an ambiguous or unselected event.
2. **What will this action affect?** Settings, forms, and communications are
   scoped to one event. A change here should not surprise anyone working on a
   different event.
3. **What should I do next?** A page that finishes a step should point at the
   next one — the readiness checklist, an empty state, or a banner like the
   one this guide is linked from — instead of leaving staff to guess.

Keep this rule in mind when adding or reviewing any staff-facing page.

## The seven steps

### 1. Create the draft

From **Admin**, choose **Create event**. It starts as a private draft —
nothing is public and no attendee can register yet. Creating it hands you
straight to its settings with a one-time "Draft created" banner naming the
next three steps.

### 2. Complete event settings

Fill in the event's public details on its **Event settings** page: name, web
address, dates, timezone, location, capacity, support contact, and (if the
event uses one) the hotel block. These feed both the public registration
pages and the publish-readiness checklist on the same page.

An **IMSDA.org information page is not required** to publish an event
(decided 2026-09-28, #467). Add one when the event has one; don't block
publishing on it.

### 3. Build and test the form

Open the **registration builder** for the event (linked from event settings
and from the draft-created banner) and build its registration form: attendee
types, questions, pricing, and availability rules.

Before a form version can go live, run at least one test submission against
it. Current, confirmed behavior (2026-09-28): **only the first published
version of a form needs a test submission.** Once a form has ever been
published, later versions (a corrected label, an updated price) can publish
without a fresh test run — testing every routine edit forever is not
required, only the one that first makes the form real for attendees.

### 4. Prepare public content and sales

With the form in shape, prepare whatever the event needs before it opens:
promo codes, communications templates, merchandise, and any content pages
outside this system (an IMSDA.org page, if the event has one — see step 2).

### 5. Review and publish

Return to **Event settings** and check the publish-readiness panel. It lists
every requirement — event basics, location, support contact, and a published,
tested registration form — and won't let the event go public until they're
all met. Publishing turns on the event's public registration links; the
registration window still controls when attendees can actually submit.

### 6. Operate the event

While registration is open and through the event itself: check attendees in,
work the waitlist, handle roster changes and refunds through the proper
channel, and keep communications going out. Day-of tools live under the
event's operational pages (check-in, roster, communications).

### 7. Close cleanly

After the event ends: reconcile finance, close out registration, and archive
what the event no longer needs open. See
`docs/decisions/0007-event-closeout-gate-policy.md` for the closeout gate
policy (proposed, not yet accepted at the time of writing) covering what
"closed" should require before it's said out loud.

## Source

UI review report (2026-09-26), "Event creation needs a guided handoff" and "A
seven-step workflow makes the system trainable." Decisions on the IMSDA.org
page (#467) and the test-submission rule confirmed 2026-09-28 (#473).
