# Registration forms

Build 6 stores each form as an event-scoped `RegistrationForm` with ordered `RegistrationFormVersion` records. The definition is validated JSON so the builder can add new field types without mutating historical versions.

- Draft versions are editable with optimistic timestamp conflict protection.
- Test submissions are fictitious, event-scoped, and tied to one exact version.
- At least one valid test submission is required before publication.
- Published versions are immutable. Editing a published form creates the next draft version.
- Publishing archives the previously published version and writes an audit event in the same transaction.
- `MANAGE_FORMS` is granted to event administrators and registration managers; every API also requires an active event membership.
- Supported controls include short text, long answers, email, phone, searchable
  dropdowns, single choice, multiple choice, ranked choice, acknowledgments,
  dates, numbers, and automatic fees. Dropdowns use the same keyboard-accessible
  search control on public registration, builder preview, and attendee
  self-service editing. Choice fields support reusable presets, up to 200
  configured choices, exact minimum/maximum selection rules, per-choice
  pricing, and optional limits.
- Availability is explicitly opt-in. Ordinary choices such as payment method display no interest or unlimited-capacity wording. Capacity choices report occupied spots and stop new selections at the configured limit. Ranked-interest choices separately report first choice, second choice, combined demand, and the assignment room capacity; room limits never block a preference submission because the later assignment run must be able to see excess demand. Builder-preview counts come from valid fictitious test submissions; public counts come from committed reservations.
- Flat, quantity, choice, and automatic-fee prices can switch to a configured late price on a calendar date. The builder includes a preview date so both sides of the deadline can be tested. Card totals can include a grossed-up percentage plus fixed processing fee.
- Fields can include placeholders, help text, required status, and registration-level or attendee-level scope.
- Forms can explicitly enable a household/group roster with configured minimum and maximum attendee counts. Registration fields render once; attendee fields repeat in ordered, add/remove/reorder cards and evaluate conditions against shared registration answers plus that attendee’s own answers.
- The builder uses compact collapsible field modules. Staff can search modules,
  filter them by category, and copy an existing field when creating a similar
  question. Staff can insert Contact Details, Mailing Address, Church & Club
  Contact, Attendee Preferences, Guest Roster, Housing & Nights, Campsite
  Footprint, Meal Ticket Quantities, Activity Signup, Seminar Ranking,
  Scheduled Registration Fee, Payment Methods, Promo Code, Acknowledgment, or
  Blank Field blocks; common settings stay visible while stable keys and
  supporting copy live under Advanced options. The Church & Club module
  includes the searchable IMSDA church directory plus an Other field. The Promo
  Code module supplies the canonical public Apply/Remove interaction without
  requiring staff to type a special field key.
- Export-derived starters are included for Women’s Retreat, Man Camp, Spring Camporee, and Camp Meeting. They use native repeatable rosters and conditions instead of copied WordPress scripts. Women’s Retreat keeps ranked first/second seminar interest and its August 15 rate change; Man Camp prices each lodging/attendance package and leaves volunteers free; Spring Camporee includes its April 11 per-person rate change and dependent duty/activity questions; Camp Meeting calculates conditional per-night housing, separate adult/child meal tickets, and the card fee.

Published forms are exposed at `/events/{event-slug}`, `/register/{event-slug}/{form-slug}`, and the embeddable `/embed/{event-slug}/{form-slug}` view when the event is published and within its registration window. Public submission reloads the exact version, allow-lists visible registration/attendee responses, prices in the event timezone, persists ordered attendees and immutable response/pricing snapshots, and claims capacity in a serializable transaction. Full events can create an ordered waitlist entry without reserving inventory; cancellation releases inventory and may automatically promote the earliest fitting request. The committed registration then receives an expiring private management link and queues the correct local or external confirmation. Card-selected balances are paid from that private page through the Square boundary.

The event settings screen generates the complete two-script embed block. The
embed-only layout removes viewport-height constraints and `/embed/embed.js`
reports content changes to the parent. `/embed/embed-host.js` validates the
message origin, matches the sending frame by `contentWindow`, resizes multiple
frames independently, and scrolls the correct frame into view after step
changes, validation errors, or confirmation. The public registration request
is stateless and does not depend on a third-party session or CSRF cookie.
