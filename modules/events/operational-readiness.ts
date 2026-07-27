/**
 * Answers one question: what still stops this event from running for real?
 *
 * Distinct from `getEventPublishReadiness`, which asks whether the event is
 * *described* well enough to publish — name, location, info page, support
 * contact. This asks whether the machinery behind it actually works.
 *
 * The failure this exists to catch is quiet. An event can look complete in the
 * workspace — registrations imported, templates published, form built — while
 * messages capture to a local table instead of sending, the sender is a
 * placeholder domain nobody receives, and Square holds no credentials. Nothing
 * errors. The first symptom is a registrant who never got their confirmation.
 *
 * Facts are gathered by the caller so this stays pure: the same check runs in a
 * script, a route, or a test without a database.
 */

export type OperationalReadinessSeverity = "BLOCKER" | "WARNING" | "READY";

export type OperationalReadinessCheck = {
  code: string;
  label: string;
  severity: OperationalReadinessSeverity;
  detail: string;
};

export type OperationalReadinessFacts = {
  isPublished: boolean;
  hasPublishedFormVersion: boolean;
  messaging: {
    deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
    senderEmail: string | null;
    replyToEmail: string | null;
  } | null;
  templates: Array<{ key: string; isEnabled: boolean; hasPublishedVersion: boolean }>;
  requiredTemplateKeys: string[];
  square: {
    paymentConfigured: boolean;
    webhookConfigured: boolean;
    environment: string;
  };
  registrationsMissingShirtSize: number;
  registrationsWithBalanceDue: number;
};

/**
 * Reserved TLDs and the seeded placeholder hosts. A sender on one of these is a
 * default nobody changed, not a mailbox: mail from it cannot authenticate and
 * mail to it cannot be delivered.
 */
const UNDELIVERABLE_SENDER_PATTERN =
  /@(?:[^@\s]*\.)?(?:example\.(?:com|org|net)|test|example|invalid|localhost)$/i;

export function isUndeliverableSenderAddress(email: string | null | undefined) {
  return Boolean(email && UNDELIVERABLE_SENDER_PATTERN.test(email.trim()));
}

function addressCheck(
  role: "SENDER" | "REPLY_TO",
  label: string,
  address: string | null,
): OperationalReadinessCheck {
  if (!address) {
    return {
      code: `${role}_ADDRESS`,
      label: `${label} address is not set`,
      severity: role === "SENDER" ? "BLOCKER" : "WARNING",
      detail: `No ${label.toLowerCase()} address is configured for this event.`,
    };
  }
  if (isUndeliverableSenderAddress(address)) {
    return {
      code: `${role}_ADDRESS`,
      label: `${label} address is a placeholder`,
      severity: "BLOCKER",
      detail: `${address} uses a reserved domain that cannot send or receive real mail. Replace it with an IMSDA address on a domain you control.`,
    };
  }
  return {
    code: `${role}_ADDRESS`,
    label: `${label} address is set`,
    severity: "READY",
    detail: address,
  };
}

export function checkOperationalReadiness(
  facts: OperationalReadinessFacts,
): OperationalReadinessCheck[] {
  const checks: OperationalReadinessCheck[] = [];

  checks.push(facts.isPublished
    ? { code: "EVENT_PUBLISHED", label: "Event is published", severity: "READY", detail: "Public landing, registration, and embed routes are live." }
    : { code: "EVENT_PUBLISHED", label: "Event is not published", severity: "BLOCKER", detail: "Public landing, registration, and embed routes stay inactive until the event is published." });

  checks.push(facts.hasPublishedFormVersion
    ? { code: "FORM_PUBLISHED", label: "Registration form is published", severity: "READY", detail: "Imported and submitted attendee answers are viewable." }
    : { code: "FORM_PUBLISHED", label: "No published registration form version", severity: "BLOCKER", detail: "Without one, imported attendee answers — meals, shirt sizes, ranked seminar choices — are stored but never rendered, and a new public submission has no form version to bind to." });

  if (!facts.messaging) {
    checks.push({ code: "MESSAGE_SETTINGS", label: "No message settings for this event", severity: "BLOCKER", detail: "The event has no sender identity, so no registrant message can be built at all." });
  } else {
    const { deliveryMode, senderEmail, replyToEmail } = facts.messaging;
    checks.push(deliveryMode === "EXTERNAL_EMAIL"
      ? { code: "DELIVERY_MODE", label: "Email delivery is live", severity: "READY", detail: "Messages are handed to the external provider." }
      : {
          code: "DELIVERY_MODE",
          label: `Email delivery is ${deliveryMode === "DISABLED" ? "disabled" : "capturing locally"}`,
          severity: "BLOCKER",
          detail: deliveryMode === "DISABLED"
            ? "Messages are not queued for delivery at all."
            : "Messages are written to the local capture table and never reach a registrant. Confirmations, balance reminders, and shirt-size requests all report success while going nowhere.",
        });
    checks.push(addressCheck("SENDER", "Sender", senderEmail));
    checks.push(addressCheck("REPLY_TO", "Reply-to", replyToEmail));
  }

  const byKey = new Map(facts.templates.map((template) => [template.key, template]));
  const unusable = facts.requiredTemplateKeys.filter((key) => {
    const template = byKey.get(key);
    return !template || !template.isEnabled || !template.hasPublishedVersion;
  });
  checks.push(unusable.length === 0
    ? { code: "TEMPLATES", label: "Required message templates are ready", severity: "READY", detail: `${facts.requiredTemplateKeys.length} template${facts.requiredTemplateKeys.length === 1 ? " is" : "s are"} enabled with a published version.` }
    : { code: "TEMPLATES", label: `${unusable.length} required template${unusable.length === 1 ? "" : "s"} unusable`, severity: "BLOCKER", detail: `Missing, disabled, or with no published version: ${unusable.join(", ")}.` });

  if (facts.square.paymentConfigured && facts.square.webhookConfigured) {
    checks.push({ code: "SQUARE", label: `Square is configured (${facts.square.environment})`, severity: "READY", detail: "Card payments and signature-verified webhooks are both available." });
  } else if (facts.square.paymentConfigured) {
    checks.push({ code: "SQUARE", label: "Square webhook is not configured", severity: "WARNING", detail: "Cards can be taken, but payment and refund webhooks cannot be signature-verified, so a payment that succeeds on Square's side may never post back." });
  } else {
    checks.push({
      code: "SQUARE",
      label: "Square is not configured",
      severity: facts.registrationsWithBalanceDue > 0 ? "BLOCKER" : "WARNING",
      detail: facts.registrationsWithBalanceDue > 0
        ? `${facts.registrationsWithBalanceDue} registration${facts.registrationsWithBalanceDue === 1 ? " has" : "s have"} a balance due and no card path to pay it. Set SQUARE_APPLICATION_ID, SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, and SQUARE_WEBHOOK_SIGNATURE_KEY.`
        : "No card payment can be taken until Square credentials are set.",
    });
  }

  if (facts.registrationsMissingShirtSize > 0) {
    checks.push({
      code: "SHIRT_SIZES",
      label: `${facts.registrationsMissingShirtSize} registration${facts.registrationsMissingShirtSize === 1 ? "" : "s"} missing a shirt size`,
      severity: "WARNING",
      detail: "Review a shirt-size request audience and send the batch. That message also carries each registrant's private management link.",
    });
  }

  return checks;
}

export function operationalReadinessSummary(checks: OperationalReadinessCheck[]) {
  const blockers = checks.filter((check) => check.severity === "BLOCKER").length;
  const warnings = checks.filter((check) => check.severity === "WARNING").length;
  return { blockers, warnings, isReady: blockers === 0 };
}
