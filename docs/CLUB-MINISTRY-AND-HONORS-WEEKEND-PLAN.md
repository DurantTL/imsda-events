# Club Ministry, Honors Weekend, and the 2026–27 event calendar

Prepared September 22, 2026, against `main` at `274551b` (after PR #351). Updated the
same day with how Honors Weekend 2026 actually ran and why its form glitched.

This is a **review and plan only**. It records what was found across this
repository, GitHub issue #98, the WR26 go-live review, and the earlier club system
**CMMS-1** (`DurantTL/CMMS-1`), and it proposes what to build, in what order, to meet
the real event calendar. Issue [#98](https://github.com/DurantTL/imsda-events/issues/98)
stays the canonical roadmap. Nothing here changes #98 until a human approves it.

---

## 1. Summary

- **The platform is healthy.** CI is green on `main`. Every PR through #351 has
  merged, and 1,500 tests pass across 215 files. The registration-through-check-in
  path WR26 needed is built.
- **The calendar has moved, and the roadmap has not.** The next deadlines are club
  events, not the Phase 1 platform order in #98:
  - Honors Weekend: registration opens in December 2026, so it must work by
    November. The events themselves follow in late winter (the 2026 events ran
    February 28 – March 8 at four sites).
  - Spring Camporee: registration opens in January or February 2027; the event runs
    April 29 – May 2, 2027.
  - Camp Meeting: registration opens at the end of March 2027; the event is in June 2027.
- **The honors system to base this on already exists: CMMS-1.** It has:
  - yearly club rosters;
  - director registration from the roster;
  - an honor/class catalog with eligibility rules;
  - timed class periods with seat limits, ranked preferences and waitlists;
  - teacher rosters, attendance, and honor sign-off.

  Its own build review said: "*An 'Honors Weekend' is simply an Event with
  honor-type class offerings.*" That design was never written into this repo's
  issues beyond the broad [#68](https://github.com/DurantTL/imsda-events/issues/68)
  and [#197](https://github.com/DurantTL/imsda-events/issues/197). This report
  captures it.
- **The system actually used for Honors Weekend 2026** was a Fluent Forms
  registration feeding a Google Sheet. It ran four separate events with their own
  class lists, 50 club registrations covering 475 people, first-come class
  selection with live seat counts, and printed check-in sheets. Section 3.4
  records how it worked, using totals only. That working practice, not CMMS-1, is
  what Honors Weekend 2027 has to match or beat.
- **The owner decision on #68 (July 31, 2026) still governs.** CMMS-1 is a
  workflow reference only. Its code is never copied; club features are rebuilt
  natively here, and data migrates once through a reviewed import.
- **The existing issue chain cannot reach Honors Weekend by November.** The club
  director workspace (#193) sits behind about a dozen large issues. Section 6
  proposes six narrow slices that reuse what this platform already has, so clubs
  register once and pick who is going for each event.
- **Decisions** are needed from Caleb and Club Ministry (Section 9). The 2026
  spreadsheet already answers several of them; D3, D4, and D11 change the build and
  are needed this week.

---

## 2. The calendar that drives the work

| Event | Registration opens | Event dates | Billing | Status here |
| --- | --- | --- | --- | --- |
| Women's Retreat 2026 (WR26) | Done (imported from another system) | Oct 9–11, 2026 | Attendee pay | Live; operational items remain (Section 4) |
| **Honors Weekend 2027** | **December 2026** (2026 opened January 1) | **Late winter 2027, at several sites** (2026: Feb 28 – Mar 8, four events) | To confirm (no payment data in the 2026 sheet) | **Nothing built for honors yet** |
| Spring Camporee 2027 | January or February 2027 | Apr 29 – May 2, 2027, Camp Heritage, MO | Church-billed (planned) | Draft event exists in production |
| Camp Meeting 2027 | End of March 2027 | June 2027 | Attendee pay (planned) | Hard-coded form; lodging/meals not built |

Confirmed answers from Caleb (September 22, 2026):

- Clubs should **register once** and then just select who is going for Honors
  Weekend and Camporee.
- **Adult background-check (Sterling) readiness** is needed for the April event.
- **Honor/class sign-ups with capacity limits** are needed.
- **Camp Meeting** needs rooms/tents/RV sites **and** meal plans in the system.
- WR26 door payments use Square's **in-person rate (2.6% + 15¢)**. Shipped in #351.
- Honors Weekend **registration opens in December 2026**. The honors process to
  build from is the one actually used in 2026 (Section 3.4).

---

## 3. What was found

### 3.1 Repository and build

- A Next.js 16 modular monolith with 24 domain modules, 67 migrations, and strict
  server-side authorization. The seed data is synthetic only.
- CI on `main` is green for every recent merge. `npm run verify` passes: lint,
  typecheck, 215 test files and 1,500 tests, and the production build.
- Security posture is strong:
  - MFA is required for administrators.
  - Sessions expire after 60 minutes idle and 8 hours at most.
  - QR passes carry no personal information.
  - Square live mode needs two separate switches.
- PR #351 (merged) added for WR26:
  - the balance and the Square in-person card amount at check-in;
  - a separate rate limit for attendee QR images;
  - an honest failure state on the Square matching page;
  - a live command center with a heartbeat that shows whether the email sweep is running.

### 3.2 Roadmap #98

- There are **214 open issues**. **More than 100 are labeled `codex-ready`**, almost
  all in Phases 2 and 3: meals, transport, wallet passes, passkeys, site builder,
  mobile app.
- **Phase 1's own foundations are mostly still open**: templates, event lifecycle,
  the append-only ledger, search.
- The #98 ordering is careful about human gates, but it is not ordered by the
  2026–27 event calendar. Automation can currently claim wallet or mobile work
  while Honors Weekend has no issue at all.

### 3.3 The earlier honors system: CMMS-1

CMMS-1 (last commit July 8, 2026) is a Next.js + Prisma app for four personas:
conference admins, club directors, teachers, and linked students/parents. What it
models:

| Area | CMMS-1 model / behavior |
| --- | --- |
| Clubs | `Club` with type (Pathfinder, Adventurer, Eager Beaver), code, district; directors linked by `ClubMembership` |
| Yearly roster | `ClubRosterYear` per club per year. **Rollover** copies active members into the new year and keeps the old one. `RosterMember` holds role (Pathfinder, Adventurer, TLT, Staff, Child, Director, Counselor), birth date/age, status, rollover status, Master Guide, swim test, background-check date/cleared, consents, emergency contact, **and medical/insurance fields** |
| Event registration | One `EventRegistration` per club per event. The director selects roster members as `RegistrationAttendee`s and answers **club-level and per-attendee** questions. Statuses: draft → submitted → reviewed / needs changes → approved / rejected. Walk-ins supported |
| Honor catalog | `ClassCatalog` (type: Honor, Specialty, Workshop, Required) with `ClassRequirement` eligibility: **min age, max age, member role, completed prerequisite honor, Master Guide** |
| Class periods | `EventClassTimeslot` (label, start/end, order) |
| Offerings | `EventClassOffering`: an honor in a period, with **teacher, capacity, location** |
| Preferences | `EventClassPreference`: ranked choices per attendee **per period** |
| Placement | The system **suggests** each attendee's highest-ranked eligible choice with an open seat. The director assigns individually or in bulk. **Live seat checks** run in serializable transactions, and an attendee can hold only one class per period |
| Waitlist | `EventClassWaitlist` per offering with position, and promotion when seats open |
| Teaching | Teacher sees only their offerings, marks **class attendance**, and **signs off requirements**. A completed honor is recorded (`MemberRequirement`) and feeds later prerequisites |
| Also | Camporee scoring, campsite assignment, medical/dietary manifests, monthly and year-end club reports, TLT applications and recommendations, nominations, compliance (background check) sync |

CMMS-1's own build review (`docs/build-plan-review.md` §2.3) concluded Honors Weekend
needs **no separate system**. It is an event with honor offerings plus an honor
selection wizard, bulk enrollment, and certificates.

**Governing decision (#68, July 31, 2026):**
- CMMS-1 code is **never copied**; it is a workflow and domain reference.
- Club capabilities are rebuilt natively on this platform's database, audit,
  permission, communications, and import foundations.
- Data migrates **once**, through preview → match → review → apply → reconcile.
- There is no lasting synchronization between the two systems.
- CMMS-1 retires once every needed workflow has a home here.

### 3.4 How Honors Weekend 2026 actually ran

Source: the "Honors Weekend 2026" Google Sheet owned by the communication
department. It holds real attendee data, so **only structure and totals are
recorded here**. No names, contact details, or individual records were copied
into this repository.

**Tooling:**
- A WordPress Fluent Forms registration with a custom roster builder.
- A Google Apps Script that wrote each submission into sheets: Registrations,
  Roster, ClassEnrollments, and an email log. The script also sent confirmation,
  resend, and forward emails.
- Registration codes looked like `REG-…`.
- Registration was open **January 1 – March 2, 2026**.

**Events and sites.** Honors Weekend was four separate events, each with its own
class list and its own roster:

| Site | Dates (2026) | People | Youth | Staff | Adults |
| --- | --- | --- | --- | --- | --- |
| Camp Heritage, weekend 1 | Feb 28 – Mar 1 | 75 | 41 | 20 | 13 |
| Camp Heritage, weekend 2 | Mar 7–8 | 180 | 120 | 45 | 9 |
| Des Moines, Iowa | Mar 7–8 | 155 | 114 | 33 | 6 |
| Kansas City Multicultural (**Spanish-language form**) | Mar 7 | 51 | 31 | 16 | 3 |

A further 15 people were never assigned a site.

**Registrations:**
- There were **50 registrations from 29 clubs**, covering **475 people**. One
  director (or registrant) entered the whole club's list; sizes ranged from 1 to
  40. A club sometimes registered more than once, for another site or for later
  additions.
- Each person had a name, age, gender, dietary restriction (45 people listed
  one), site, **attendee type**, and chosen classes.
- Attendee types: youth 313, staff 121, adult 31, and "underage" 10, meaning
  younger than the attendance age.
- **Nobody was kept between events.** Every person was retyped on every
  registration. This is the "register once" gap Caleb described.

**Classes:**
- **65 class offerings**, each tied to one site, with an ID, name, capacity
  (mostly 10–30, some 6–8), current enrolled count, optional **minimum age**
  (12–14 on 14 classes; no maximum ages used), and teacher.
- At Camp Heritage each class had a **session type**:
  - **Sabbath**;
  - **Sunday**;
  - **Full**, meaning both days, which fills both slots.

  Des Moines and Kansas City left session type blank.
- **Each person chose up to two classes during registration.** Most youth took
  two: 222 took two, 89 took one.
- Staff and adults could also take classes.
- There were **750 class enrollments** in all, and **8 classes filled**.
- **Placement was first-come with live seat counts.** The current enrolled count
  was maintained against capacity as registrations arrived. There was no ranking
  and no after-the-deadline placement.
- **Only youth counted toward a class's capacity** (`countsTowardLimit` was true
  for youth and false for staff, adults, and underage). Adults in a class did
  not take seats.

**On site:**
- Sheets per site with a **Checked In** column.
- **Lodging (cabin) assignments** at Camp Heritage.
- Class rosters per class, and site rosters with youth, staff, and adult totals.

**Background checks:**
- A "Sterling Check" sheet listed each staff member and adult with a check
  result: **Good**, **Not Found**, **Not Compliant**, or **Error**.
- About 100 people were checked by hand; 93 were recorded as Good.
- Adult background-check readiness is therefore already part of Honors Weekend
  practice, not only Camporee.

**What this changes in the plan:**
1. **The event is one of several sites and sessions, not one weekend.** Staff need
   to set up several related events (or one event with sites) quickly.
2. **Class selection happens at registration, first-come, with live seat counts.**
   That is how directors are used to working. It also means class capacity must
   be checked inside the same serializable transaction that saves the
   registration, as registration capacity already is.
3. **Class periods are session types** (Sabbath, Sunday, Full), with up to two
   classes per person and "Full" filling both.
4. **Capacity counts youth only.** Minimum age is the only eligibility rule
   actually used.
5. **A Spanish-language form** is needed for at least one site.
6. **Staff and adult background-check status** is needed for Honors Weekend as
   well as Camporee.
7. Cabin assignment and check-in were done on paper. Check-in can move to the
   existing QR check-in; cabins can stay on paper for 2027.

#### The 2026 registration form, and why it kept glitching

Source: the Fluent Forms export of the live form, "Pathfinders Honors Weekend
Registration" (form 71, 4,542 views). The export holds the form definition only,
with no submissions. The live endpoint URL in its script is deliberately not
reproduced here.

**How the form worked:**
1. The director acknowledges the event information and picks a **site**: Iowa,
   Camp Heritage weekend 1, Camp Heritage weekend 2, or Kansas City Spanish.
2. The director picks the **club** from a hard-coded list of 35 (or "Other" with
   free text) and enters contact details.
3. A section for the chosen site asks **how many attendees** and which honors
   the club wants in each session. Session names differed by site:
   - Iowa: "Sabbath afternoon" and "Saturday evening/Sunday";
   - Camp Heritage: "Sabbath" and "Sunday";
   - Kansas City: "Sabbath 2:30" and "Sabbath 5:30".
4. About **2,000 lines of custom JavaScript** (plus 23 KB of CSS) then builds the
   roster in the browser. For each person the director types a name, age, gender,
   type (Pathfinder, staff, other adult, under-age) and dietary needs, then assigns
   classes.
5. The script enforces the rules **in the browser only**:
   - age eligibility;
   - the "2-session honor" rule (a Full class can't be combined with anything);
   - youth-only seat counting;
   - capacity, read from a Google Apps Script availability feed that is polled
     on a timer;
   - one hard-coded special rule: at most 3 Pathfinders per club in Iowa
     Backpacking.
6. The whole roster is written as **JSON into one hidden field** (`roster_storage`).
   It's submitted through Fluent Forms, copied to the Google Sheet by a feed, and
   confirmation emails come from the sheet's script.

**Why it glitched, and what the new build must do instead:**

| 2026 weakness | Effect | Requirement for 2027 |
| --- | --- | --- |
| Capacity and eligibility checked only in the browser, against a polled copy of the sheet | Two clubs could take the last seat. If the feed failed, the form said capacity "cannot be verified" and still allowed submission | Check seats and age **on the server**, inside the transaction that saves the registration (H5) |
| Submission blocked by overriding jQuery's global `$.ajax` | Any Fluent Forms or theme update could silently break validation | No client-side interception; the server is the only gate |
| The roster lived in one hidden JSON field | A script error, a reload, or a closed tab lost everything. Emails later failed on bad roster data (the email log shows "roster.filter is not a function") | Store attendees as real records. Save as you go (draft), with a clear review step before submitting |
| No save or resume (form save state off) | Big clubs (up to 40 people) had to finish in one sitting | Drafts and resume (H3; a narrow #161) |
| **No persistent people** | Every event, every person retyped (Caleb: "everyone had to re-input roster info manually every event") | **Club roster reused across events (H2/H3)** |
| Club picked from a hard-coded list or typed as "Other" | Inconsistent club names in the data (for example "Teacher", "Coordinators", a bare number) | Club comes from the organization directory, tied to the director's grant (H1) |
| Class lists hard-coded in both the form and the sheet, matched by text IDs | Two copies to keep in sync for every change | One catalog and offerings list in the database (H4) |
| Special rules hard-coded in the script | Each new rule means editing code | Per-offering settings, starting with a **per-club limit** (H4) |
| No self-service edits after submitting | Changes went through staff by email | Directors can edit their registration until the site deadline (H3) |

### 3.5 What IMSDA Events already has that club events can reuse

| Capability | Where | Reuse for |
| --- | --- | --- |
| Church and club directory, club → sponsoring church, external identifiers (including CMMS and Sterling IDs) | `modules/organizations` | The club each director manages |
| Durable `Person` and household records; account-to-person links | `modules/people`, `modules/attendee-accounts` | Roster members as real people, not copies |
| Group registration with an attendee roster (Spring Camporee 2026 template: up to 50 members, duties, activities, meal sponsorship, late pricing) | `modules/forms/definition.ts` | "Who's going" registrations |
| **Church-billed events**: no card checkout, no attendee balance, no reminders (#143) | `modules/events`, `modules/payments` | Honors Weekend and Camporee billing |
| **Ranked choices with room limits and fair batch assignment**: reviewed preview, immutable runs, printable rosters and CSV | `modules/program-assignments` | Honor placement (Section 6, H5) |
| Confirmation email, QR passes, check-in, badges, reports, announcements | existing modules | Unchanged for club events |
| Attendee sign-in (password or Google) | `modules/attendee-accounts` | Director sign-in |

### 3.6 Gap map: CMMS-1 capability → where it lands here

| CMMS-1 / 2026 capability | Exists here? | Honors Weekend 2027 (registration opens Dec) | Camporee (Apr) | Camp Meeting (Jun) | Home |
| --- | --- | --- | --- | --- | --- |
| Director linked to a club | Directory only; no director role | **Needed** | Needed | — | H1 (narrow #193) |
| Yearly roster + rollover | No | **Needed** | Needed | — | H2 (narrow #183/#184) |
| Register from roster, select who's going | Group form exists; no roster source | **Needed** | Needed | — | H3 (narrow #186/#188/#194) |
| Club-level vs per-attendee questions | Yes (form sections + attendee roster) | Reuse | Reuse | — | existing |
| Several sites/sessions for one Honors Weekend | Separate events only | **Needed** (4 in 2026) | — | — | H4 |
| Honor catalog + minimum age | No | **Needed** | Maybe | — | H4 (narrow #197) |
| Session types (Sabbath, Sunday, Full), offerings, capacity, teacher | Room limits only (program assignments) | **Needed** | Maybe | — | H4 |
| Class selection at registration, first-come, live seats, youth-only capacity | Registration capacity is serializable; no per-class seats | **Needed** | Maybe | — | H5 |
| Spanish-language registration | Not supported | **Needed** (1 site) | Maybe | Maybe | H3 (decision D11) |
| Teacher and site rosters (print) | Printable run rosters exist | **Needed** | — | — | H6 |
| Class attendance + honor sign-off | No | Paper, as in 2026 | Nice | — | #209/#197 later |
| Background-check readiness | No (policy gate #218) | **Done by hand in 2026**; needed | **Needed** | Maybe | #115, #113, #218 |
| Post-event church invoice | Billing mode only | Manual report acceptable | **Needed by May** | — | #165–#167 |
| Campsite assignment | No | — | Likely | Needed (sites) | #89 / #198–#200 |
| Lodging (rooms, tents, RV) | No | — | — | **Needed** | #198–#200 |
| Meal plans | No | — | Meal sponsorship field only | **Needed** | #210 (+#211, #212) |
| Medical/dietary manifests | Per-event registration answers only | Per-event questions | Per-event questions | Per-event questions | Protected records wait on gate #189 |
| Monthly/year-end reports, TLT, nominations, scoring | No | — | — | — | Later bounded modules (#68) |

### 3.7 Why the current issue chain misses November

The planned path to "a director registers the club and picks classes" runs through
the following, in order:

1. identity #127 and #128;
2. roster #183 → #184 → #185;
3. participation #186 → #187 → #188;
4. the director workspace #193 and #194;
5. sessions #207 → #208 → #209;
6. CMMS #196 and honors #197.

That is about **fourteen issues**, each written to the full long-term scope (for
example: versioned curriculum catalogs, CMMS migration parity, full disclosure
matrices). They are correct long-term, but none can be finished and rehearsed with
real directors by November. The fix is to carve narrow slices out of them, not to
skip their safety rules.

---

## 4. WR26: where it stands (for completeness)

Registration was done in another system and imported. The only load left is:
- last-minute staff registrations;
- one email blast with everyone's private links;
- staff check-in and badge printing;
- door card payments in the Square app.

Email is retried by a script on the server that runs every five minutes.

Shipped in #351:
- the card amount at check-in;
- a separate QR image rate limit;
- the Square matching failure state;
- the live command center and email-sweep heartbeat;
- the emergency-deploy volume fix.

Still human-only before October 9 (from `docs/WR26-GO-LIVE-REVIEW.md`):

- [ ] Set `RATE_LIMIT_TRUSTED_PROXY_HOPS` to the real proxy count on the server
- [ ] After deploy, confirm **System management → Email sweep** says **Running**. "Not
      seen" means the five-minute script is not posting to `/api/internal/outbox/sweep`
- [ ] Point an uptime monitor at `/api/health`, alerting on anything but `"status":"ok"`
- [ ] Before the blast:
  - run `npm run payments:match-audit` and `npm run payments:reconcile`;
  - send the blast to 2–3 test registrations first;
  - confirm the Resend plan's daily limit covers everyone.
- [ ] Off-host backup destination
- [ ] Migration review and a written rollback/forward-fix path
- [ ] One-page staff runbook: on-call name, refund authority, and "type the
      confirmation code in the Square note"
- [ ] Print pass sheets and badges ahead of time

---

## 5. Principles for the club build

These carry over from #68, ADR 0002, and `AGENTS.md`, and are not negotiable for speed:

1. **Rebuild natively; never copy CMMS-1 code.** Use CMMS-1's behavior and data
   shape as the reference.
2. **The roster pre-fills the existing registration pipeline.** Club registration
   must reuse forms, submissions, church billing, email, QR, check-in, and reports
   rather than a second registration system.
3. **Keep these records separate:**
   - roster membership;
   - event registration;
   - honor preference;
   - honor assignment;
   - class attendance;
   - event check-in.

   None implies another.
4. **Membership grants no access by itself.** Director authority is an explicit,
   audited, revocable grant, never inferred from an email address or a form answer.
5. **No medical or insurance data on the roster** until the protected-records gate
   (#189) is approved. Event-specific medical questions stay on each event's
   registration, as they do today.
6. **No automatic identity merges.** The CMMS import matches by stable source IDs
   and staff review, never by name or email alone.
7. **One bounded issue per PR, synthetic data only, human merge and deploy.**

---

## 6. Proposed plan

### 6.1 Honors Weekend slices (target: working by early November)

Each slice is one issue and one PR.

**H1: Club director access**
- Staff grant an attendee account director authority over one club (or several)
  with start/end dates, a reason, and an audit entry. Revoking it removes access
  immediately.
- Directors see only their own club(s): no other clubs, events, counts, or search
  results.
- Carves the "explicit organization-role grants" part out of #193. Two director
  accounts may share a club (director and deputy).

**H2: Club roster for a club year**
- One roster per club per club year (for example 2026–27). Each member is a `Person`
  plus a membership row holding role, active/inactive status, birth date or grade,
  guardian contact, and the source.
- Directors add, edit, and deactivate members. Every change is audited and history
  is kept. Rollover (copying last year's active members) can come after December.
- **Seeding:** a one-time reviewed CSV import. The source could be a CMMS-1 export,
  a Club Ministry spreadsheet, or the **2026 Honors Weekend registrations**: 29
  clubs and 475 people, with ages but no birth dates. It follows the preview →
  match → review → apply pattern used for WR26 and keeps source IDs. Importing
  real minors' records is a human-approved production import (decision D4).
- No medical, insurance, or background-check fields (principle 5).
- Carves out narrow versions of #183 and #184.

**H3: "Who's going" club registration**
- For an event marked as a club event, the director opens it, ticks the roster
  members attending, and gets the event's published form **pre-filled** with those
  people. The form asks only that event's questions: club-level and per-attendee.
- On submit, it becomes an ordinary registration linked to the club: church-billed,
  confirmation email, QR, check-in, and reports all unchanged. One registration per
  club per event. The director can reopen it to add or remove people until the
  deadline.
- The same roster serves Camporee in the spring, so the club registers once.
- Each person carries an **attendee type** (youth, staff, adult, underage) and a
  dietary field, as in 2026.
- A **Spanish-language version** of the form for sites that need it (decision D11).
- **Saves as a draft** while the director works, so a reload or closed tab loses
  nothing, unlike the 2026 form. It keeps the event-information acknowledgment
  and the per-site head count.
- Carves out narrow versions of #186, #188, and #194.

**H4: Honor catalog, sites, and sessions**
- Staff maintain an honor catalog (name, code, description). The 65 offerings
  from 2026 (54 distinct honors) can seed it.
- Honors Weekend is **several sites** (in 2026: Camp Heritage weekend 1, Camp
  Heritage weekend 2, Des Moines, Kansas City). Each is a separate event, created
  quickly from the previous one.
- For each site, staff name its **sessions**, because names differed by site
  (Sabbath / Sunday; Sabbath afternoon / Saturday evening–Sunday; 2:30 / 5:30).
- Staff then add offerings: an honor in a session, or a **2-session honor** that
  fills both, with:
  - a **capacity** (youth seats);
  - an optional **minimum age**;
  - an optional **per-club limit** (for example at most 3 Pathfinders per club,
    which 2026 hard-coded for Iowa Backpacking);
  - a **teacher name** and a **location**.
- Eligibility for 2027 is **minimum age only**, which is all 2026 used. Maximum
  age, role, prerequisite honors, and Master Guide can wait (decision D5).
- Carves out a narrow version of #197 and the offering part of #207.

**H5: Class selection at registration (first-come, live seats)**
- **This matches how 2026 worked.** While registering, the director picks up to
  **one class per session** for each person: a Sabbath class and a Sunday class,
  or one Full class. Only classes the person is old enough for, that still have
  seats, are shown.
- **Seats count youth only.** Staff and adults may join a class without using a
  seat, as in 2026. Per-club limits count youth only too.
- Seats are checked and taken in the **same serializable transaction that saves
  the registration**, the way event capacity already works, so a class can never
  be overfilled. A full class is refused with a clear message.
- Directors can change classes (and free seats) until the site's deadline.
- **Fallback:** if first-come proves unfair, the existing **program-assignments**
  engine (ranked choices, reviewed batch placement) can run a site instead.
  That's an event-level choice, not a rebuild.
- Waitlists can wait until after 2027.
- Carves out a narrow version of #208.

**H6: Teacher, site, and club rosters**
- Printable and CSV rosters, replacing the 2026 sheets:
  - per class: teacher, session, location, and each attendee's name, club, age,
    and type, with youth/seat totals;
  - per site: youth, staff, and adult totals, with a check-in column;
  - per club: each person's schedule.
- Check-in on the day uses the existing QR check-in, with paper as the fallback.
- Cabin assignment stays on paper for 2027. Class attendance and honor sign-off
  come later (#209, #197).

**Order:** H1 → H2 → H3, with H4 in parallel; then H5 → H6. Rehearse with one or
two real directors before registration opens.

### 6.2 Camporee (registration opens January or February; event April 29 – May 2)

| Slice | Why | Issues |
| --- | --- | --- |
| Reuse the roster and "who's going" | Clubs register once (H2/H3) | — |
| Roster rollover and CSV re-import | Directors refresh for the new year | #184 (narrow) |
| Background-check readiness for adults | Confirmed requirement | #115 → #113; **human gate #218** before any real data |
| Set up Camporee 2027 from a template or clone | Avoid hand-building | #152, #157 |
| Campsite assignment | Likely needed | #89 (grouping) |
| **Post-event church invoice** | Billed after attendance | #165 → #166 → #167 (human approval); build Feb–May |

### 6.3 Camp Meeting (registration opens end of March; event in June)

| Slice | Why | Issues |
| --- | --- | --- |
| Move the hard-coded Camp Meeting form into a template; remove retreat-only naming | Stop WR26-shaped code spreading | #153, #155, #104 |
| Lodging: rooms, tents, RV sites, availability, assignment | Confirmed requirement | #198 → #199 → #200 |
| Meal plans and selections | Confirmed requirement | #210 (+ #211 meal credentials, #212 kitchen counts if needed) |
| Hosted Square payment fallback | Attendee-paid event | #327 (product decisions recorded Sept 21) |

### 6.4 Timeline

| When | Work |
| --- | --- |
| Now → Oct 9 | WR26 operational items (Section 4). **Start H1 and H2** (no payment code touched). **Get decisions D3, D4, D11.** |
| Oct 9–11 | **WR26** |
| Oct 12 → Oct 31 | H3, H4 |
| Nov 1 → Nov 20 | H5, H6; seed rosters and the honor catalog; rehearse with 1–2 directors |
| Late Nov | Buffer; set up the 2027 sites and offerings |
| **Dec 2026** | **Honors Weekend registration opens** |
| Dec → Jan | Background-check readiness for Honors Weekend staff and adults (#115, #113; #218 approval); roster rollover; Camporee setup from template (#152, #157); campsite grouping (#89) |
| Late Feb – Mar 2027 | **Honors Weekend sites** (2026 pattern); rosters from H6; QR check-in |
| Jan/Feb | **Camporee registration opens** |
| Feb → Mar | Camp Meeting: #153, #155, #104; lodging #198–#200; meals #210; #327 |
| End of March | **Camp Meeting registration opens** |
| Apr 29 – May 2 | **Camporee** |
| May | Church invoicing (#165–#167); honors attendance and sign-off (#209, #197) |
| June | **Camp Meeting** |

February and March are the tightest stretch: Honors Weekend runs, Camporee
registration is live, and Camp Meeting lodging and meals are being built. If Camp Meeting's lodging and meal needs
are simple, narrow them the same way as H1–H6.

---

## 7. Proposed changes to roadmap #98 (needs human approval)

1. Add an **"Honors Weekend and club events 2026–27"** section at the top of #98's
   execution order, linking new issues H1–H6 and the Camporee and Camp Meeting rows
   above.
2. Create H1–H6 as bounded issues, each with a parent (#193, #183/#184, #186/#188,
   #197, #208, #209). Label them `phase-1` or `phase-2` as fits, and add
   `codex-ready` only after decisions D1–D5 are recorded.
3. **Remove `codex-ready` from Phase 2–5 issues that are not on this calendar**
   (wallet, passkeys, mobile, site builder, surveys, transport, issued assets, and
   so on), so automated builds work toward November, April, and June. Restore the
   label as the calendar moves.
4. Record on #68 that Honors Weekend will be built from narrow slices of #183–#197,
   with CMMS-1 as the reference, and that the full capability matrix (#195) follows
   after December.

---

## 8. Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Decisions D1–D4 arrive late | November slips | Start H1/H2 now; they do not depend on D1–D4 |
| Directors do not keep rosters current | Wrong attendees or ages break eligibility | Seed from CMMS/spreadsheet; H3 lets directors add a person while registering |
| First-come live seats | Overfilled classes when directors register at the same moment | Take seats inside the registration's serializable transaction (H5), as event capacity already does; test concurrent submissions |
| Registration opening day | Directors rush the most popular classes at once | First-come was already accepted in 2026; rehearse with directors; keep the program-assignments fallback |
| Several sites to set up | Staff hand-build four events | Create each 2027 site from the previous one (#157 narrow) or a copy script |
| Minors' data seen by the wrong director | Privacy incident | H1 grants are explicit and scoped; tests for other-club access |
| Medical data pulled onto rosters | Crosses the unapproved protected-records gate | Principle 5; medical stays per-event |
| Automation claims unrelated `codex-ready` work | Effort goes to wallets or mobile | Section 7, item 3 |
| Camp Meeting lodging and meals in Feb–Mar | Squeeze on the Camp Meeting opening date | Decide scope early (D10); narrow slices |

---

## 9. Decisions needed

| # | Decision | Owner | Blocks |
| --- | --- | --- | --- |
| D1 | **Answered by 2026 practice:** classes are chosen at registration, first-come, with live seats (H5). Confirm this stays for 2027, or choose ranked batch placement for some sites | Caleb + Club Ministry | H5 |
| D2 | **Answered by 2026 practice:** Camp Heritage used Sabbath, Sunday, and Full sessions, with up to two classes per person. Confirm, and say whether Des Moines and Kansas City should use sessions too | Club Ministry | H4, H5 |
| **D3** | **2027 sites and dates, registration open and close dates, price, and billing.** Church-billed like Camporee? Attendee pay? Free? (The 2026 sheet has no payment data) | Club Ministry | H3, site setup |
| **D4** | **Roster and catalog source:** seed rosters from the 2026 Honors Weekend registrations, a CMMS-1 export, or a Club Ministry spreadsheet? Importing real minors' records needs a named human approval. Is CMMS-1 in use today? | Caleb | H2, H4 seeding |
| D5 | **Answered by 2026 practice:** minimum age was the only rule used. Confirm that no maximum age, role, or prerequisite honor is needed for 2027 | Club Ministry | H4 |
| D6 | Who gets director access (director only, or deputies too), and how is a director verified before the grant? | Caleb + Club Ministry | H1 |
| D7 | **Answered by 2026 practice:** staff and adults were checked against Sterling. Confirm this is required for 2027, and who approves the status mapping (#218) | Club Ministry | #115/#218 timing |
| D8 | Do teachers need their own sign-in, or are printed rosters enough (as in 2026)? | Club Ministry | H6 scope |
| D9 | Fallback: if November slips, reuse the 2026 Fluent Forms and Google Sheet process for one more year? | Caleb | Contingency |
| D10 | Camp Meeting: which lodging types (rooms, tents, RV), whether meals are plans or per-meal, and whether either is paid online | Camp Meeting team | #198–#200, #210 |
| **D11** | **Spanish-language registration:** which sites need it, and should the confirmation emails be translated too? | Club Ministry | H3 |

---

## 10. Sources

- This repository at `274551b`: `modules/organizations`, `modules/program-assignments`,
  `modules/forms/definition.ts` (Spring Camporee 2026 template), `modules/payments`,
  `docs/decisions/0002-unified-operations-platform.md`, `docs/WR26-GO-LIVE-REVIEW.md`.
- GitHub: #98 (roadmap), #68 (CMMS unification, including the July 31 owner
  decision), #143, #183–#197, #207–#209, #327.
- CMMS-1 (`DurantTL/CMMS-1`, read-only, last commit July 8, 2026): `README.md`,
  `HOW-TO-ClubDirector.md`, `prisma/schema.prisma`,
  `app/actions/{roster,event-registration,enrollment,honors,teacher}-actions.ts`,
  `docs/system-specification.md`, `docs/build-plan-review.md`,
  `tasks/phase-4-honors-ui.md`.
- The "Honors Weekend 2026" Google Sheet (access-controlled; it holds real
  attendee data, so only structure and totals were used, and it is deliberately
  not linked here).
- The Fluent Forms export of the 2026 "Pathfinders Honors Weekend Registration"
  form (form definition, custom script, and settings; no submissions).
- Production command center screenshot, September 22, 2026: Spring Camporee 2027
  draft, Apr 29 – May 2, 2027, Camp Heritage, MO.
