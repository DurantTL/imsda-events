"use client";

import { useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BadgePercent,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  LockKeyhole,
  MapPin,
  Plus,
  ShieldCheck,
  Trash2,
  UsersRound,
} from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import {
  calculateFormTotal,
  calculateRosterTotal,
  getAttendeeRosterConfig,
  getAvailabilityMode,
  isFieldVisible,
  isLatePricingActive,
  validateTestResponses,
  type ChoiceUsage,
  type FormCalculation,
  type RegistrationFormDefinition,
  type RegistrationFormField,
} from "@/modules/forms/definition";
import {
  formatPublicRegistrationAnswer,
  getPublicRegistrationStepPlan,
  type PublicRegistrationStep,
  type PublicRegistrationStepId,
} from "@/modules/forms/public-registration-steps";

type ResponseValue = string | boolean | string[];
type FormResponses = Record<string, ResponseValue>;
type FormIssue = {
  key: string;
  message: string;
  fieldId?: string | null;
  path?: string;
  attendeeIndex?: number | null;
};
type RosterAttendee = { clientId: string; responses: FormResponses };
type FieldRenderContext = {
  values: FormResponses;
  visibilityResponses: FormResponses;
  setValue: (key: string, value: ResponseValue) => void;
  idContext: string;
  issuePath: (key: string) => string;
  attendeeIndex: number | null;
  calculation: FormCalculation;
};

type PublicEvent = {
  name: string;
  slug: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  location: string | null;
  capacity: number | null;
};

type PublicForm = {
  slug: string;
  versionId: string;
  versionNumber: number;
  definition: RegistrationFormDefinition;
};

type Confirmation = {
  confirmationCode: string;
  message: string;
  email: string;
  totalCents: number;
  subtotalCents: number;
  preDiscountSubtotalCents: number;
  discountAmountCents: number;
  promoCode: string | null;
  processingFeeCents: number;
  lineItems: Array<{ key: string; label: string; amountCents: number; pricingLabel?: string }>;
  pricingDate: string;
  cardSelected: boolean;
  emailSent: boolean;
  paymentCollected: boolean;
  notificationQueued: boolean;
  notificationStatus: "PENDING" | "CAPTURED" | "SENT" | "FAILED" | "DISABLED";
  managePath: string | null;
  manageLinkExpiresAt: string | null;
  attendeeCount: number;
  attendeeNames: string[];
  registrationStatus: "SUBMITTED" | "WAITLISTED";
  capacityDecision: "REGISTER" | "WAITLIST";
  paymentEligible: boolean;
  waitlistPosition: number | null;
};

type PromoCodeQuote = FormCalculation & {
  preDiscountSubtotalCents: number;
  discountAmountCents: number;
  promoCode: string;
};

export type PublicRegistrationFormProps = {
  event: PublicEvent;
  form: PublicForm;
  choiceUsage: ChoiceUsage;
  pricingDate: string;
  lifecycle: {
    phase: "DRAFT" | "UPCOMING" | "OPEN" | "CLOSED";
    capacityDecision: "REGISTER" | "WAITLIST" | "FULL" | null;
    remainingSpots: number | null;
    waitingRegistrations: number;
  };
};

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function money(cents: number) {
  return moneyFormatter.format(cents / 100);
}

function formatEventDates(startValue: string, endValue: string, timeZone: string) {
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return "Dates to be announced";
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
  return `${formatter.format(start)} – ${formatter.format(end)}`;
}

function formatPricingDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatManageLinkExpiry(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function controlId(field: RegistrationFormField, context = "", optionIndex?: number) {
  const contextPart = context ? `${safeId(context)}_` : "";
  const base = `public_registration_${contextPart}${safeId(field.id)}`;
  return optionIndex === undefined || optionIndex === 0 ? base : `${base}_${optionIndex}`;
}

function initialRoster(minAttendees: number): RosterAttendee[] {
  return Array.from({ length: minAttendees }, (_, index) => ({
    clientId: `initial-attendee-${index + 1}`,
    responses: {},
  }));
}

function attendeeName(attendee: RosterAttendee, index: number, fallback: string) {
  const firstName = typeof attendee.responses.first_name === "string"
    ? attendee.responses.first_name.trim()
    : "";
  const lastName = typeof attendee.responses.last_name === "string"
    ? attendee.responses.last_name.trim()
    : "";
  const splitName = `${firstName} ${lastName}`.trim();
  if (splitName) return splitName;
  for (const key of ["full_name", "name", "attendee_name", "guest_name"]) {
    const value = attendee.responses[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return `${fallback} ${index + 1}`;
}

function hasResponses(responses: FormResponses) {
  return Object.values(responses).some((value) => (
    typeof value === "boolean"
      ? value
      : Array.isArray(value)
        ? value.length > 0
        : value.trim().length > 0
  ));
}

function cloneChoiceUsage(definition: RegistrationFormDefinition, usage: ChoiceUsage): ChoiceUsage {
  const clone: ChoiceUsage = {};
  for (const section of definition.sections) {
    for (const field of section.fields) {
      if (getAvailabilityMode(field) === "NONE") continue;
      clone[field.key] = Object.fromEntries(field.options.map((option) => {
        const stats = usage[field.key]?.[option] ?? { total: 0, first: 0, second: 0 };
        return [option, { ...stats }];
      }));
    }
  }
  return clone;
}

function addResponsesToUsage(
  definition: RegistrationFormDefinition,
  responses: FormResponses,
  usage: ChoiceUsage,
  scope: RegistrationFormField["scope"],
) {
  for (const section of definition.sections) {
    for (const field of section.fields) {
      if (field.scope !== scope || getAvailabilityMode(field) === "NONE" || !isFieldVisible(field, responses)) continue;
      const value = responses[field.key];
      const selections = Array.isArray(value)
        ? value
        : typeof value === "string" && value
          ? [value]
          : [];
      selections.forEach((option, rank) => {
        const stats = usage[field.key]?.[option];
        if (!stats) return;
        stats.total += 1;
        if (rank === 0) stats.first += 1;
        if (rank === 1) stats.second += 1;
      });
    }
  }
}

export function PublicRegistrationForm({
  event,
  form,
  choiceUsage,
  pricingDate,
  lifecycle,
}: PublicRegistrationFormProps) {
  const { definition } = form;
  const joiningWaitlist = lifecycle.capacityDecision === "WAITLIST";
  const roster = useMemo(() => getAttendeeRosterConfig(definition), [definition]);
  const rosterEnabled = roster.enabled;
  const allFields = useMemo(
    () => definition.sections.flatMap((section) => section.fields),
    [definition],
  );
  const [responses, setResponses] = useState<FormResponses>({});
  const [registrationResponses, setRegistrationResponses] = useState<FormResponses>({});
  const [attendees, setAttendees] = useState<RosterAttendee[]>(() => initialRoster(roster.minAttendees));
  const [website, setWebsite] = useState("");
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [error, setError] = useState("");
  const [rosterAnnouncement, setRosterAnnouncement] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [promoCodeQuote, setPromoCodeQuote] = useState<PromoCodeQuote | null>(null);
  const [promoCodeApplying, setPromoCodeApplying] = useState(false);
  const [promoCodeNotice, setPromoCodeNotice] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);

  const issueByPath = useMemo(
    () => new Map(issues.flatMap((issue) => [
      [issue.path ?? issue.key, issue] as const,
      ...(!issue.path ? [] : [[issue.key, issue] as const]),
    ])),
    [issues],
  );
  const baseCalculation = useMemo(
    () => rosterEnabled
      ? calculateRosterTotal(
        definition,
        registrationResponses,
        attendees.map((attendee) => attendee.responses),
        pricingDate,
      )
      : calculateFormTotal(definition, responses, pricingDate),
    [attendees, definition, pricingDate, registrationResponses, responses, rosterEnabled],
  );
  const calculation: FormCalculation | PromoCodeQuote =
    promoCodeQuote ?? baseCalculation;
  const displayedDiscountCents =
    promoCodeQuote?.discountAmountCents ?? 0;
  const displayedPreDiscountSubtotalCents =
    promoCodeQuote?.preDiscountSubtotalCents
    ?? calculation.subtotalCents;
  const displayedPromoCode = promoCodeQuote?.promoCode ?? null;
  const visibleFieldKeys = useMemo(() => {
    const visible = new Set<string>();
    if (!rosterEnabled) {
      allFields.forEach((field) => {
        if (isFieldVisible(field, responses)) visible.add(field.key);
      });
      return visible;
    }
    allFields.forEach((field) => {
      if (
        field.scope === "REGISTRATION"
        && isFieldVisible(field, registrationResponses)
      ) {
        visible.add(field.key);
      }
      if (
        field.scope === "ATTENDEE"
        && attendees.some((attendee) => (
          isFieldVisible(field, {
            ...registrationResponses,
            ...attendee.responses,
          })
        ))
      ) {
        visible.add(field.key);
      }
    });
    return visible;
  }, [
    allFields,
    attendees,
    registrationResponses,
    responses,
    rosterEnabled,
  ]);
  const registrationSteps = useMemo(
    () => getPublicRegistrationStepPlan(definition, visibleFieldKeys),
    [definition, visibleFieldKeys],
  );
  const [currentStepId, setCurrentStepId] = useState<PublicRegistrationStepId>(
    () => registrationSteps[0]?.id ?? "review",
  );
  const currentStepIndex = Math.max(
    registrationSteps.findIndex((step) => step.id === currentStepId),
    0,
  );
  const currentStep = registrationSteps[currentStepIndex]!;
  const attendeeSections = useMemo(
    () => definition.sections.map((section) => ({
      ...section,
      fields: section.fields.filter((field) => field.scope === "ATTENDEE"),
    })).filter((section) => section.fields.length > 0),
    [definition],
  );
  const cardSelected = Boolean(
    definition.payment?.enabled
      && (rosterEnabled ? registrationResponses : responses)[definition.payment.paymentMethodFieldKey] === definition.payment.cardOptionValue,
  );
  const promoField = useMemo(
    () => allFields.find((field) => (
      field.key === "promo_code"
      && field.scope === "REGISTRATION"
      && field.type === "TEXT"
    )) ?? null,
    [allFields],
  );
  const promoCodeValue = promoField
    ? String(
        (rosterEnabled ? registrationResponses : responses)[promoField.key]
        ?? "",
      ).trim()
    : "";
  const promoCodeApplied = Boolean(
    promoCodeQuote
    && promoCodeValue.toUpperCase() === promoCodeQuote.promoCode.toUpperCase(),
  );

  function stepForIssue(issue: FormIssue | undefined) {
    if (!issue) return undefined;
    if (issue.key === "attendees" || issue.path === "attendees") {
      return registrationSteps.find((step) => step.id === "attendees");
    }
    return registrationSteps.find((step) => step.fieldKeys.includes(issue.key));
  }

  function showIssues(
    nextIssues: FormIssue[],
    message: string,
    targetStep: PublicRegistrationStep | undefined = stepForIssue(nextIssues[0]),
  ) {
    const scopedIssues = targetStep
      ? nextIssues.filter((issue) => issueBelongsToStep(issue, targetStep))
      : [];
    if (targetStep) setCurrentStepId(targetStep.id);
    setIssues(scopedIssues.length > 0 ? scopedIssues : nextIssues);
    setError(message);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => errorSummaryRef.current?.focus());
    });
  }

  function goToStep(step: PublicRegistrationStep) {
    setCurrentStepId(step.id);
    setIssues([]);
    setError("");
    window.requestAnimationFrame(() => stepHeadingRef.current?.focus());
  }

  function allClientIssues() {
    const ignoredFieldKeys = joiningWaitlist
      && definition.payment?.enabled
      ? [definition.payment.paymentMethodFieldKey]
      : undefined;
    const validationIssues = rosterEnabled
      ? validateRosterResponses()
      : validateTestResponses(
          definition,
          responses,
          choiceUsage,
          undefined,
          { ignoredFieldKeys },
        ).issues;
    if (promoField && promoCodeValue && !promoCodeApplied) {
      return [
        ...validationIssues,
        {
          fieldId: promoField.id,
          key: promoField.key,
          path: rosterEnabled
            ? `responses.${promoField.key}`
            : promoField.key,
          attendeeIndex: null,
          message: "Select Apply to check this promo code before continuing.",
        },
      ];
    }
    return validationIssues;
  }

  async function applyPromoCode() {
    if (!promoField || !promoCodeValue || promoCodeApplying) return;
    setPromoCodeApplying(true);
    setPromoCodeNotice("Checking this code…");
    setError("");
    setIssues((current) => current.filter((issue) => issue.key !== promoField.key));
    try {
      const response = await fetch(
        `/api/public/events/${encodeURIComponent(event.slug)}/forms/${encodeURIComponent(form.slug)}/promo-code`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            versionId: form.versionId,
            code: promoCodeValue,
            responses: rosterEnabled ? registrationResponses : responses,
            ...(rosterEnabled ? {
              attendees: attendees.map((attendee) => ({
                clientId: attendee.clientId,
                responses: attendee.responses,
              })),
            } : {}),
          }),
        },
      );
      const result = await response.json().catch(() => ({})) as {
        quote?: PromoCodeQuote;
        issue?: FormIssue;
        message?: string;
      };
      if (!response.ok || !result.quote) {
        const issue = result.issue ?? {
          fieldId: promoField.id,
          key: promoField.key,
          path: rosterEnabled
            ? `responses.${promoField.key}`
            : promoField.key,
          attendeeIndex: null,
          message: result.message ?? "That promo code could not be applied.",
        };
        setIssues([issue]);
        setPromoCodeQuote(null);
        setPromoCodeNotice(issue.message);
        return;
      }
      const quote = result.quote;
      if (rosterEnabled) {
        setRegistrationResponses((current) => ({
          ...current,
          [promoField.key]: quote.promoCode,
        }));
      } else {
        setResponses((current) => ({
          ...current,
          [promoField.key]: quote.promoCode,
        }));
      }
      setPromoCodeQuote(quote);
      setPromoCodeNotice(
        `${quote.promoCode} applied — ${money(quote.discountAmountCents)} off.`,
      );
      setIdempotencyKey(null);
    } catch {
      setPromoCodeQuote(null);
      setPromoCodeNotice(
        "The promo code could not be checked right now. Try again.",
      );
      setIssues([{
        fieldId: promoField.id,
        key: promoField.key,
        path: rosterEnabled
          ? `responses.${promoField.key}`
          : promoField.key,
        attendeeIndex: null,
        message: "The promo code could not be checked right now. Try again.",
      }]);
    } finally {
      setPromoCodeApplying(false);
    }
  }

  function removePromoCode() {
    if (!promoField) return;
    if (rosterEnabled) {
      setRegistrationFieldValue(promoField.key, "");
    } else {
      setFieldValue(promoField.key, "");
    }
    setPromoCodeQuote(null);
    setPromoCodeNotice("Promo code removed.");
  }

  function issueBelongsToStep(issue: FormIssue, step: PublicRegistrationStep) {
    if (issue.key === "attendees" || issue.path === "attendees") {
      return step.id === "attendees";
    }
    return step.fieldKeys.includes(issue.key);
  }

  function continueRegistration() {
    const stepIssues = allClientIssues().filter((issue) => (
      issueBelongsToStep(issue, currentStep)
    ));
    if (stepIssues.length > 0) {
      showIssues(
        stepIssues,
        `Complete ${currentStep.shortLabel.toLowerCase()} before continuing.`,
        currentStep,
      );
      return;
    }
    const nextStep = registrationSteps[currentStepIndex + 1];
    if (nextStep) goToStep(nextStep);
  }

  function setFieldValue(key: string, value: ResponseValue) {
    setResponses((current) => {
      const next: FormResponses = { ...current, [key]: value };
      for (let pass = 0; pass < allFields.length; pass += 1) {
        let removed = false;
        for (const field of allFields) {
          if (field.conditional && field.key in next && !isFieldVisible(field, next)) {
            delete next[field.key];
            removed = true;
          }
        }
        if (!removed) break;
      }
      return next;
    });
    setIssues((current) => current.filter((issue) => issue.key !== key));
    setError("");
    setPromoCodeQuote(null);
    setPromoCodeNotice("");
    setIdempotencyKey(null);
  }

  function pruneScopedResponses(
    input: FormResponses,
    scope: RegistrationFormField["scope"],
    shared: FormResponses,
  ) {
    const next = { ...input };
    const scopedFields = allFields.filter((field) => field.scope === scope);
    for (let pass = 0; pass < scopedFields.length; pass += 1) {
      let removed = false;
      for (const field of scopedFields) {
        if (
          field.conditional
          && field.key in next
          && !isFieldVisible(field, { ...shared, ...next })
        ) {
          delete next[field.key];
          removed = true;
        }
      }
      if (!removed) break;
    }
    return next;
  }

  function clearFieldIssue(path: string, key: string) {
    setIssues((current) => current.filter((issue) => (
      (issue.path ?? issue.key) !== path
      && !(issue.path === undefined && issue.key === key)
    )));
    setError("");
    setPromoCodeQuote(null);
    setPromoCodeNotice("");
    setIdempotencyKey(null);
  }

  function setRegistrationFieldValue(key: string, value: ResponseValue) {
    const nextRegistration = pruneScopedResponses(
      { ...registrationResponses, [key]: value },
      "REGISTRATION",
      {},
    );
    setRegistrationResponses(nextRegistration);
    setAttendees((current) => current.map((attendee) => ({
      ...attendee,
      responses: pruneScopedResponses(attendee.responses, "ATTENDEE", nextRegistration),
    })));
    clearFieldIssue(`responses.${key}`, key);
  }

  function setAttendeeFieldValue(attendeeIndex: number, key: string, value: ResponseValue) {
    setAttendees((current) => current.map((attendee, index) => index === attendeeIndex ? {
      ...attendee,
      responses: pruneScopedResponses(
        { ...attendee.responses, [key]: value },
        "ATTENDEE",
        registrationResponses,
      ),
    } : attendee));
    clearFieldIssue(`attendees.${attendeeIndex}.responses.${key}`, key);
  }

  function addAttendee() {
    if (attendees.length >= roster.maxAttendees) return;
    const clientId = crypto.randomUUID();
    const nextNumber = attendees.length + 1;
    setAttendees((current) => [...current, { clientId, responses: {} }]);
    setIssues([]);
    setError("");
    setPromoCodeQuote(null);
    setPromoCodeNotice("");
    setIdempotencyKey(null);
    setRosterAnnouncement(`${roster.attendeeLabel} ${nextNumber} added.`);
    window.requestAnimationFrame(() => document.getElementById(`public_attendee_${safeId(clientId)}`)?.focus());
  }

  function removeAttendee(index: number) {
    if (attendees.length <= roster.minAttendees) return;
    const attendee = attendees[index];
    if (
      hasResponses(attendee.responses)
      && !window.confirm(`Remove ${attendeeName(attendee, index, roster.attendeeLabel)} and their answers?`)
    ) return;
    const focusId = attendees[index - 1]?.clientId ?? attendees[index + 1]?.clientId;
    setAttendees((current) => current.filter((_, attendeeIndex) => attendeeIndex !== index));
    setIssues([]);
    setError("");
    setPromoCodeQuote(null);
    setPromoCodeNotice("");
    setIdempotencyKey(null);
    setRosterAnnouncement(`${roster.attendeeLabel} ${index + 1} removed.`);
    window.requestAnimationFrame(() => {
      if (focusId) document.getElementById(`public_attendee_${safeId(focusId)}`)?.focus();
      else document.getElementById("public_registration_add_attendee")?.focus();
    });
  }

  function moveAttendee(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= attendees.length) return;
    const clientId = attendees[index].clientId;
    setAttendees((current) => {
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
    setIssues([]);
    setError("");
    setPromoCodeQuote(null);
    setPromoCodeNotice("");
    setIdempotencyKey(null);
    setRosterAnnouncement(`${roster.attendeeLabel} moved to position ${nextIndex + 1}.`);
    window.requestAnimationFrame(() => document.getElementById(`public_attendee_${safeId(clientId)}`)?.focus());
  }

  function choiceState(field: RegistrationFormField, option: string) {
    const stats = { ...(choiceUsage[field.key]?.[option] ?? { total: 0, first: 0, second: 0 }) };
    if (rosterEnabled) {
      const responseSets = field.scope === "REGISTRATION"
        ? [registrationResponses]
        : attendees.map((attendee) => attendee.responses);
      responseSets.forEach((fieldResponses) => {
        const merged = field.scope === "ATTENDEE"
          ? { ...registrationResponses, ...fieldResponses }
          : fieldResponses;
        if (!isFieldVisible(field, merged)) return;
        const value = fieldResponses[field.key];
        const selections = Array.isArray(value)
          ? value
          : typeof value === "string" && value
            ? [value]
            : [];
        selections.forEach((selection, rank) => {
          if (selection !== option) return;
          stats.total += 1;
          if (rank === 0) stats.first += 1;
          if (rank === 1) stats.second += 1;
        });
      });
    }
    const limit = field.choiceLimits?.[option];
    return {
      stats,
      limit,
      full: getAvailabilityMode(field) === "CAPACITY"
        && limit !== undefined
        && stats.total >= limit,
    };
  }

  function choicePrice(field: RegistrationFormField, option: string) {
    if (isLatePricingActive(field, pricingDate)) {
      return field.latePricing?.choicePricesCents?.[option] ?? field.choicePricesCents?.[option];
    }
    return field.choicePricesCents?.[option];
  }

  function choiceDetails(field: RegistrationFormField, option: string) {
    const { stats, limit, full } = choiceState(field, option);
    const mode = getAvailabilityMode(field);
    const price = choicePrice(field, option);
    const details: string[] = [];
    if (price !== undefined) details.push(money(price));
    if (mode === "RANKED_INTEREST") {
      details.push(`${stats.first} first choice`, `${stats.second} second choice`);
      details.push(`${stats.total} total interest`);
      if (limit !== undefined) details.push(`room capacity ${limit}`);
    } else if (mode === "CAPACITY") {
      details.push(limit === undefined ? `${stats.total} selected` : `${stats.total} of ${limit} selected`);
    }
    if (full) details.push("Full");
    return details.join(" · ");
  }

  function issueFor(field: RegistrationFormField, context: FieldRenderContext) {
    return issueByPath.get(context.issuePath(field.key))
      ?? (!rosterEnabled ? issueByPath.get(`responses.${field.key}`) : undefined);
  }

  function fieldSupport(field: RegistrationFormField, context: FieldRenderContext) {
    const issue = issueFor(field, context);
    const id = controlId(field, context.idContext);
    return (
      <>
        {field.helpText && <small id={`${id}_help`}>{field.helpText}</small>}
        {issue && <small className="public-registration-field-error" id={`${id}_error`}>{issue.message}</small>}
      </>
    );
  }

  function describedBy(field: RegistrationFormField, context: FieldRenderContext) {
    const id = controlId(field, context.idContext);
    return [
      field.helpText ? `${id}_help` : "",
      issueFor(field, context) ? `${id}_error` : "",
    ].filter(Boolean).join(" ") || undefined;
  }

  function fieldLabel(field: RegistrationFormField) {
    return (
      <span className="public-registration-field-label">
        {field.label}
        {field.required && <><span aria-hidden="true"> *</span><span className="sr-only"> (required)</span></>}
      </span>
    );
  }

  function renderField(field: RegistrationFormField, context: FieldRenderContext) {
    const issue = issueFor(field, context);
    const selectedValues = Array.isArray(context.values[field.key]) ? context.values[field.key] as string[] : [];
    const maximum = field.maxSelections ?? (field.type === "RANKED_CHOICE" ? 2 : field.options.length);
    const minimum = field.minSelections ?? (field.required ? (field.type === "RANKED_CHOICE" ? Math.min(2, maximum) : 1) : 0);
    const wrapperClass = `public-registration-field${issue ? " public-registration-field-invalid" : ""}`;
    const description = describedBy(field, context);
    const id = controlId(field, context.idContext);

    if (
      joiningWaitlist
      && definition.payment?.enabled
      && field.key === definition.payment.paymentMethodFieldKey
    ) {
      return (
        <div className="public-registration-waitlist-payment" key={field.id}>
          <Clock3 size={20} aria-hidden="true" />
          <span>
            <strong>No payment is requested while you are on the waitlist.</strong>
            <small>The event team will contact you before any payment is due.</small>
          </span>
        </div>
      );
    }

    if (field.key === "promo_code" && context.attendeeIndex === null) {
      const value = typeof context.values[field.key] === "string"
        ? context.values[field.key] as string
        : "";
      return (
        <div className={`${wrapperClass} public-registration-promo-field`} key={field.id}>
          <label htmlFor={id}>{fieldLabel(field)}</label>
          <div className="public-registration-promo-control">
            <input
              id={id}
              value={value}
              type="text"
              maxLength={32}
              autoCapitalize="characters"
              autoComplete="off"
              placeholder={field.placeholder ?? "Enter code"}
              aria-invalid={Boolean(issue)}
              aria-describedby={description}
              onChange={(inputEvent) => context.setValue(field.key, inputEvent.target.value)}
              onKeyDown={(keyboardEvent) => {
                if (keyboardEvent.key === "Enter") {
                  keyboardEvent.preventDefault();
                  void applyPromoCode();
                }
              }}
            />
            {promoCodeApplied ? (
              <button type="button" className="public-registration-promo-remove" onClick={removePromoCode}>
                Remove
              </button>
            ) : (
              <button
                type="button"
                disabled={!value.trim() || promoCodeApplying}
                onClick={() => void applyPromoCode()}
              >
                {promoCodeApplying ? "Checking…" : "Apply"}
              </button>
            )}
          </div>
          {fieldSupport(field, context)}
          {promoCodeNotice && (
            <small
              className={promoCodeApplied ? "public-registration-promo-success" : ""}
              role={promoCodeApplied ? "status" : undefined}
              aria-live="polite"
            >
              {promoCodeApplied && <BadgePercent size={15} aria-hidden="true" />}
              {promoCodeNotice}
            </small>
          )}
        </div>
      );
    }

    function toggleChoice(option: string) {
      if (selectedValues.includes(option)) {
        context.setValue(field.key, selectedValues.filter((value) => value !== option));
      } else if (selectedValues.length < maximum) {
        context.setValue(field.key, [...selectedValues, option]);
      }
    }

    if (field.type === "CALCULATED") {
      const lineItemKey = context.attendeeIndex === null
        ? field.key
        : `attendees.${context.attendeeIndex}.${field.key}`;
      const lineItem = context.calculation.lineItems.find((item) => item.key === lineItemKey);
      return (
        <div className={`${wrapperClass} public-registration-calculated`} key={field.id}>
          <span><strong>{field.label}</strong><small>Automatically included in your order.</small></span>
          <strong>{lineItem ? money(lineItem.amountCents) : "Included"}</strong>
        </div>
      );
    }

    if (field.type === "RADIO") {
      return (
        <fieldset className={wrapperClass} key={field.id} aria-invalid={Boolean(issue)} aria-required={field.required} aria-describedby={description}>
          <legend>{fieldLabel(field)}</legend>
          <div className="public-registration-choice-list">
            {field.options.map((option, index) => {
              const { full } = choiceState(field, option);
              const details = choiceDetails(field, option);
              const checked = context.values[field.key] === option;
              return (
                <label className={`public-registration-option${full ? " is-full" : ""}`} key={option}>
                  <input
                    id={controlId(field, context.idContext, index)}
                    name={context.idContext ? `${context.idContext}_${field.key}` : field.key}
                    type="radio"
                    checked={checked}
                    disabled={full && !checked}
                    onChange={() => context.setValue(field.key, option)}
                  />
                  <span><strong>{option}</strong>{details && <small>{details}</small>}</span>
                </label>
              );
            })}
          </div>
          {fieldSupport(field, context)}
        </fieldset>
      );
    }

    if (field.type === "MULTISELECT") {
      return (
        <fieldset className={wrapperClass} key={field.id} aria-invalid={Boolean(issue)} aria-required={field.required} aria-describedby={description}>
          <legend>{fieldLabel(field)}</legend>
          <small>Choose {minimum > 0 ? `at least ${minimum} and ` : ""}up to {maximum}.</small>
          <div className="public-registration-choice-list">
            {field.options.map((option, index) => {
              const { full } = choiceState(field, option);
              const details = choiceDetails(field, option);
              const checked = selectedValues.includes(option);
              return (
                <label className={`public-registration-option${full ? " is-full" : ""}`} key={option}>
                  <input
                    id={controlId(field, context.idContext, index)}
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && (full || selectedValues.length >= maximum)}
                    onChange={() => toggleChoice(option)}
                  />
                  <span><strong>{option}</strong>{details && <small>{details}</small>}</span>
                </label>
              );
            })}
          </div>
          {fieldSupport(field, context)}
        </fieldset>
      );
    }

    if (field.type === "RANKED_CHOICE") {
      return (
        <fieldset className={wrapperClass} key={field.id} aria-invalid={Boolean(issue)} aria-required={field.required} aria-describedby={description}>
          <legend>{fieldLabel(field)}</legend>
          <small>Choose {minimum} and rank up to {maximum}. Select choices in preference order.</small>
          <div className="public-registration-ranking-list">
            {field.options.map((option, index) => {
              const rank = selectedValues.indexOf(option);
              const { full } = choiceState(field, option);
              const details = choiceDetails(field, option);
              return (
                <button
                  className={`${rank >= 0 ? "is-selected" : ""}${full ? " is-full" : ""}`.trim()}
                  id={controlId(field, context.idContext, index)}
                  type="button"
                  key={option}
                  aria-pressed={rank >= 0}
                  disabled={rank < 0 && (full || selectedValues.length >= maximum)}
                  onClick={() => toggleChoice(option)}
                >
                  <span><strong>{option}</strong>{details && <small>{details}</small>}</span>
                  <b>{rank < 0 ? (full ? "Full" : "Choose") : rank === 0 ? "1st choice" : rank === 1 ? "2nd choice" : `#${rank + 1}`}</b>
                </button>
              );
            })}
          </div>
          {fieldSupport(field, context)}
        </fieldset>
      );
    }

    if (field.type === "CHECKBOX") {
      return (
        <fieldset className={wrapperClass} key={field.id} aria-invalid={Boolean(issue)} aria-required={field.required} aria-describedby={description}>
          <legend>{fieldLabel(field)}</legend>
          <label className="public-registration-check">
            <input
              id={id}
              type="checkbox"
              checked={context.values[field.key] === true}
              onChange={(inputEvent) => context.setValue(field.key, inputEvent.target.checked)}
            />
            <span>{field.placeholder || "Yes, I understand and agree."}</span>
          </label>
          {fieldSupport(field, context)}
        </fieldset>
      );
    }

    if (field.type === "SELECT") {
      return (
        <label className={wrapperClass} key={field.id}>
          {fieldLabel(field)}
          <select
            id={id}
            value={typeof context.values[field.key] === "string" ? context.values[field.key] as string : ""}
            required={field.required}
            aria-invalid={Boolean(issue)}
            aria-describedby={description}
            onChange={(inputEvent) => context.setValue(field.key, inputEvent.target.value)}
          >
            <option value="">Choose one</option>
            {field.options.map((option) => {
              const { full } = choiceState(field, option);
              const details = choiceDetails(field, option);
              const selected = context.values[field.key] === option;
              return <option value={option} disabled={rosterEnabled ? full && !selected : full} key={option}>{option}{details ? ` — ${details}` : ""}</option>;
            })}
          </select>
          {fieldSupport(field, context)}
        </label>
      );
    }

    const value = typeof context.values[field.key] === "string" ? context.values[field.key] as string : "";
    const autoCompletePurpose = rosterEnabled && field.key === "first_name"
      ? "given-name"
      : rosterEnabled && field.key === "last_name"
        ? "family-name"
        : rosterEnabled && ["full_name", "name", "attendee_name", "guest_name"].includes(field.key)
          ? "name"
          : field.type === "EMAIL"
            ? "email"
            : field.type === "PHONE"
              ? "tel"
              : undefined;
    const autoComplete = autoCompletePurpose && context.attendeeIndex !== null
      ? `section-${safeId(context.idContext)} ${autoCompletePurpose}`
      : autoCompletePurpose;
    return (
      <label className={wrapperClass} key={field.id}>
        {fieldLabel(field)}
        {field.type === "LONG_TEXT" ? (
          <textarea
            id={id}
            value={value}
            rows={4}
            required={field.required}
            placeholder={field.placeholder ?? ""}
            aria-invalid={Boolean(issue)}
            aria-describedby={description}
            onChange={(inputEvent) => context.setValue(field.key, inputEvent.target.value)}
          />
        ) : (
          <input
            id={id}
            value={value}
            type={field.type === "EMAIL" ? "email" : field.type === "PHONE" ? "tel" : field.type === "DATE" ? "date" : field.type === "NUMBER" ? "number" : "text"}
            min={field.type === "NUMBER" ? 0 : undefined}
            inputMode={field.type === "PHONE" ? "tel" : field.type === "NUMBER" ? "numeric" : undefined}
            autoComplete={autoComplete}
            required={field.required}
            placeholder={field.placeholder ?? ""}
            aria-invalid={Boolean(issue)}
            aria-describedby={description}
            onChange={(inputEvent) => context.setValue(field.key, inputEvent.target.value)}
          />
        )}
        {fieldSupport(field, context)}
      </label>
    );
  }

  function legacyFieldContext(): FieldRenderContext {
    return {
      values: responses,
      visibilityResponses: responses,
      setValue: setFieldValue,
      idContext: "",
      issuePath: (key) => key,
      attendeeIndex: null,
      calculation,
    };
  }

  function registrationFieldContext(): FieldRenderContext {
    return {
      values: registrationResponses,
      visibilityResponses: registrationResponses,
      setValue: setRegistrationFieldValue,
      idContext: "registration",
      issuePath: (key) => `responses.${key}`,
      attendeeIndex: null,
      calculation,
    };
  }

  function attendeeFieldContext(attendee: RosterAttendee, attendeeIndex: number): FieldRenderContext {
    return {
      values: attendee.responses,
      visibilityResponses: { ...registrationResponses, ...attendee.responses },
      setValue: (key, value) => setAttendeeFieldValue(attendeeIndex, key, value),
      idContext: `attendee_${attendee.clientId}`,
      issuePath: (key) => `attendees.${attendeeIndex}.responses.${key}`,
      attendeeIndex,
      calculation,
    };
  }

  function issueTargetId(issue: FormIssue) {
    const field = allFields.find((candidate) => (
      candidate.id === issue.fieldId || candidate.key === issue.key
    ));
    if (!field) return null;
    if (!rosterEnabled) return controlId(field);
    const pathIndex = issue.path?.match(/^attendees\.(\d+)\./)?.[1];
    const attendeeIndex = issue.attendeeIndex ?? (pathIndex === undefined ? null : Number(pathIndex));
    if (attendeeIndex !== null) {
      const attendee = attendees[attendeeIndex];
      return attendee ? controlId(field, `attendee_${attendee.clientId}`) : null;
    }
    if (field.scope === "ATTENDEE") {
      const firstAttendee = attendees[0];
      return firstAttendee ? controlId(field, `attendee_${firstAttendee.clientId}`) : null;
    }
    return controlId(field, "registration");
  }

  function renderRoster(
    sectionNumber: number,
    allowedFieldKeys: ReadonlySet<string>,
    manageRoster: boolean,
  ) {
    const titleId = manageRoster
      ? "public_registration_roster_attendees_title"
      : "public_registration_roster_choices_title";
    return (
      <section
        className="public-registration-roster"
        aria-labelledby={titleId}
      >
        <header className="public-registration-roster-heading">
          <span>{sectionNumber}</span>
          <div>
            <p className="public-registration-eyebrow">
              {manageRoster ? "Household or group" : "Per-attendee choices"}
            </p>
            <h2 id={titleId}>
              {manageRoster
                ? `${roster.attendeeLabel} roster`
                : "Choices for each attendee"}
            </h2>
            <p>
              {manageRoster
                ? <>Add between {roster.minAttendees} and {roster.maxAttendees}{" "}
                  {roster.attendeeLabel.toLowerCase()}
                  {roster.maxAttendees === 1 ? "" : "s"}. Each person’s details are kept separate.</>
                : "Review the event options that apply separately to each attendee."}
            </p>
          </div>
          <strong>{attendees.length} of {roster.maxAttendees}</strong>
        </header>

        <p className="sr-only" aria-live="polite">{rosterAnnouncement}</p>
        <div className="public-registration-attendee-list">
          {attendees.map((attendee, attendeeIndex) => {
            const context = attendeeFieldContext(attendee, attendeeIndex);
            const displayName = attendeeName(attendee, attendeeIndex, roster.attendeeLabel);
            const visibleAttendeeSections = attendeeSections.map((section) => ({
              ...section,
              fields: section.fields.filter((field) => (
                allowedFieldKeys.has(field.key)
                && isFieldVisible(field, context.visibilityResponses)
              )),
            })).filter((section) => section.fields.length > 0);
            return (
              <article
                className="public-registration-attendee"
                id={`public_attendee_${safeId(attendee.clientId)}`}
                key={attendee.clientId}
                tabIndex={-1}
                aria-labelledby={`public_attendee_${safeId(attendee.clientId)}_title`}
              >
                <header className="public-registration-attendee-heading">
                  <span className="public-registration-attendee-number" aria-hidden="true">
                    {attendeeIndex + 1}
                  </span>
                  <div>
                    <small>{roster.attendeeLabel} {attendeeIndex + 1}</small>
                    <h3 id={`public_attendee_${safeId(attendee.clientId)}_title`}>{displayName}</h3>
                  </div>
                  {manageRoster && (
                    <div className="public-registration-attendee-actions">
                      <button
                        type="button"
                        disabled={attendeeIndex === 0}
                        aria-label={`Move ${displayName} up`}
                        onClick={() => moveAttendee(attendeeIndex, -1)}
                      >
                        <ArrowUp size={16} aria-hidden="true" />
                        <span>Up</span>
                      </button>
                      <button
                        type="button"
                        disabled={attendeeIndex === attendees.length - 1}
                        aria-label={`Move ${displayName} down`}
                        onClick={() => moveAttendee(attendeeIndex, 1)}
                      >
                        <ArrowDown size={16} aria-hidden="true" />
                        <span>Down</span>
                      </button>
                      <button
                        className="is-danger"
                        type="button"
                        disabled={attendees.length <= roster.minAttendees}
                        aria-label={`Remove ${displayName}`}
                        onClick={() => removeAttendee(attendeeIndex)}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                        <span>Remove</span>
                      </button>
                    </div>
                  )}
                </header>

                <div className="public-registration-attendee-body">
                  {visibleAttendeeSections.map((section) => (
                    <section
                      className="public-registration-attendee-section"
                      key={section.id}
                      aria-labelledby={`public_attendee_${safeId(attendee.clientId)}_${safeId(section.id)}`}
                    >
                      <div className="public-registration-attendee-section-heading">
                        <h4 id={`public_attendee_${safeId(attendee.clientId)}_${safeId(section.id)}`}>{section.title}</h4>
                        {section.description && <p>{section.description}</p>}
                      </div>
                      <div className="public-registration-fields">
                        {section.fields.map((field) => renderField(field, context))}
                      </div>
                    </section>
                  ))}
                  {visibleAttendeeSections.length === 0 && (
                    <p className="public-registration-attendee-empty">
                      No additional choices apply to this attendee.
                    </p>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        {manageRoster && (
          <footer className="public-registration-roster-footer">
            <button
              id="public_registration_add_attendee"
              type="button"
              disabled={attendees.length >= roster.maxAttendees}
              onClick={addAttendee}
            >
              <Plus size={18} aria-hidden="true" />
              {attendees.length >= roster.maxAttendees ? "Roster limit reached" : roster.addButtonLabel}
            </button>
            <small>
              {attendees.length < roster.maxAttendees
                ? `${roster.maxAttendees - attendees.length} more can be added.`
                : `Maximum of ${roster.maxAttendees} reached.`}
            </small>
          </footer>
        )}
      </section>
    );
  }

  function renderStepFields(step: PublicRegistrationStep) {
    const allowedFieldKeys = new Set(step.fieldKeys);
    const context = rosterEnabled
      ? registrationFieldContext()
      : legacyFieldContext();
    const blocks: React.ReactNode[] = [];
    let blockNumber = 0;
    let rosterInserted = false;

    for (const section of definition.sections) {
      const sectionFields = section.fields.filter((field) => (
        allowedFieldKeys.has(field.key)
        && (!rosterEnabled || field.scope === "REGISTRATION")
        && isFieldVisible(
          field,
          rosterEnabled ? registrationResponses : responses,
        )
      ));
      if (sectionFields.length > 0) {
        blockNumber += 1;
        blocks.push(
          <section
            className="public-registration-section"
            key={`${step.id}_${section.id}`}
            aria-labelledby={`public_section_${step.id}_${section.id}`}
          >
            <header>
              <span>{blockNumber}</span>
              <div>
                <h2 id={`public_section_${step.id}_${section.id}`}>
                  {section.title}
                </h2>
                {section.description && <p>{section.description}</p>}
              </div>
            </header>
            <div className="public-registration-fields">
              {sectionFields.map((field) => renderField(field, context))}
            </div>
          </section>,
        );
      }

      const hasAttendeeFields = rosterEnabled && section.fields.some((field) => (
        field.scope === "ATTENDEE" && allowedFieldKeys.has(field.key)
      ));
      if (hasAttendeeFields && !rosterInserted) {
        blockNumber += 1;
        blocks.push(
          <div
            className="public-registration-roster-block"
            key={`${step.id}_attendee_roster`}
          >
            {renderRoster(
              blockNumber,
              allowedFieldKeys,
              step.id === "attendees",
            )}
          </div>,
        );
        rosterInserted = true;
      }
    }
    return blocks;
  }

  function reviewAnswerRows(
    values: FormResponses,
    scope: RegistrationFormField["scope"] | null,
    shared: FormResponses,
  ) {
    return allFields.flatMap((field) => {
      if (
        (scope && field.scope !== scope)
        || field.type === "CALCULATED"
        || field.type === "CHECKBOX"
        || !isFieldVisible(field, { ...shared, ...values })
      ) {
        return [];
      }
      const answer = formatPublicRegistrationAnswer(values[field.key]);
      return answer ? [{ field, answer }] : [];
    });
  }

  function renderReview() {
    const registrationAnswers = reviewAnswerRows(
      rosterEnabled ? registrationResponses : responses,
      rosterEnabled ? "REGISTRATION" : null,
      {},
    );
    const attendeeAnswerGroups = rosterEnabled
      ? attendees.map((attendee, attendeeIndex) => ({
        id: attendee.clientId,
        name: attendeeName(attendee, attendeeIndex, roster.attendeeLabel),
        answers: reviewAnswerRows(
          attendee.responses,
          "ATTENDEE",
          registrationResponses,
        ),
      }))
      : [];
    const singleAttendeeName = !rosterEnabled && allFields.some((field) => (
      field.scope === "ATTENDEE"
    ))
      ? attendeeName(
        { clientId: "single-attendee", responses },
        0,
        "Attendee",
      )
      : null;
    const acknowledgements = allFields.flatMap((field) => {
      if (field.type !== "CHECKBOX") return [];
      if (!rosterEnabled) {
        if (!isFieldVisible(field, responses)) return [];
        return [{
          key: field.key,
          label: field.label,
          accepted: responses[field.key] === true,
        }];
      }
      if (field.scope === "REGISTRATION") {
        if (!isFieldVisible(field, registrationResponses)) return [];
        return [{
          key: field.key,
          label: field.label,
          accepted: registrationResponses[field.key] === true,
        }];
      }
      return attendees.flatMap((attendee, attendeeIndex) => {
        const merged = { ...registrationResponses, ...attendee.responses };
        if (!isFieldVisible(field, merged)) return [];
        return [{
          key: `${attendee.clientId}_${field.key}`,
          label: `${attendeeName(attendee, attendeeIndex, roster.attendeeLabel)} — ${field.label}`,
          accepted: attendee.responses[field.key] === true,
        }];
      });
    });

    function answerList(
      answers: ReturnType<typeof reviewAnswerRows>,
      emptyCopy: string,
    ) {
      if (answers.length === 0) {
        return <p className="public-registration-review-empty">{emptyCopy}</p>;
      }
      return (
        <dl className="public-registration-review-answers">
          {answers.map(({ field, answer }) => (
            <div key={field.id}>
              <dt>{field.label}</dt>
              <dd>{answer}</dd>
            </div>
          ))}
        </dl>
      );
    }

    return (
      <div className="public-registration-review">
        {(rosterEnabled || singleAttendeeName) && (
          <section className="public-registration-review-card">
            <p className="public-registration-eyebrow">Attendees</p>
            <h3>
              {rosterEnabled
                ? `${attendees.length} ${attendees.length === 1 ? roster.attendeeLabel.toLowerCase() : `${roster.attendeeLabel.toLowerCase()}s`}`
                : singleAttendeeName}
            </h3>
            {rosterEnabled && (
              <ol className="public-registration-review-attendees">
                {attendeeAnswerGroups.map((group) => (
                  <li key={group.id}>
                    <strong>{group.name}</strong>
                    {answerList(group.answers, "No additional answers entered.")}
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}

        <section className="public-registration-review-card">
          <p className="public-registration-eyebrow">Selected answers</p>
          <h3>Registration details</h3>
          {answerList(
            registrationAnswers,
            "No additional registration-level answers were entered.",
          )}
        </section>

        <section className="public-registration-review-card public-registration-review-order">
          <p className="public-registration-eyebrow">
            {joiningWaitlist ? "Estimated cost" : "Price & fees"}
          </p>
          <h3>
            {joiningWaitlist ? "If space becomes available" : "Registration total"}
          </h3>
          {calculation.lineItems.length > 0 ? (
            <div className="public-registration-review-lines">
              {calculation.lineItems.map((item) => (
                <div key={item.key}>
                  <span>
                    {item.label}
                    {item.pricingLabel && <small>{item.pricingLabel}</small>}
                  </span>
                  <strong>{money(item.amountCents)}</strong>
                </div>
              ))}
              <div><span>Subtotal</span><strong>{money(displayedPreDiscountSubtotalCents)}</strong></div>
              {displayedDiscountCents > 0 && (
                <>
                  <div className="is-discount">
                    <span>Promo code {displayedPromoCode}</span>
                    <strong>−{money(displayedDiscountCents)}</strong>
                  </div>
                  <div>
                    <span>Discounted subtotal</span>
                    <strong>{money(calculation.subtotalCents)}</strong>
                  </div>
                </>
              )}
              {calculation.processingFeeCents > 0 && (
                <div>
                  <span>Card processing</span>
                  <strong>{money(calculation.processingFeeCents)}</strong>
                </div>
              )}
              <div className="is-total">
                <span>{joiningWaitlist ? "Estimated if promoted" : "Total"}</span>
                <strong>
                  {money(
                    joiningWaitlist
                      ? calculation.subtotalCents
                      : calculation.totalCents,
                  )}
                </strong>
              </div>
            </div>
          ) : (
            <p className="public-registration-review-empty">
              No registration charge is currently selected.
            </p>
          )}
          {joiningWaitlist && (
            <p className="public-registration-review-waitlist">
              No payment is collected for this waitlist request.
            </p>
          )}
        </section>

        {acknowledgements.length > 0 && (
          <section className="public-registration-review-card">
            <p className="public-registration-eyebrow">Acknowledgements</p>
            <h3>Confirm before submitting</h3>
            <ul className="public-registration-review-acknowledgements">
              {acknowledgements.map((acknowledgement) => (
                <li
                  className={acknowledgement.accepted ? "is-accepted" : ""}
                  key={acknowledgement.key}
                >
                  {acknowledgement.accepted
                    ? <CheckCircle2 size={17} aria-hidden="true" />
                    : <span aria-hidden="true" />}
                  <span>
                    <strong>{acknowledgement.label}</strong>
                    <small>
                      {acknowledgement.accepted
                        ? "Accepted"
                        : "Not accepted yet"}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  function validateRosterResponses() {
    const nextIssues: FormIssue[] = [];
    if (attendees.length < roster.minAttendees || attendees.length > roster.maxAttendees) {
      nextIssues.push({
        key: "attendees",
        path: "attendees",
        attendeeIndex: null,
        message: `Add between ${roster.minAttendees} and ${roster.maxAttendees} ${roster.attendeeLabel.toLowerCase()}${roster.maxAttendees === 1 ? "" : "s"}.`,
      });
    }
    const projectedUsage = cloneChoiceUsage(definition, choiceUsage);
    const registrationValidation = validateTestResponses(
      definition,
      registrationResponses,
      projectedUsage,
      "REGISTRATION",
      {
        ignoredFieldKeys: joiningWaitlist && definition.payment?.enabled
          ? [definition.payment.paymentMethodFieldKey]
          : undefined,
      },
    );
    nextIssues.push(...registrationValidation.issues.map((issue) => ({
      ...issue,
      path: `responses.${issue.key}`,
      attendeeIndex: null,
    })));
    addResponsesToUsage(definition, registrationResponses, projectedUsage, "REGISTRATION");
    attendees.forEach((attendee, attendeeIndex) => {
      const merged = { ...registrationResponses, ...attendee.responses };
      const validation = validateTestResponses(
        definition,
        merged,
        projectedUsage,
        "ATTENDEE",
        {
          ignoredFieldKeys: joiningWaitlist && definition.payment?.enabled
            ? [definition.payment.paymentMethodFieldKey]
            : undefined,
        },
      );
      nextIssues.push(...validation.issues.map((issue) => ({
        ...issue,
        path: `attendees.${attendeeIndex}.responses.${issue.key}`,
        attendeeIndex,
      })));
      addResponsesToUsage(definition, merged, projectedUsage, "ATTENDEE");
    });
    return nextIssues;
  }

  async function submit(submitEvent: React.FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    if (currentStep.id !== "review") {
      continueRegistration();
      return;
    }
    const clientIssues = allClientIssues();
    if (clientIssues.length > 0) {
      showIssues(
        clientIssues,
        "Review the highlighted fields before submitting.",
        stepForIssue(clientIssues[0]) ?? currentStep,
      );
      return;
    }

    setSubmitting(true);
    setIssues([]);
    setError("");
    const submissionKey = idempotencyKey ?? crypto.randomUUID();
    if (!idempotencyKey) setIdempotencyKey(submissionKey);
    try {
      const response = await fetch(`/api/public/events/${encodeURIComponent(event.slug)}/forms/${encodeURIComponent(form.slug)}/registrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionId: form.versionId,
          idempotencyKey: submissionKey,
          responses: rosterEnabled ? registrationResponses : responses,
          ...(rosterEnabled ? {
            attendees: attendees.map((attendee) => ({
              clientId: attendee.clientId,
              responses: attendee.responses,
            })),
          } : {}),
          website,
        }),
      });
      const result = await response.json().catch(() => ({})) as {
        confirmation?: Confirmation;
        issues?: FormIssue[];
        message?: string;
      };
      if (!response.ok || !result.confirmation) {
        if (response.status < 500) setIdempotencyKey(null);
        const nextIssues = Array.isArray(result.issues)
          ? result.issues.filter((issue) => issue && typeof issue.key === "string" && typeof issue.message === "string")
          : [];
        const promoIssue = nextIssues.find((issue) => issue.key === "promo_code");
        if (promoIssue) {
          setPromoCodeQuote(null);
          setPromoCodeNotice(promoIssue.message);
        }
        showIssues(
          nextIssues,
          result.message ?? "We could not complete the registration. Review the form and try again.",
          stepForIssue(nextIssues[0]) ?? currentStep,
        );
        return;
      }
      setConfirmation(result.confirmation);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setError("We could not reach the registration service. Your answers are still here; please try again.");
      window.requestAnimationFrame(() => errorSummaryRef.current?.focus());
    } finally {
      setSubmitting(false);
    }
  }

  function startAnotherRegistration() {
    setResponses({});
    setRegistrationResponses({});
    setAttendees(initialRoster(roster.minAttendees));
    setWebsite("");
    setIssues([]);
    setError("");
    setRosterAnnouncement("");
    setConfirmation(null);
    setPromoCodeQuote(null);
    setPromoCodeApplying(false);
    setPromoCodeNotice("");
    setIdempotencyKey(null);
    setCurrentStepId(registrationSteps[0]?.id ?? "review");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (confirmation) {
    const waitlisted = confirmation.registrationStatus === "WAITLISTED";
    return (
      <main className="public-registration-page">
        <header className="public-registration-header">
          <div className="public-registration-header-inner">
            <a className="public-registration-brand public-event-brand-link" href={`/events/${event.slug}`}><BrandMark /><span><strong>IMSDA</strong><small>Events</small></span></a>
            <span className="public-registration-secure">{waitlisted ? <Clock3 size={16} aria-hidden="true" /> : <LockKeyhole size={16} aria-hidden="true" />} {waitlisted ? "Waitlist request received" : "Registration received"}</span>
          </div>
        </header>
        <section className="public-registration-confirmation-wrap">
          <article className="public-registration-confirmation">
            <span className={`public-registration-confirmation-icon${waitlisted ? " is-waitlist" : ""}`}>{waitlisted ? <Clock3 size={34} aria-hidden="true" /> : <CheckCircle2 size={34} aria-hidden="true" />}</span>
            <p className="public-registration-eyebrow">{waitlisted ? "Waitlist request received" : "Registration received"}</p>
            <h1>{waitlisted ? "You’re on the waitlist" : "Thank you for registering"}</h1>
            <p className="public-registration-confirmation-message">{confirmation.message}</p>
            <div className="public-registration-code">
              <small>{waitlisted ? "Waitlist reference" : "Confirmation code"}</small>
              <strong>{confirmation.confirmationCode}</strong>
            </div>
            <div className="public-registration-local-warning" role="status">
              <ShieldCheck size={20} aria-hidden="true" />
              <span>
                <strong>
                  {confirmation.notificationStatus === "SENT"
                    ? "Your confirmation email was accepted for delivery."
                    : confirmation.notificationStatus === "CAPTURED"
                    ? "A local confirmation preview was saved; no external email was sent."
                    : confirmation.notificationStatus === "PENDING"
                      ? "Your registration is saved and the confirmation email is queued."
                      : confirmation.notificationStatus === "FAILED"
                        ? "Your registration is saved, but the confirmation email could not be sent."
                        : "Your registration is saved. Email delivery is not enabled for this event."}
                </strong>
                <small>
                  {confirmation.paymentCollected
                    ? "Your payment is recorded. Keep this confirmation code and private registration link."
                    : confirmation.cardSelected
                      ? "Your registration is saved, but the card is not charged yet. Continue through the private registration link below to complete secure Square checkout."
                      : "Keep this confirmation code and private registration link for future changes."}
                </small>
              </span>
            </div>
            <dl className="public-registration-confirmation-details">
              <div><dt>Event</dt><dd>{event.name}</dd></div>
              <div><dt>Email</dt><dd>{confirmation.email || "Not provided"}</dd></div>
              {rosterEnabled && (
                <div>
                  <dt>Attendees</dt>
                  <dd>{confirmation.attendeeCount} {waitlisted ? "on the waitlist" : "registered"}</dd>
                </div>
              )}
              <div><dt>{waitlisted ? "Estimate date" : "Pricing date"}</dt><dd>{formatPricingDate(confirmation.pricingDate)}</dd></div>
              <div><dt>{waitlisted ? "Estimated total if promoted" : "Total recorded"}</dt><dd>{money(confirmation.totalCents)}</dd></div>
            </dl>
            {rosterEnabled && confirmation.attendeeNames.length > 0 && (
              <section className="public-registration-confirmation-attendees" aria-label="Registered attendees">
                <h2>{waitlisted ? "Waitlisted attendees" : "Registered attendees"}</h2>
                <ul>{confirmation.attendeeNames.map((name, index) => <li key={`${name}_${index}`}>{name}</li>)}</ul>
              </section>
            )}
            {confirmation.lineItems.length > 0 && (
              <section className="public-registration-confirmation-order" aria-label="Recorded order">
                <h2>{waitlisted ? "Estimated order if promoted" : "Recorded order"}</h2>
                {confirmation.lineItems.map((item) => (
                  <div key={item.key}><span>{item.label}{item.pricingLabel && <small>{item.pricingLabel}</small>}</span><strong>{money(item.amountCents)}</strong></div>
                ))}
                <div><span>Subtotal</span><strong>{money(confirmation.preDiscountSubtotalCents)}</strong></div>
                {confirmation.discountAmountCents > 0 && (
                  <>
                    <div className="is-discount"><span>Promo code {confirmation.promoCode}</span><strong>−{money(confirmation.discountAmountCents)}</strong></div>
                    <div><span>Discounted subtotal</span><strong>{money(confirmation.subtotalCents)}</strong></div>
                  </>
                )}
                {confirmation.processingFeeCents > 0 && <div><span>Card processing</span><strong>{money(confirmation.processingFeeCents)}</strong></div>}
                <div className="is-total"><span>Total</span><strong>{money(confirmation.totalCents)}</strong></div>
              </section>
            )}
            {confirmation.managePath && (
              <div className="public-registration-manage-link">
                <a href={confirmation.managePath}>
                  {confirmation.cardSelected && !confirmation.paymentCollected && !waitlisted
                    ? "Continue to secure card payment"
                    : "View or update this registration"}{" "}
                  <ArrowRight size={17} aria-hidden="true" />
                </a>
                {formatManageLinkExpiry(confirmation.manageLinkExpiresAt) && (
                  <small>
                    Private link available through {formatManageLinkExpiry(confirmation.manageLinkExpiresAt)}.
                    Do not forward it to anyone who should not manage this registration.
                  </small>
                )}
              </div>
            )}
            <div className="public-registration-confirmation-actions">
              <a className="public-registration-secondary-button" href={`/events/${event.slug}`}><ArrowLeft size={16} aria-hidden="true" /> Back to event</a>
              <button className="public-registration-secondary-button" type="button" onClick={startAnotherRegistration}>{waitlisted ? "Add another waitlist request" : "Start another registration"}</button>
            </div>
          </article>
        </section>
      </main>
    );
  }

  return (
    <main className="public-registration-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <a className="public-registration-brand public-event-brand-link" href={`/events/${event.slug}`}><BrandMark /><span><strong>IMSDA</strong><small>Events</small></span></a>
          <span className="public-registration-secure">{joiningWaitlist ? <Clock3 size={16} aria-hidden="true" /> : <LockKeyhole size={16} aria-hidden="true" />} {joiningWaitlist ? "Event waitlist" : "Secure event registration"}</span>
        </div>
      </header>

      <section className="public-registration-hero">
        <div>
          <p className="public-registration-eyebrow">{joiningWaitlist ? "Join the event waitlist" : "Now registering"}</p>
          <h1>{event.name}</h1>
          <p>{definition.title}</p>
        </div>
        <div className="public-registration-event-details">
          <span><CalendarDays size={18} aria-hidden="true" /> {formatEventDates(event.startsAt, event.endsAt, event.timezone)}</span>
          <span><MapPin size={18} aria-hidden="true" /> {event.location ?? "Location to be announced"}</span>
        </div>
      </section>

      <form className="public-registration-layout" noValidate onSubmit={submit}>
        <div className="public-registration-form-column">
          {joiningWaitlist && (
            <section className="public-registration-waitlist-banner" role="status">
              <Clock3 size={22} aria-hidden="true" />
              <span>
                <strong>This is a waitlist request, not a confirmed registration.</strong>
                <small>No payment will be collected. The event team will contact you if space becomes available.</small>
              </span>
            </section>
          )}
          <section className="public-registration-intro">
            <p className="public-registration-eyebrow">Registration form</p>
            <h2>{definition.title}</h2>
            {definition.description && <p>{definition.description}</p>}
            <span><span aria-hidden="true">*</span> Required field</span>
          </section>

          <section
            className="public-registration-progress"
            aria-label="Registration progress"
          >
            <div className="public-registration-progress-heading">
              <span>
                Step {currentStepIndex + 1} of {registrationSteps.length}
              </span>
              <strong>{currentStep.shortLabel}</strong>
            </div>
            <div
              className="public-registration-progress-track"
              role="progressbar"
              aria-label="Registration progress"
              aria-valuemin={1}
              aria-valuemax={registrationSteps.length}
              aria-valuenow={currentStepIndex + 1}
            >
              <span
                style={{
                  width: `${((currentStepIndex + 1) / registrationSteps.length) * 100}%`,
                }}
              />
            </div>
            <ol>
              {registrationSteps.map((step, stepIndex) => (
                <li
                  className={
                    stepIndex === currentStepIndex
                      ? "is-current"
                      : stepIndex < currentStepIndex
                        ? "is-complete"
                        : ""
                  }
                  aria-current={stepIndex === currentStepIndex ? "step" : undefined}
                  key={step.id}
                >
                  <span>{stepIndex + 1}</span>
                  <small>{step.shortLabel}</small>
                </li>
              ))}
            </ol>
          </section>

          {(error || issues.length > 0) && (
            <div className="public-registration-error-summary" ref={errorSummaryRef} role="alert" tabIndex={-1}>
              <strong>{error || "Review the highlighted fields."}</strong>
              {issues.length > 0 && (
                <ul>{issues.map((issue, index) => {
                  const targetId = issueTargetId(issue);
                  return <li key={`${issue.path ?? issue.key}_${index}`}>{targetId ? <a href={`#${targetId}`}>{issue.message}</a> : issue.message}</li>;
                })}</ul>
              )}
            </div>
          )}

          <section
            className="public-registration-step-shell"
            aria-labelledby="public_registration_step_heading"
          >
            <header className="public-registration-step-heading">
              <p className="public-registration-eyebrow">
                Step {currentStepIndex + 1}
              </p>
              <h2
                id="public_registration_step_heading"
                ref={stepHeadingRef}
                tabIndex={-1}
              >
                {joiningWaitlist && currentStep.id === "review"
                  ? "Review your waitlist request"
                  : currentStep.title}
              </h2>
              <p>{currentStep.description}</p>
            </header>
            <div className="public-registration-step-content">
              {renderStepFields(currentStep)}
              {currentStep.id === "review" && renderReview()}
            </div>
          </section>

          <div className="public-registration-honeypot" aria-hidden="true">
            <label htmlFor="public_registration_website">Website</label>
            <input id="public_registration_website" name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(inputEvent) => setWebsite(inputEvent.target.value)} />
          </div>

          <nav
            className="public-registration-step-actions"
            aria-label="Registration steps"
          >
            {currentStepIndex > 0 ? (
              <button
                className="is-back"
                type="button"
                onClick={() => goToStep(registrationSteps[currentStepIndex - 1]!)}
              >
                <ArrowLeft size={17} aria-hidden="true" />
                Back
              </button>
            ) : <span />}
            {currentStep.id !== "review" && (
              <button
                className="is-continue"
                type="button"
                onClick={continueRegistration}
              >
                Continue
                <ArrowRight size={17} aria-hidden="true" />
              </button>
            )}
          </nav>

          {currentStep.id === "review" && (
            <section className="public-registration-submit-card">
              <div><ShieldCheck size={21} aria-hidden="true" /><span><strong>Server-verified registration</strong><small>Pricing and remaining capacity are checked again when you submit.</small></span></div>
              {cardSelected && !joiningWaitlist && <p>Submitting saves the registration first. Your private registration page will then offer secure Square checkout when Sandbox or Production payments are configured.</p>}
              <button type="submit" disabled={submitting}>
                <ClipboardCheck size={19} aria-hidden="true" /> {submitting ? "Submitting…" : joiningWaitlist ? "Join waitlist" : "Submit registration"}
              </button>
            </section>
          )}
        </div>

        <aside className="public-registration-summary" aria-label="Order summary">
          <p className="public-registration-eyebrow">Order summary</p>
          <h2>{joiningWaitlist ? "Your waitlist request" : "Your registration"}</h2>
          {rosterEnabled && <p className="public-registration-summary-roster"><UsersRound size={15} aria-hidden="true" /> {attendees.length} {attendees.length === 1 ? roster.attendeeLabel.toLowerCase() : `${roster.attendeeLabel.toLowerCase()}s`}</p>}
          {calculation.lineItems.length === 0 ? <p className="public-registration-summary-empty">Select any priced options to see your total.</p> : (
            <div className="public-registration-summary-lines">
              {calculation.lineItems.map((item) => (
                <div key={item.key}><span>{item.label}{item.pricingLabel && <small>{item.pricingLabel}</small>}</span><strong>{money(item.amountCents)}</strong></div>
              ))}
              <div><span>Subtotal</span><strong>{money(displayedPreDiscountSubtotalCents)}</strong></div>
              {displayedDiscountCents > 0 && (
                <>
                  <div className="is-discount"><span>Promo code {displayedPromoCode}</span><strong>−{money(displayedDiscountCents)}</strong></div>
                  <div><span>Discounted subtotal</span><strong>{money(calculation.subtotalCents)}</strong></div>
                </>
              )}
              {calculation.processingFeeCents > 0 && <div><span>Card processing</span><strong>{money(calculation.processingFeeCents)}</strong></div>}
              <div className="is-total"><span>{joiningWaitlist ? "Estimated if promoted" : "Total"}</span><strong>{money(joiningWaitlist ? calculation.subtotalCents : calculation.totalCents)}</strong></div>
            </div>
          )}
          <small className="public-registration-pricing-date">Pricing verified for {formatPricingDate(pricingDate)}</small>
          <div className="public-registration-summary-note">{joiningWaitlist ? <Clock3 size={15} aria-hidden="true" /> : <LockKeyhole size={15} aria-hidden="true" />}<span>{joiningWaitlist ? "This estimate is not charged while you are on the waitlist." : "Final pricing and availability are confirmed securely on submission."}</span></div>
        </aside>
      </form>
    </main>
  );
}
