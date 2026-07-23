export const MESSAGE_TEMPLATE_KEYS = [
  "REGISTRATION_CONFIRMATION_PAID",
  "REGISTRATION_CONFIRMATION_UNPAID",
  "WORKER_CONFIRMATION",
  "INTERNAL_NEW_REGISTRATION",
  "WAITLIST_JOINED",
  "WAITLIST_PROMOTED",
  "REGISTRATION_CANCELLED",
  "REGISTRATION_CONTACT_UPDATED",
  "PAYMENT_RECEIPT",
  "BALANCE_REMINDER",
  "REGISTRATION_TRANSFERRED_NEW_CONTACT",
  "REGISTRATION_TRANSFERRED_PRIOR_CONTACT",
  "ATTENDEE_SUBSTITUTED",
] as const;

export type MessageTemplateKey = (typeof MESSAGE_TEMPLATE_KEYS)[number];

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
  "payment_amount",
  "payment_reference",
  "prior_person_name",
  "new_person_name",
] as const;

export type MessageTemplateToken = (typeof MESSAGE_TEMPLATE_TOKEN_KEYS)[number];

export const ALLOWED_MESSAGE_TEMPLATE_TOKENS: ReadonlySet<MessageTemplateToken> = new Set(
  MESSAGE_TEMPLATE_TOKEN_KEYS,
);

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
  WORKER_CONFIRMATION: "Worker registration confirmation",
  INTERNAL_NEW_REGISTRATION: "Internal new registration notice",
  WAITLIST_JOINED: "Waitlist joined confirmation",
  WAITLIST_PROMOTED: "Waitlist promotion confirmation",
  REGISTRATION_CANCELLED: "Registration cancellation",
  REGISTRATION_CONTACT_UPDATED: "Registration contact updated",
  PAYMENT_RECEIPT: "Payment receipt",
  BALANCE_REMINDER: "Balance reminder",
  REGISTRATION_TRANSFERRED_NEW_CONTACT: "Transfer notice for new contact",
  REGISTRATION_TRANSFERRED_PRIOR_CONTACT: "Transfer notice for prior contact",
  ATTENDEE_SUBSTITUTED: "Attendee substitution notice",
};

export const DEFAULT_MESSAGE_TEMPLATE_DESCRIPTIONS: Readonly<
  Record<MessageTemplateKey, string>
> = {
  REGISTRATION_CONFIRMATION_PAID:
    "Sent to a registrant whose recorded balance is paid in full.",
  REGISTRATION_CONFIRMATION_UNPAID:
    "Sent to a registrant who still has a balance or payment step to complete.",
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
};

export const DEFAULT_MESSAGE_TEMPLATE_SUBJECTS: Readonly<
  Record<MessageTemplateKey, string>
> = {
  REGISTRATION_CONFIRMATION_PAID:
    "Registration confirmed: {{event_name}} ({{confirmation_code}})",
  REGISTRATION_CONFIRMATION_UNPAID:
    "Registration received — balance due for {{event_name}}",
  WORKER_CONFIRMATION: "Worker registration received: {{event_name}}",
  INTERNAL_NEW_REGISTRATION:
    "New registration: {{event_name}} — {{confirmation_code}}",
  WAITLIST_JOINED:
    "Waitlist confirmation: {{event_name}} ({{confirmation_code}})",
  WAITLIST_PROMOTED: "A place is available: {{event_name}}",
  REGISTRATION_CANCELLED: "Registration cancelled: {{event_name}}",
  REGISTRATION_CONTACT_UPDATED: "Contact details updated: {{event_name}}",
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
};

export const DEFAULT_MESSAGE_TEMPLATE_BODIES: Readonly<Record<MessageTemplateKey, string>> = {
  REGISTRATION_CONFIRMATION_PAID: [
    "Hello {{recipient_name}},",
    "",
    "Your registration for {{event_name}} is confirmed and paid in full.",
    "",
    "Confirmation code: {{confirmation_code}}",
    "Dates: {{event_dates}}",
    "Location: {{event_location}}",
    "",
    "Registration:",
    "{{attendee_summary}}",
    "",
    "Total: {{total_amount}}",
    "Balance due: {{balance_amount}}",
    "",
    "Manage your registration:",
    "{{portal_url}}",
    "",
    "Questions? Contact {{reply_to_email}}.",
    "",
    "Please keep this message for your records.",
  ].join("\n"),
  REGISTRATION_CONFIRMATION_UNPAID: [
    "Hello {{recipient_name}},",
    "",
    "We received your registration for {{event_name}}.",
    "",
    "Confirmation code: {{confirmation_code}}",
    "Dates: {{event_dates}}",
    "Location: {{event_location}}",
    "",
    "Registration:",
    "{{attendee_summary}}",
    "",
    "Total: {{total_amount}}",
    "Balance due: {{balance_amount}}",
    "",
    "Payment instructions:",
    "{{payment_instructions}}",
    "",
    "Review your registration or continue payment:",
    "{{portal_url}}",
    "",
    "Questions? Contact {{reply_to_email}}.",
  ].join("\n"),
  WORKER_CONFIRMATION: [
    "Hello {{recipient_name}},",
    "",
    "We received your worker registration for {{event_name}}.",
    "",
    "Confirmation code: {{confirmation_code}}",
    "Dates: {{event_dates}}",
    "Location: {{event_location}}",
    "",
    "Registration:",
    "{{attendee_summary}}",
    "",
    "Total: {{total_amount}}",
    "Balance due: {{balance_amount}}",
    "",
    "Next steps:",
    "{{payment_instructions}}",
    "",
    "Review your registration:",
    "{{portal_url}}",
    "",
    "Questions? Contact {{reply_to_email}}.",
  ].join("\n"),
  INTERNAL_NEW_REGISTRATION: [
    "A new registration was submitted for {{event_name}}.",
    "",
    "Registrant: {{registrant_name}}",
    "Confirmation code: {{confirmation_code}}",
    "Total: {{total_amount}}",
    "Balance due: {{balance_amount}}",
    "",
    "Registration:",
    "{{attendee_summary}}",
    "",
    "Open the registration:",
    "{{portal_url}}",
    "",
    "Configured reply-to: {{reply_to_email}}",
  ].join("\n"),
  WAITLIST_JOINED: [
    "Hello {{recipient_name}},",
    "",
    "Your registration is on the waitlist for {{event_name}}.",
    "",
    "Confirmation code: {{confirmation_code}}",
    "Waitlist position: {{waitlist_position}}",
    "Dates: {{event_dates}}",
    "Location: {{event_location}}",
    "",
    "No payment is due while you are on the waitlist. Please do not submit payment unless we confirm that a place is available.",
    "",
    "Review your registration:",
    "{{portal_url}}",
    "",
    "Questions? Contact {{reply_to_email}}.",
  ].join("\n"),
  WAITLIST_PROMOTED: [
    "Hello {{recipient_name}},",
    "",
    "A place is now available for your registration for {{event_name}}.",
    "",
    "Confirmation code: {{confirmation_code}}",
    "Balance due: {{balance_amount}}",
    "",
    "Next payment step:",
    "{{payment_instructions}}",
    "",
    "Review your registration or continue payment:",
    "{{portal_url}}",
    "",
    "Questions? Contact {{reply_to_email}}.",
  ].join("\n"),
  REGISTRATION_CANCELLED: [
    "Hello {{recipient_name}},",
    "",
    "Your registration for {{event_name}} has been cancelled.",
    "",
    "Confirmation code: {{confirmation_code}}",
    "",
    "Payment and refund information:",
    "{{payment_instructions}}",
    "",
    "Your registration total and payment/refund history remain on record.",
    "",
    "Review the cancelled registration:",
    "{{portal_url}}",
    "",
    "Questions? Contact {{reply_to_email}}.",
  ].join("\n"),
  REGISTRATION_CONTACT_UPDATED: [
    "Hello {{recipient_name}},",
    "",
    "The contact details for registration {{confirmation_code}} at {{event_name}} were updated.",
    "",
    "Future registration messages will be sent to {{contact_email}}.",
    "",
    "Review your registration:",
    "{{portal_url}}",
    "",
    "If you did not make this change, contact {{reply_to_email}}.",
  ].join("\n"),
  PAYMENT_RECEIPT: [
    "Hello {{recipient_name}},",
    "",
    "We received your payment for {{event_name}}.",
    "",
    "Confirmation code: {{confirmation_code}}",
    "Payment received: {{payment_amount}}",
    "Payment reference: {{payment_reference}}",
    "Registration total: {{total_amount}}",
    "Balance due: {{balance_amount}}",
    "",
    "Review your registration and payment history:",
    "{{portal_url}}",
    "",
    "Questions? Contact {{reply_to_email}}.",
  ].join("\n"),
  BALANCE_REMINDER: [
    "Hello {{recipient_name}},",
    "",
    "This is a reminder that registration {{confirmation_code}} for {{event_name}} has a balance remaining.",
    "",
    "Registration total: {{total_amount}}",
    "Balance due: {{balance_amount}}",
    "",
    "Review your registration or continue payment:",
    "{{portal_url}}",
    "",
    "If you recently made a payment, it may still be processing. Questions? Contact {{reply_to_email}}.",
  ].join("\n"),
  REGISTRATION_TRANSFERRED_NEW_CONTACT: [
    "Hello {{recipient_name}},",
    "",
    "Staff transferred registration {{confirmation_code}} for {{event_name}} to you.",
    "",
    "Future registration messages will be sent to {{contact_email}}. The confirmation code, status, attendee party, submitted form and order snapshot, total, payments and refunds, promo redemption, capacity reservations, and waitlist position did not change.",
    "",
    "A new private link was created for this destination after the transfer committed. Prior private links no longer work.",
    "",
    "Manage the registration:",
    "{{portal_url}}",
    "",
    "Questions? Contact {{reply_to_email}}.",
  ].join("\n"),
  REGISTRATION_TRANSFERRED_PRIOR_CONTACT: [
    "Hello {{recipient_name}},",
    "",
    "Staff transferred registration {{confirmation_code}} for {{event_name}} to {{new_person_name}}. You are no longer the registration contact, and prior private management links no longer work.",
    "",
    "The confirmation code, status, attendee party, submitted form and order snapshot, total, payments and refunds, promo redemption, capacity reservations, and waitlist position did not change.",
    "",
    "If this was unexpected, contact {{reply_to_email}}.",
  ].join("\n"),
  ATTENDEE_SUBSTITUTED: [
    "Hello {{recipient_name}},",
    "",
    "Staff updated registration {{confirmation_code}} for {{event_name}}: {{prior_person_name}} was replaced by {{new_person_name}}.",
    "",
    "The attendee record, position, type, submitted choices, capacity reservations, and pricing did not change. The registration contact, status, total, payments and refunds, promo redemption, and waitlist position also remain unchanged.",
    "",
    "Questions? Contact {{reply_to_email}}.",
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
    description: "The event's configured contact email address.",
  },
  {
    key: "waitlist_position",
    label: "Waitlist position",
    description: "The registration's current numbered place on the waitlist.",
  },
  {
    key: "contact_email",
    label: "Contact email",
    description: "The new email destination saved on the registration.",
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
];

export const SAMPLE_MESSAGE_TEMPLATE_CONTEXT: Readonly<
  Required<{ [Token in MessageTemplateToken]: string }>
> = Object.freeze({
  recipient_name: "Avery Johnson",
  registrant_name: "Avery Johnson",
  event_name: "IMSDA Women's Retreat 2026",
  event_dates: "September 25–27, 2026",
  event_location: "Camp Heritage",
  confirmation_code: "REG-DEMO123",
  attendee_summary: "Avery Johnson — Adult registration",
  total_amount: "$129.05",
  balance_amount: "$0.00",
  payment_instructions: "No additional payment is due.",
  portal_url: "https://events.example.test/registrations/REG-DEMO123",
  reply_to_email: "registration@example.test",
  waitlist_position: "3",
  contact_email: "avery.johnson@example.test",
  payment_amount: "$129.05",
  payment_reference: "square-demo-reference",
  prior_person_name: "Jordan Lee",
  new_person_name: "Morgan Lee",
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

export function renderTemplateText(
  template: string,
  context: MessageTemplateContext,
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
      missingTokens.push(knownToken);
      unresolvedTokens.push(knownToken);
      return placeholder;
    }

    // The callback return is inserted literally. Values containing "$&" or
    // another {{token}} are never interpreted as replacement syntax or rendered twice.
    return value;
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
  isComplete: boolean;
  missingTokens: MessageTemplateToken[];
  unresolvedTokens: string[];
};

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

  return {
    subject: subject.text,
    body: body.text,
    isComplete: unresolvedTokens.length === 0,
    missingTokens,
    unresolvedTokens,
  };
}

export function selectRegistrationMessageTemplate(input: {
  isWorker: boolean;
  balanceCents: number;
}): MessageTemplateKey {
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
