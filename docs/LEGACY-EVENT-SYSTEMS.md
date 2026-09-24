# Legacy event systems: what they did and where it lives now

Prepared September 24, 2026. This summarizes the systems IMSDA ran its 2026 events on, so automated builds can check requirements without opening those repositories. **Reference only:** their code is never copied here (roadmap #98, standing decisions). No attendee data from them appears in this document. The form exports reviewed were used for structure only.

All four followed the same pattern: a **Fluent Forms** registration on WordPress posted to a **Google Apps Script** web app, which wrote to **Google Sheets**. Each event was a copy of the previous event's scripts, so every copy re-solved email, check-in, payments and admin tools on its own. IMSDA Events replaces them with one system.

| Event | Legacy system | 2027 registration opens | Build queue (#98) |
| --- | --- | --- | --- |
| Honors Weekend | Fluent Forms and a Google Sheet (see `CLUB-MINISTRY-AND-HONORS-WEEKEND-PLAN.md` §3.4) | December 2026 | Built (H1–H6); #366 |
| Spring Camporee | `DurantTL/CCRS-IMSDA` | February 2027 | Queue 1 |
| Man Camp | `DurantTL/MC26-IMSDA` (a household-based fork of CCRS) | February 2027; the event is a few weeks before Spring Camporee | Queue 2 |
| Camp Meeting | `DurantTL/CM26-IMSDA` | End of March 2027 | Queue 2 |
| Fall Camporee | Fluent Forms only; always two locations (Iowa and Missouri) | Summer 2027 | Queue 3 |

## Spring Camporee (CCRS-IMSDA)

One registration per club, billed to the church.

| Legacy behavior | IMSDA Events |
| --- | --- |
| Club, director, church; roster by role (Pathfinder, TLT, Staff, Child) with age, gender, dietary needs, first-timer | Club registration from the roster (H3); the Camporee form template (`sc_` fields) |
| $9 per person, +$5 after the late date, −$5 per person fed when a club sponsors a meal (capped at headcount, floored at $0) | #409 records the amount the church owes; invoices in #165–#168 |
| Camping: tents, trailer, kitchen canopy, square feet, camp-next-to | Template questions; reports in #411 |
| Duty preferences (kitchen, flag slots, bathroom days) and activities (vespers special, campfire, games, Oregon Trail, skit, drummer, ribbons) | Template questions; assignments in #410 |
| Spiritual milestones (baptism interest, Bible read-through), medical personnel, Master Guide investiture | Template questions; reports in #411 |
| Coordinator "Assignment Manager": campsite, duty time, activity per club; a second email ("Email 2") with the assignments | #410 |
| Club Dashboard and Camping Coordinator reports rebuilt after each registration | #411 |
| Check in a whole club; shows the balance and campsite | #412 |
| PDF per club (PDFShift) | Club packet in #411 |
| Free-text medical notes per person | **Removed** by #408 (ADR 0005; `HEALTH-RECORDS-OPTIONS-REPORT.md`) |

## Fall Camporee (Fluent Forms)

The 2026 event was at Kent Park, Iowa (Sept 25–26) and Thompson Farm, Missouri (Sept 25–27). The form had:
- a choice of location;
- the club (from a list) and the sponsoring church;
- the director's contact details;
- campsite needs (kitchen size, tents);
- a roster;
- a photo/video release and an acknowledgment of the Sterling Volunteers and driver requirements;
- a typed signature and date.

No payment was taken on the form.

IMSDA Events:
- two locations: #413;
- the typed signature: #150;
- Sterling flags: #405;
- club registration: H3.

## Man Camp (MC26-IMSDA)

Registration by person or household, paid by card. Fathers attend with sons.

| Legacy behavior | IMSDA Events |
| --- | --- |
| Primary contact, address, church, attendees with age, accommodations, dietary needs (meals are vegetarian), card payment | Public registration (as for Women's Retreat); the Man Camp template (`mc_` fields) |
| Cabins with a detached restroom (90 bottom bunks, bring your own linens), cabins with a connected restroom (33 bottom bunks, linens provided), RV sites with hookups (configurable; amps and length), tents (unlimited), Sabbath-only attendance | Lodging #198 → #200 |
| Only bottom bunks are public inventory; a child linked to a guardian may take the top bunk above them; a child with no guardian link goes to manual review; over-capacity requests go to the waitlist | #131 (guardian links), #199, #200 |
| Waitlisted or under-review people aren't checked in until lodging is resolved | #200 |
| Shirt sizes and inventory | Shirt sizes; merchandise |
| Per-person check-in | Check-in |

## Camp Meeting (CM26-IMSDA)

Registration by household with lodging, meals and keys, June 2–6, 2026.

| Legacy behavior | IMSDA Events |
| --- | --- |
| Dorm rooms ($25/night, 80 rooms, two twin beds, 4+ nights), 16 numbered RV spots ($15/night), tents ($5/night); choosing nights (Tue–Sat); first-floor request for medical reasons | Lodging #198 → #200; the Camp Meeting template (`cm_` fields) |
| Meal tickets per meal and age group (breakfast Wed–Sat, lunch Wed–Fri, supper Tue–Sat; Saturday lunch is donation-only); an offline café scanner app | #210 → #212 |
| Full card payment, a $65 card deposit with the balance at check-in, or a mailed check with the $65 deposit | Pay later exists; the deposit is #415 |
| Card fee passed on (2.9% + 30¢) | Built |
| Two numbered keys per room, a cash key deposit, refund at check-out when both keys return; "welcome packet given" | #213 → #214 (includes check-out) |
| Cancel before the deadline: refund minus $10; after it, or a first-night no-show: the deposit is forfeited | #169 → #171 |
| Free staff and pastor registrations (a separate Google Form), low priority, movable to a hotel | Staff registrations; hotel moves need lodging (#200) |
| Waitlist-offer and pre-event reminder emails | Waitlist built; scheduled reminders are #177 |
| Offline check-in app with its own volunteer logins | Check-in with the offline queue, behind staff sign-in and MFA |

## What carries across every event

Build these once; every event uses them:
- **Lodging:** Man Camp and Camp Meeting.
- **Church invoicing:** Spring Camporee, Fall Camporee, Honors Weekend.
- **Group check-in:** every club event.
- **Assignments and reports:** Camporee now; other events later.
- **Templates and cloning:** every event every year (#152, #157).
