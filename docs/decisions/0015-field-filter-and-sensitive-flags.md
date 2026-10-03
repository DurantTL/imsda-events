# 0015: Per-field "Show as a filter" and "Sensitive" flags (#743)

Status: accepted (director decision, Oct 3).

## Decision

Each registration form field carries two optional booleans in the form
definition JSON: `filterable` ("Show as a filter") and `sensitive`
("Sensitive"). They are versioned with the form version. No database column or
migration is needed.

- A field is offered in the People & registrations answer filter (#739) only
  when it is `filterable` AND is a choice field with options (drop-down, radio
  group or multi-select; not a directory-sourced list; never the
  payment-method field).
- A `sensitive` field is offered, and its answers shown, only to staff holding
  VIEW_SENSITIVE_DATA. A field wired by `conditional` / `optionalWhen` to a
  sensitive field, in either direction, is treated as sensitive.
- #739's other safeguards are unchanged: only offered values are counted, each
  registration is read from its own form version, the filtered export needs
  VIEW_REPORTS and VIEW_SENSITIVE_DATA.
- Today every caller of the answer filter holds VIEW_SENSITIVE_DATA (the People
  page and the export both require it). The sensitive check is still enforced
  in the filter itself, so a future caller without the permission is safe.

## Read-time defaults keep #739 parity (no data migration)

When a flag is absent, `modules/forms/field-flags.ts` supplies a default at
read time. Nothing stored is rewritten. **Defaults keep #739 parity for
published forms: a form behaves after deploy exactly as it did before, and a
new filter needs an explicit tick.**

- `sensitive`: true for health-type fields, using the shared word list in
  `modules/forms/sensitive-fields.ts` (including celiac and intoleran) on the
  field's key, label, help text, section title and choice text.
- `filterable`: true ONLY for a field #739 would have offered: a choice field
  with options, not health-type, not the payment-method field, not
  directory-sourced, and not linked (either direction) to a sensitive field or
  to the payment-method field. The link check runs in the answer filter, which
  has the whole form. Everything else (gender, minor, housing, childcare,
  awards and so on) is not filterable until staff tick the box.
- The vegetarian / vegan / gluten carve-out is kept inside this legacy default
  only: choice text such as "Vegetarian" does not make a menu field
  health-type, so the live Women's Retreat meal field keeps working without
  anyone re-saving the form.

An explicit true or false always wins. The form builder shows the resolved
value, so Sensitive appears pre-checked for health-type fields (and checked,
read-only, for a field linked to a sensitive field), and writes an explicit
`sensitive: true` for a health-type field the first time the form is saved, so
a later rename cannot clear it.

## Staff views

Changed: check-in book extra column and badge-CSV Position (a sensitive field
or a field linked to one is never offered; section titles are honoured; a key
that is ineligible in any form version is out for all); operational reports (a
field is excluded when explicitly flagged sensitive in any form version
present, or by the report's existing wording rules; the builder's health
default is deliberately not applied there, because its shared stems, such as
"accommod", would drop the report's own housing field and the Leadership
Weekend "Meals" field, whose help text says "All meals are vegetarian");
the answer filter and its export.

Left alone: People page registration detail and the answers editor, the
registration list/detail API (all already require VIEW_SENSITIVE_DATA, so staff
there may see every answer); the general registrations export and finance
exports (no form answers); honors rosters dietary column (already gated by
VIEW_SENSITIVE_DATA); coordinator health (own access rules); program
assignments (staff-chosen preference field, no free display); club form
builder (separate definition type).

## Known gap: flags are per form version

Flags are read from each registration's own form version. A registration
submitted under an older version that lacks a flag follows that version's
defaults, not the newer version's explicit flag. The answer filter, the badge
CSV and operational reports guard against this by treating a key as sensitive
or ineligible if ANY version present says so. The check-in book does the same
for its extra column. Other readers that look at one version at a time would
need the same treatment if they start showing form answers.
