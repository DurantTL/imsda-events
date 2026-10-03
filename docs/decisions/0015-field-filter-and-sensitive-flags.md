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

## Read-time defaults (no data migration)

When a flag is absent, `modules/forms/field-flags.ts` supplies a default at
read time. Nothing stored is rewritten.

- `sensitive`: true for health-type fields, using the shared word list in
  `modules/forms/sensitive-fields.ts` on the field's key, label, help text,
  section title and choice text.
- `filterable`: true for an ordinary choice field that is not health-type and
  is not the payment-method field. This is what the #739 word list allowed, so
  the Women's Retreat meal filter keeps working. Choice text such as
  "Vegetarian", "Vegan" or "Gluten-free" does not make a field health-type for
  this default only.

An explicit true or false always wins. The form builder shows the resolved
value, so Sensitive appears pre-checked for health-type fields, and stores an
explicit value once staff change the box.

## Staff views

Changed: check-in book extra column and badge-CSV Position (a sensitive field
is never offered); operational reports (an explicitly sensitive field is
excluded); the answer filter and its export.

Left alone: People page registration detail and the answers editor, the
registration list/detail API (all already require VIEW_SENSITIVE_DATA, so staff
there may see every answer); the general registrations export and finance
exports (no form answers); honors rosters dietary column (already gated by
VIEW_SENSITIVE_DATA); coordinator health (own access rules); program
assignments (staff-chosen preference field, no free display); club form
builder (separate definition type).
