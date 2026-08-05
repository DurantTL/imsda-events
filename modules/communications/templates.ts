import { escapeMarkdown, renderEmailBodyHtml } from "@/modules/communications/email-html";

export const MESSAGE_TEMPLATE_KEYS = [
  "REGISTRATION_CONFIRMATION_PAID",
  "REGISTRATION_CONFIRMATION_UNPAID",
  "REGISTRATION_CONFIRMATION_ORGANIZATION_BILLED",
  "WORKER_CONFIRMATION",
  "INTERNAL_NEW_REGISTRATION",
  "WAITLIST_JOINED",
  "WAITLIST_PROMOTED",
  "REGISTRATION_CANCELLED",
  "REGISTRATION_CONTACT_UPDATED",
  "REGISTRATION_UPDATED",
  "PAYMENT_RECEIPT",
  "BALANCE_REMINDER",
  "REGISTRATION_TRANSFERRED_NEW_CONTACT",
  "REGISTRATION_TRANSFERRED_PRIOR_CONTACT",
  "ATTENDEE_SUBSTITUTED",
  "SHIRT_SIZE_REQUEST",
  "REGISTRATION_ACCESS_RECOVERY",
  "EVENT_ANNOUNCEMENT",
] as const;

export type MessageTemplateKey = (typeof MESSAGE_TEMPLATE_KEYS)[number];

const EVENT_TEMPLATE_KEYS: ReadonlySet<string> = new Set(MESSAGE_TEMPLATE_KEYS);

/**
 * The database enum also carries the account keys — activation and password
 * reset — which are not event templates: they are not editable, not versioned,
 * and belong to no event. This is the boundary that keeps them out.
 */
export function isEventMessageTemplateKey(key: string): key is MessageTemplateKey {
  return EVENT_TEMPLATE_KEYS.has(key);
}

export const MESSAGE_TEMPLATE_TOKEN_KEYS = [
  "recipient_name",
  "registrant_name",
  "event_name",
  "event_dates",
  "event_location",
  "confirmation_code",
  "attendee_summary",
  "total_amount",
  "balance_amount",
  "payment_instructions",
  "portal_url",
  "reply_to_email",
  "waitlist_position",
  "contact_email",
  "registration_contact_email",
  "change_category",
  "seminar_preferences",
  "payment_amount",
  "payment_reference",
  "prior_person_name",
  "new_person_name",
  "announcement_title",
  "announcement_body",
  "hotel_information",
  "payment_status_block",
  "checkin_block",
  "checkin_qr_url",
  "checkin_qr_image",
] as const;

export type MessageTemplateToken = (typeof MESSAGE_TEMPLATE_TOKEN_KEYS)[number];

export const ALLOWED_MESSAGE_TEMPLATE_TOKENS: ReadonlySet<MessageTemplateToken> = new Set(
  MESSAGE_TEMPLATE_TOKEN_KEYS,
);

/**
 * Tokens whose absence is a state of the world rather than a rendering fault.
 * An event with no hotel, a registration with no check-in pass, and a message
 * type with no payment state each render nothing where a required token would
 * instead leave `{{token}}` in the body and stop the send.
 *
 * Every server-generated block belongs here: the block builders already decide
 * whether a section has anything to say, and an empty return is that decision.
 */
export const OPTIONAL_MESSAGE_TEMPLATE_TOKENS: ReadonlySet<MessageTemplateToken> = new Set([
  "hotel_information",
  "payment_status_block",
  "checkin_block",
  "checkin_qr_url",
  "checkin_qr_image",
  "seminar_preferences",
]);

/**
 * Tokens whose value is allowed to carry live Markdown into the formatted body.
 *
 * Everything else is Markdown-escaped before it is substituted, because HTML
 * escaping alone does not stop Markdown injection: a registrant named
 * `[Review your registration](https://malicious.example)` would otherwise get a
 * trusted-looking link, and `![](…)` a tracking pixel, into mail sent from the
 * IMSDA address.
 *
 * Membership here means "this string is composed by us or by staff, at the same
 * trust level as the template body itself":
 *
 * - the block builders, which assemble their own Markdown from generated
 *   values and neutralise the staff-configured parts they interpolate;
 * - the URL tokens, which are delivery sentinels or server-built URLs and are
 *   written inside `[text](…)` and `![alt](…)`, where escaping would break the
 *   link rather than protect it;
 * - `announcement_body`, which staff author in the workspace and which exists
 *   to carry formatted event information.
 *
 * `attendee_summary` is deliberately absent: it is assembled from registrant
 * names and submitted form answers, so it is escaped and renders as plain
 * lines rather than a list.
 */
export const MARKDOWN_MESSAGE_TEMPLATE_TOKENS: ReadonlySet<MessageTemplateToken> = new Set([
  "hotel_information",
  "payment_status_block",
  "checkin_block",
  "checkin_qr_url",
  "checkin_qr_image",
  "portal_url",
  "announcement_body",
]);

export type MessageTemplateContext = Partial<
  Record<MessageTemplateToken, string | null | undefined>
>;

export type MessageTemplateDefinition = {
  key: MessageTemplateKey;
  name: string;
  description: string;
  subject: string;
  body: string;
};

export const DEFAULT_MESSAGE_TEMPLATE_NAMES: Readonly<Record<MessageTemplateKey, string>> = {
  REGISTRATION_CONFIRMATION_PAID: "Paid registration confirmation",
  REGISTRATION_CONFIRMATION_UNPAID: "Unpaid registration confirmation",
  REGISTRATION_CONFIRMATION_ORGANIZATION_BILLED: "Organization-billed registration confirmation",
  WORKER_CONFIRMATION: "Worker registration confirmation",
  INTERNAL_NEW_REGISTRATION: "Internal new registration notice",
  WAITLIST_JOINED: "Waitlist joined confirmation",
  WAITLIST_PROMOTED: "Waitlist promotion confirmation",
  REGISTRATION_CANCELLED: "Registration cancellation",
  REGISTRATION_CONTACT_UPDATED: "Registration contact updated",
  REGISTRATION_UPDATED: "Registration updated",
  PAYMENT_RECEIPT: "Payment receipt",
  BALANCE_REMINDER: "Balance reminder",
  REGISTRATION_TRANSFERRED_NEW_CONTACT: "Transfer notice for new contact",
  REGISTRATION_TRANSFERRED_PRIOR_CONTACT: "Transfer notice for prior contact",
  ATTENDEE_SUBSTITUTED: "Attendee substitution notice",
  SHIRT_SIZE_REQUEST: "Shirt size request",
  REGISTRATION_ACCESS_RECOVERY: "Private registration link recovery",
  EVENT_ANNOUNCEMENT: "Event announcement",
};

export const DEFAULT_MESSAGE_TEMPLATE_DESCRIPTIONS: Readonly<
  Record<MessageTemplateKey, string>
> = {
  REGISTRATION_CONFIRMATION_PAID:
    "Sent to a registrant whose recorded balance is paid in full.",
  REGISTRATION_CONFIRMATION_UNPAID:
    "Sent to a registrant who still has a balance or payment step to complete.",
  REGISTRATION_CONFIRMATION_ORGANIZATION_BILLED:
    "Sent for a registration on a deferred-organization-billing event. States that no payment is due online and the responsible organization will be billed later.",
  WORKER_CONFIRMATION:
    "Sent for a worker registration, regardless of the current recorded balance.",
  INTERNAL_NEW_REGISTRATION:
    "Sent to configured IMSDA recipients when a new registration is submitted.",
  WAITLIST_JOINED:
    "Confirms a waitlist position and clearly states that no payment is due.",
  WAITLIST_PROMOTED:
    "Sent when a waitlisted registration receives a place and can continue payment.",
  REGISTRATION_CANCELLED:
    "Confirms cancellation while preserving accurate payment and refund wording.",
  REGISTRATION_CONTACT_UPDATED:
    "Confirms a self-service contact change to the new message destination.",
  REGISTRATION_UPDATED:
    "Confirms an attendee-visible registration change without including submitted answer values.",
  PAYMENT_RECEIPT:
    "Sent once when a Square payment first reaches a successful state.",
  BALANCE_REMINDER:
    "Sent only after staff review a current balance-due audience and explicitly create a reminder batch.",
  REGISTRATION_TRANSFERRED_NEW_CONTACT:
    "Sent to the new registration contact with a newly issued private management link.",
  REGISTRATION_TRANSFERRED_PRIOR_CONTACT:
    "Tells the prior registration contact that responsibility and private access changed.",
  ATTENDEE_SUBSTITUTED:
    "Tells the registration contact, prior attendee, and replacement attendee when their valid email destinations differ.",
  SHIRT_SIZE_REQUEST:
    "Sent only after staff review an audience of registrations still missing a shirt size. Carries the private management link, so a migrated registrant reaches self-service for the first time from this message.",
  REGISTRATION_ACCESS_RECOVERY:
    "Sent when a registrant proves knowledge of a confirmation code and its current contact email, with a newly issued private management link.",
  EVENT_ANNOUNCEMENT:
    "Sends a published event-feed announcement to active registration contacts after an explicit staff broadcast action.",
};

export const DEFAULT_MESSAGE_TEMPLATE_SUBJECTS: Readonly<
  Record<MessageTemplateKey, string>
> = {
  REGISTRATION_CONFIRMATION_PAID:
    "Registration confirmed: {{event_name}} ({{confirmation_code}})",
  REGISTRATION_CONFIRMATION_UNPAID:
    "Registration received — balance due for {{event_name}}",
  REGISTRATION_CONFIRMATION_ORGANIZATION_BILLED:
    "Registration received: {{event_name}} ({{confirmation_code}})",
  WORKER_CONFIRMATION: "Worker registration received: {{event_name}}",
  INTERNAL_NEW_REGISTRATION:
    "New registration: {{event_name}} — {{confirmation_code}}",
  WAITLIST_JOINED:
    "Waitlist confirmation: {{event_name}} ({{confirmation_code}})",
  WAITLIST_PROMOTED: "A place is available: {{event_name}}",
  REGISTRATION_CANCELLED: "Registration cancelled: {{event_name}}",
  REGISTRATION_CONTACT_UPDATED: "Contact details updated: {{event_name}}",
  REGISTRATION_UPDATED: "Registration updated: {{event_name}}",
  PAYMENT_RECEIPT:
    "Payment received: {{event_name}} ({{confirmation_code}})",
  BALANCE_REMINDER:
    "Payment reminder: {{event_name}} — {{balance_amount}} due",
  REGISTRATION_TRANSFERRED_NEW_CONTACT:
    "Registration transferred to you: {{event_name}} ({{confirmation_code}})",
  REGISTRATION_TRANSFERRED_PRIOR_CONTACT:
    "Registration contact transferred: {{event_name}} ({{confirmation_code}})",
  ATTENDEE_SUBSTITUTED:
    "Attendee substitution recorded: {{event_name}} ({{confirmation_code}})",
  SHIRT_SIZE_REQUEST:
    "Shirt sizes needed for {{event_name}} ({{confirmation_code}})",
  REGISTRATION_ACCESS_RECOVERY:
    "Your private registration link: {{event_name}} ({{confirmation_code}})",
  EVENT_ANNOUNCEMENT:
    "{{event_name}} update: {{announcement_title}}",
};

export const DEFAULT_MESSAGE_TEMPLATE_BODIES: Readonly<Record<MessageTemplateKey, string>> = {
  REGISTRATION_CONFIRMATION_PAID: [
    "# You're registered for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "Your registration is confirmed. Please keep this message for your records.",
    "",
    "### Your registration",
    "",
    "- **Confirmation code:** {{confirmation_code}}",
    "- **Dates:** {{event_dates}}",
    "- **Location:** {{event_location}}",
    "",
    "{{attendee_summary}}",
    "",
    "**[View, pay, or edit your registration]({{portal_url}})**",
    "",
    "{{payment_status_block}}",
    "",
    "{{hotel_information}}",
    "",
    "{{checkin_block}}",
    "",
    "---",
    "",
    "Questions? Contact {{contact_email}}.",
  ].join("\n"),
  REGISTRATION_CONFIRMATION_UNPAID: [
    "# We received your registration for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "Your place is recorded. A balance remains on this registration.",
    "",
    "### Your registration",
    "",
    "- **Confirmation code:** {{confirmation_code}}",
    "- **Dates:** {{event_dates}}",
    "- **Location:** {{event_location}}",
    "",
    "{{attendee_summary}}",
    "",
    "**[View, pay, or edit your registration]({{portal_url}})**",
    "",
    "{{payment_status_block}}",
    "",
    "{{hotel_information}}",
    "",
    "---",
    "",
    "Questions? Contact {{contact_email}}.",
  ].join("\n"),
  REGISTRATION_CONFIRMATION_ORGANIZATION_BILLED: [
    "# We received your registration for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "Your registration is recorded. This event bills the responsible organization directly — do not send payment yourself.",
    "",
    "### Your registration",
    "",
    "- **Confirmation code:** {{confirmation_code}}",
    "- **Dates:** {{event_dates}}",
    "- **Location:** {{event_location}}",
    "",
    "{{attendee_summary}}",
    "",
    "**[View or update this registration]({{portal_url}})**",
    "",
    "{{payment_status_block}}",
    "",
    "{{hotel_information}}",
    "",
    "---",
    "",
    "Questions? Contact {{contact_email}}.",
  ].join("\n"),
  WORKER_CONFIRMATION: [
    "# Worker registration received for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "Thank you for serving at this event.",
    "",
    "### Your registration",
    "",
    "- **Confirmation code:** {{confirmation_code}}",
    "- **Dates:** {{event_dates}}",
    "- **Location:** {{event_location}}",
    "",
    "{{attendee_summary}}",
    "",
    "**[View or edit your registration]({{portal_url}})**",
    "",
    "{{payment_status_block}}",
    "",
    "{{hotel_information}}",
    "",
    "{{checkin_block}}",
    "",
    "---",
    "",
    "Questions? Contact {{contact_email}}.",
  ].join("\n"),
  INTERNAL_NEW_REGISTRATION: [
    "# New registration for {{event_name}}",
    "",
    "- **Registrant:** {{registrant_name}}",
    "- **Confirmation code:** {{confirmation_code}}",
    "- **Total:** {{total_amount}}",
    "- **Balance due:** {{balance_amount}}",
    "",
    "{{attendee_summary}}",
    "",
    "**[Open the registration]({{portal_url}})**",
    "",
    "---",
    "",
    "Configured reply-to: {{reply_to_email}}",
  ].join("\n"),
  WAITLIST_JOINED: [
    "# You're on the waitlist for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "### Your registration",
    "",
    "- **Confirmation code:** {{confirmation_code}}",
    "- **Dates:** {{event_dates}}",
    "- **Location:** {{event_location}}",
    "",
    "{{payment_status_block}}",
    "",
    "**[Review your registration]({{portal_url}})**",
    "",
    "---",
    "",
    "Questions? Contact {{contact_email}}.",
  ].join("\n"),
  WAITLIST_PROMOTED: [
    "# A place is available for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "Confirmation code: **{{confirmation_code}}**",
    "",
    "{{payment_status_block}}",
    "",
    "**[View, pay, or edit your registration]({{portal_url}})**",
    "",
    "{{hotel_information}}",
    "",
    "---",
    "",
    "Questions? Contact {{contact_email}}.",
  ].join("\n"),
  REGISTRATION_CANCELLED: [
    "# Registration cancelled for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "Registration **{{confirmation_code}}** has been cancelled. Your registration total and payment and refund history remain on record.",
    "",
    "{{payment_status_block}}",
    "",
    "**[Review the cancelled registration]({{portal_url}})**",
    "",
    "---",
    "",
    "Questions? Contact {{contact_email}}.",
  ].join("\n"),
  REGISTRATION_CONTACT_UPDATED: [
    "# Contact details updated for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "The contact details for registration **{{confirmation_code}}** were updated.",
    "",
    "Future registration messages will be sent to {{registration_contact_email}}.",
    "",
    "**[Review your registration]({{portal_url}})**",
    "",
    "---",
    "",
    "If you did not make this change, contact {{contact_email}}.",
  ].join("\n"),
  REGISTRATION_UPDATED: [
    "# Registration updated for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "Registration **{{confirmation_code}}** was updated successfully.",
    "",
    "- **Change category:** {{change_category}}",
    "",
    "{{seminar_preferences}}",
    "",
    "For your privacy, this confirmation does not include submitted answer values.",
    "",
    "**[Review your registration]({{portal_url}})**",
    "",
    "---",
    "",
    "Questions? Contact {{contact_email}}.",
  ].join("\n"),
  PAYMENT_RECEIPT: [
    "# Payment received for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "Thank you — we received your payment.",
    "",
    "- **Confirmation code:** {{confirmation_code}}",
    "- **Payment received:** {{payment_amount}}",
    "- **Payment reference:** {{payment_reference}}",
    "",
    "{{payment_status_block}}",
    "",
    "**[Review your registration and payment history]({{portal_url}})**",
    "",
    "---",
    "",
    "Questions? Contact {{contact_email}}.",
  ].join("\n"),
  BALANCE_REMINDER: [
    "# A balance remains for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "Registration **{{confirmation_code}}** still has a balance.",
    "",
    "- **Registration total:** {{total_amount}}",
    "- **Balance due:** {{balance_amount}}",
    "",
    "**[View, pay, or edit your registration]({{portal_url}})**",
    "",
    "{{hotel_information}}",
    "",
    "---",
    "",
    "If you recently made a payment, it may still be processing. Questions? Contact {{contact_email}}.",
  ].join("\n"),
  REGISTRATION_TRANSFERRED_NEW_CONTACT: [
    "# Registration transferred to you for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "Staff transferred registration **{{confirmation_code}}** to you.",
    "",
    "Future registration messages will be sent to {{registration_contact_email}}. The confirmation code, status, attendee party, submitted form and order snapshot, total, payments and refunds, promo redemption, capacity reservations, and waitlist position did not change.",
    "",
    "A new private link was created for this destination after the transfer committed. Prior private links no longer work.",
    "",
    "**[Manage the registration]({{portal_url}})**",
    "",
    "---",
    "",
    "Questions? Contact {{contact_email}}.",
  ].join("\n"),
  REGISTRATION_TRANSFERRED_PRIOR_CONTACT: [
    "# Registration contact transferred for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "Staff transferred registration **{{confirmation_code}}** to {{new_person_name}}. You are no longer the registration contact, and prior private management links no longer work.",
    "",
    "The confirmation code, status, attendee party, submitted form and order snapshot, total, payments and refunds, promo redemption, capacity reservations, and waitlist position did not change.",
    "",
    "---",
    "",
    "If this was unexpected, contact {{contact_email}}.",
  ].join("\n"),
  ATTENDEE_SUBSTITUTED: [
    "# Attendee substitution recorded for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "Staff updated registration **{{confirmation_code}}**: {{prior_person_name}} was replaced by {{new_person_name}}.",
    "",
    "The attendee record, position, type, submitted choices, capacity reservations, and pricing did not change. The registration contact, status, total, payments and refunds, promo redemption, and waitlist position also remain unchanged.",
    "",
    "---",
    "",
    "Questions? Contact {{contact_email}}.",
  ].join("\n"),
  SHIRT_SIZE_REQUEST: [
    "# We still need a shirt size for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "Registration **{{confirmation_code}}** is missing a shirt size for:",
    "",
    "{{attendee_summary}}",
    "",
    "Open your private registration page to choose a size for each attendee. The same page shows your balance and lets you update your contact details.",
    "",
    "**[Choose shirt sizes]({{portal_url}})**",
    "",
    "This link is private to your registration. Please do not forward it.",
    "",
    "---",
    "",
    "Questions? Contact {{contact_email}}.",
  ].join("\n"),
  REGISTRATION_ACCESS_RECOVERY: [
    "# Your private registration link for {{event_name}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "Someone requested a new private management link for registration **{{confirmation_code}}**.",
    "",
    "**[Open your registration]({{portal_url}})**",
    "",
    "This link expires and is private to your registration. Please do not forward it.",
    "",
    "If you did not request this link, no registration details were changed and you can ignore this message.",
    "",
    "---",
    "",
    "Questions? Contact {{contact_email}}.",
  ].join("\n"),
  EVENT_ANNOUNCEMENT: [
    "# {{announcement_title}}",
    "",
    "Hello {{recipient_name}},",
    "",
    "{{announcement_body}}",
    "",
    "**[Review your registration and attendee information]({{portal_url}})**",
    "",
    "{{hotel_information}}",
    "",
    "---",
    "",
    "Questions? Contact {{contact_email}}.",
  ].join("\n"),
};

export const DEFAULT_MESSAGE_TEMPLATES: Readonly<
  Record<MessageTemplateKey, MessageTemplateDefinition>
> = Object.fromEntries(
  MESSAGE_TEMPLATE_KEYS.map((key) => [
    key,
    Object.freeze({
      key,
      name: DEFAULT_MESSAGE_TEMPLATE_NAMES[key],
      description: DEFAULT_MESSAGE_TEMPLATE_DESCRIPTIONS[key],
      subject: DEFAULT_MESSAGE_TEMPLATE_SUBJECTS[key],
      body: DEFAULT_MESSAGE_TEMPLATE_BODIES[key],
    }),
  ]),
) as Record<MessageTemplateKey, MessageTemplateDefinition>;

export const DEFAULT_MESSAGE_TEMPLATE_LIST: readonly MessageTemplateDefinition[] =
  MESSAGE_TEMPLATE_KEYS.map((key) => DEFAULT_MESSAGE_TEMPLATES[key]);

export const MESSAGE_TEMPLATE_TOKEN_OPTIONS: readonly {
  key: MessageTemplateToken;
  label: string;
  description: string;
}[] = [
  {
    key: "recipient_name",
    label: "Recipient name",
    description: "The person receiving this specific message.",
  },
  {
    key: "registrant_name",
    label: "Registrant name",
    description: "The primary name attached to the registration.",
  },
  {
    key: "event_name",
    label: "Event name",
    description: "The public name of the event.",
  },
  {
    key: "event_dates",
    label: "Event dates",
    description: "The event start and end dates formatted for display.",
  },
  {
    key: "event_location",
    label: "Event location",
    description: "The event venue or location text.",
  },
  {
    key: "confirmation_code",
    label: "Confirmation code",
    description: "The registration's unique confirmation code.",
  },
  {
    key: "attendee_summary",
    label: "Attendee summary",
    description: "A plain-text summary of the people and selections on the registration.",
  },
  {
    key: "total_amount",
    label: "Total amount",
    description: "The registration total formatted as currency.",
  },
  {
    key: "balance_amount",
    label: "Balance amount",
    description: "The remaining registration balance formatted as currency.",
  },
  {
    key: "payment_instructions",
    label: "Payment instructions",
    description: "The event's next-step or pay-later instructions.",
  },
  {
    key: "portal_url",
    label: "Registration link",
    description: "A secure link for reviewing or managing the registration.",
  },
  {
    key: "reply_to_email",
    label: "Reply-to email",
    description: "The reply-to address configured in this event's message settings.",
  },
  {
    key: "waitlist_position",
    label: "Waitlist position",
    description: "The registration's current numbered place on the waitlist.",
  },
  {
    key: "contact_email",
    label: "Event contact email",
    description: "The event organiser's published contact address, for “questions? contact …”.",
  },
  {
    key: "registration_contact_email",
    label: "Registration contact email",
    description: "The email destination currently saved on the registration itself.",
  },
  {
    key: "change_category",
    label: "Change category",
    description: "The permitted category of registration information that changed.",
  },
  {
    key: "seminar_preferences",
    label: "Seminar preferences",
    description: "Attendee names and resulting seminar labels for a seminar preference update.",
  },
  {
    key: "payment_amount",
    label: "Payment amount",
    description: "The amount received for this specific payment.",
  },
  {
    key: "payment_reference",
    label: "Payment reference",
    description: "The safe provider reference for this payment.",
  },
  {
    key: "prior_person_name",
    label: "Prior person",
    description: "The contact or attendee being replaced by an operation.",
  },
  {
    key: "new_person_name",
    label: "New person",
    description: "The contact or attendee taking over after an operation.",
  },
  {
    key: "announcement_title",
    label: "Announcement title",
    description: "The title of the published event-feed announcement.",
  },
  {
    key: "announcement_body",
    label: "Announcement body",
    description: "The plain-text body of the published event-feed announcement.",
  },
  {
    key: "hotel_information",
    label: "Hotel information",
    description:
      "The event's configured lodging block. Renders nothing when the event has no hotel.",
  },
  {
    key: "payment_status_block",
    label: "Payment status block",
    description:
      "The paid, balance-due, complimentary, waitlisted, or promoted section for this registration's actual state.",
  },
  {
    key: "checkin_block",
    label: "Check-in block",
    description:
      "Check-in instructions with the QR code for a single attendee, or the portal link for a party. Renders nothing when no pass is available.",
  },
  {
    key: "checkin_qr_url",
    label: "Check-in pass link",
    description: "A link to the registrant's own check-in pass, for a custom check-in section.",
  },
  {
    key: "checkin_qr_image",
    label: "Check-in QR image",
    description:
      "The pass QR image, for a single-attendee registration only. A party has one code per attendee, so this renders nothing and the check-in block links to the portal instead.",
  },
];

/**
 * Sample values for the preview and for a test capture with no real
 * registration behind it. One event, one venue, one set of dates, and lodging
 * that belongs to that venue: a preview that mixes an unrelated location into a
 * hotel block teaches staff to distrust the preview.
 *
 * `portal_url` is a syntactically valid, obviously non-live URL. It must stay a
 * bare URL rather than a bracketed note, because a template's portal link is
 * written as `[text]({{portal_url}})` and a note would render as broken markup.
 */
export const SAMPLE_MESSAGE_TEMPLATE_CONTEXT: Readonly<
  Required<{ [Token in MessageTemplateToken]: string }>
> = Object.freeze({
  recipient_name: "Avery Johnson",
  registrant_name: "Avery Johnson",
  event_name: "IMSDA Women's Retreat 2026",
  event_dates: "October 9 – 11, 2026",
  event_location: "Des Moines, Iowa",
  confirmation_code: "REG-DEMO123",
  // Plain lines on purpose. This token is assembled from registrant names and
  // submitted answers, so it is Markdown-escaped before it reaches the
  // formatted body; sample data that pretended otherwise would show staff
  // formatting the real thing can never produce.
  attendee_summary: "Attendees:\nAvery Johnson — Adult registration",
  total_amount: "$129.05",
  balance_amount: "$0.00",
  payment_instructions: "No additional payment is due.",
  portal_url: "https://events.example.test/manage/sample-preview-link",
  reply_to_email: "registration@example.test",
  waitlist_position: "3",
  contact_email: "registration@example.test",
  registration_contact_email: "avery.johnson@example.test",
  change_category: "Seminar preferences",
  seminar_preferences: "Avery Johnson: Prayer, Service",
  payment_amount: "$129.05",
  payment_reference: "square-demo-reference",
  prior_person_name: "Jordan Lee",
  new_person_name: "Morgan Lee",
  announcement_title: "Friday arrival information",
  announcement_body: "Check-in opens at 3:00 PM in the main lodge.",
  hotel_information: [
    "### Hotel reservations",
    "",
    "A block of rooms is held at **Holiday Inn Des Moines – Airport Conference Center**.",
    "",
    "- Reserve online: [Book your room](https://events.example.test/sample-hotel-booking)",
    "- By phone: (515) 287-2400",
    "- Ask for the group: IMSDA Women's Retreat",
    "- Group rate: $120 per night plus tax",
    "",
    "Pro tip: share a room with a friend and split the cost.",
  ].join("\n"),
  payment_status_block: [
    "### Payment status",
    "",
    "**Paid in full — thank you.** We received $129.05 against a registration total of $129.05. No balance remains.",
  ].join("\n"),
  checkin_block: [
    "### At check-in",
    "",
    "Open your registration to show your check-in QR code at the desk:",
    "",
    "[Show my check-in pass](https://events.example.test/manage/sample-preview-link)",
    "",
    "If you cannot open the code, give your confirmation code **REG-DEMO123** at the desk instead.",
  ].join("\n"),
  checkin_qr_url: "https://events.example.test/manage/sample-preview-link",
  checkin_qr_image: "https://events.example.test/manage/sample-preview-link/qr.png",
});

const templateTokenPattern = /\{\{([^{}]+)\}\}/g;
const subjectLineBreakPattern = /[\r\n]/;

function uniqueInOrder<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function formatMessageTemplateToken(token: MessageTemplateToken) {
  return `{{${token}}}`;
}

export function extractMessageTemplateTokens(value: string) {
  const tokens: string[] = [];
  for (const match of value.matchAll(templateTokenPattern)) {
    tokens.push(match[1].trim());
  }
  return uniqueInOrder(tokens);
}

export type MessageTemplateValidationIssue = {
  field: "subject" | "body";
  code: "REQUIRED" | "SUBJECT_LINE_BREAK" | "UNKNOWN_TOKEN";
  message: string;
  token?: string;
};

export type MessageTemplateValidationResult = {
  isValid: boolean;
  issues: MessageTemplateValidationIssue[];
  unknownTokens: string[];
};

export function validateMessageTemplate(input: {
  subject: string;
  body: string;
}): MessageTemplateValidationResult {
  const issues: MessageTemplateValidationIssue[] = [];
  const unknownTokens: string[] = [];

  if (!input.subject.trim()) {
    issues.push({
      field: "subject",
      code: "REQUIRED",
      message: "Enter a subject.",
    });
  }

  if (subjectLineBreakPattern.test(input.subject)) {
    issues.push({
      field: "subject",
      code: "SUBJECT_LINE_BREAK",
      message: "The subject must stay on one line.",
    });
  }

  if (!input.body.trim()) {
    issues.push({
      field: "body",
      code: "REQUIRED",
      message: "Enter a message body.",
    });
  }

  for (const field of ["subject", "body"] as const) {
    for (const token of extractMessageTemplateTokens(input[field])) {
      if (!ALLOWED_MESSAGE_TEMPLATE_TOKENS.has(token as MessageTemplateToken)) {
        unknownTokens.push(token);
        issues.push({
          field,
          code: "UNKNOWN_TOKEN",
          message: `{{${token}}} is not an allowed message token.`,
          token,
        });
      }
    }
  }

  return {
    isValid: issues.length === 0,
    issues,
    unknownTokens: uniqueInOrder(unknownTokens),
  };
}

export type RenderedTemplateText = {
  text: string;
  missingTokens: MessageTemplateToken[];
  unresolvedTokens: string[];
};

export type RenderTemplateTextOptions = {
  /**
   * Markdown-escape every value except the trusted block and URL tokens, for
   * the source the HTML renderer reads. The plain-text body renders without
   * this, so a reader of the text part never sees a backslash.
   */
  escapeUntrustedMarkdown?: boolean;
};

export function renderTemplateText(
  template: string,
  context: MessageTemplateContext,
  options: RenderTemplateTextOptions = {},
): RenderedTemplateText {
  const missingTokens: MessageTemplateToken[] = [];
  const unresolvedTokens: string[] = [];

  const text = template.replace(templateTokenPattern, (placeholder, rawToken: string) => {
    const token = rawToken.trim();
    if (!ALLOWED_MESSAGE_TEMPLATE_TOKENS.has(token as MessageTemplateToken)) {
      unresolvedTokens.push(token);
      return placeholder;
    }

    const knownToken = token as MessageTemplateToken;
    const value = context[knownToken];
    if (value === null || value === undefined || value.trim() === "") {
      // An optional token is allowed to have nothing to say. Leaving the
      // placeholder in the body would print `{{hotel_information}}` to a
      // registrant of an event that books no hotel, and stop the send besides.
      if (OPTIONAL_MESSAGE_TEMPLATE_TOKENS.has(knownToken)) return "";
      missingTokens.push(knownToken);
      unresolvedTokens.push(knownToken);
      return placeholder;
    }

    // The callback return is inserted literally. Values containing "$&" or
    // another {{token}} are never interpreted as replacement syntax or rendered twice.
    return options.escapeUntrustedMarkdown
      && !MARKDOWN_MESSAGE_TEMPLATE_TOKENS.has(knownToken)
      ? escapeMarkdown(value)
      : value;
  });

  return {
    text,
    missingTokens: uniqueInOrder(missingTokens),
    unresolvedTokens: uniqueInOrder(unresolvedTokens),
  };
}

export type RenderedMessageTemplate = {
  subject: string;
  body: string;
  /**
   * The formatted body, rendered from the same template and context as `body`
   * in the same call. Rendering both together is what keeps the two parts of an
   * email from drifting; it also means the HTML can escape untrusted token
   * values as Markdown without those escapes leaking into the text part.
   */
  bodyHtml: string;
  isComplete: boolean;
  missingTokens: MessageTemplateToken[];
  unresolvedTokens: string[];
};

/**
 * An omitted optional block leaves the blank lines that surrounded its token.
 * Collapsing runs of three or more newlines restores the one-blank-line spacing
 * the template was written with, in the text body and in what the HTML renderer
 * reads, without touching a body that has no omitted blocks.
 */
export function collapseBlankLines(value: string) {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

export function renderMessageTemplate(
  template: Pick<MessageTemplateDefinition, "subject" | "body">,
  context: MessageTemplateContext,
): RenderedMessageTemplate {
  const subject = renderTemplateText(template.subject, context);
  const body = renderTemplateText(template.body, context);
  const missingTokens = uniqueInOrder([...subject.missingTokens, ...body.missingTokens]);
  const unresolvedTokens = uniqueInOrder([
    ...subject.unresolvedTokens,
    ...body.unresolvedTokens,
  ]);

  const htmlSource = renderTemplateText(template.body, context, {
    escapeUntrustedMarkdown: true,
  });

  return {
    subject: subject.text,
    body: collapseBlankLines(body.text),
    bodyHtml: renderEmailBodyHtml(collapseBlankLines(htmlSource.text)),
    isComplete: unresolvedTokens.length === 0,
    missingTokens,
    unresolvedTokens,
  };
}

export function selectRegistrationMessageTemplate(input: {
  isWorker: boolean;
  balanceCents: number;
  isDeferredOrganizationBilling?: boolean;
}): MessageTemplateKey {
  // A deferred-organization event never creates an attendee balance, so its
  // whole payment framing differs regardless of worker status.
  if (input.isDeferredOrganizationBilling) return "REGISTRATION_CONFIRMATION_ORGANIZATION_BILLED";
  if (input.isWorker) return "WORKER_CONFIRMATION";
  return input.balanceCents > 0
    ? "REGISTRATION_CONFIRMATION_UNPAID"
    : "REGISTRATION_CONFIRMATION_PAID";
}

export function formatMessageMoney(
  amountCents: number,
  options: { locale?: string; currency?: string } = {},
) {
  const { locale = "en-US", currency = "USD" } = options;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(amountCents / 100);
}

type MessageDateValue = Date | string | number | null | undefined;

function parseMessageDate(value: MessageDateValue) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatMessageDateRange(
  start: MessageDateValue,
  end?: MessageDateValue,
  options: {
    locale?: string;
    timeZone?: string;
    fallback?: string;
  } = {},
) {
  const { locale = "en-US", timeZone, fallback = "Dates to be announced" } = options;
  const startDate = parseMessageDate(start);
  const endDate = parseMessageDate(end);
  if (!startDate) return fallback;

  const fullDate = new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  });
  if (!endDate || startDate.getTime() === endDate.getTime()) return fullDate.format(startDate);

  const rangeFormatter = new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  });
  return rangeFormatter.formatRange(startDate, endDate);
}
