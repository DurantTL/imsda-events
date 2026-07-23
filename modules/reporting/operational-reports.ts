import {
  registrationFormDefinitionSchema,
  type RegistrationFormDefinition,
  type RegistrationFormField,
} from "@/modules/forms/definition";
import { toCsv } from "@/modules/reporting/csv";

export const operationalReportKinds = [
  "roster",
  "meals",
  "housing",
  "seminars",
] as const;

export type OperationalReportKind = typeof operationalReportKinds[number];
export type OperationalReportScope = "REGISTRATION" | "ATTENDEE";

type JsonRecord = Record<string, unknown>;

export type OperationalReportRegistration = {
  id: string;
  confirmationCode: string;
  status: string;
  accountHolder: {
    firstName: string;
    lastName: string;
  };
  attendees: Array<{
    id: string;
    firstName: string;
    lastName: string;
    attendeeType: string;
    position: number;
    responses: JsonRecord;
  }>;
  publicSubmission: {
    responses: JsonRecord;
    attendeeResponses: JsonRecord[];
    definition: unknown;
  } | null;
};

export type OperationalRosterRow = {
  attendeeId: string;
  registrationId: string;
  confirmationCode: string;
  firstName: string;
  lastName: string;
  attendeeType: string;
  accountHolderName: string;
};

export type OperationalRosterGroup = {
  id: string;
  label: string;
  fieldLabel: string | null;
  attendees: OperationalRosterRow[];
};

export type OperationalCountRow = {
  label: string;
  count: number;
};

export type OperationalCountField = {
  id: string;
  label: string;
  scope: OperationalReportScope;
  counts: OperationalCountRow[];
  total: number;
};

export type OperationalSeminarField = {
  id: string;
  label: string;
  scope: OperationalReportScope;
  choices: Array<{
    label: string;
    firstChoice: number;
    secondChoice: number;
    totalInterest: number;
  }>;
  totalInterest: number;
};

export type OperationalReport = {
  summary: {
    activeRegistrations: number;
    attendees: number;
    rosterGroups: number;
    mealSelections: number;
    housingSelections: number;
    seminarInterests: number;
  };
  rosterGroups: OperationalRosterGroup[];
  meals: OperationalCountField[];
  housing: OperationalCountField[];
  seminars: OperationalSeminarField[];
};

type FieldMetadata = {
  field: RegistrationFormField;
  sectionTitle: string;
};

type MutableCountField = {
  id: string;
  label: string;
  scope: OperationalReportScope;
  counts: Map<string, number>;
};

type MutableSeminarField = {
  id: string;
  label: string;
  scope: OperationalReportScope;
  choices: Map<string, {
    firstChoice: number;
    secondChoice: number;
    totalInterest: number;
  }>;
};

const activeStatusSet = new Set(["SUBMITTED", "CONFIRMED"]);
const choiceFieldTypeSet = new Set(["SELECT", "RADIO", "MULTISELECT", "RANKED_CHOICE"]);
const sensitiveSemanticPattern = /\b(?:medical|medication|diagnos\w*|health|allerg\w*|special\s*needs?|accessib\w*|disabil\w*|emergency|injur\w*|condition)\b/i;
const mealSemanticPattern = /\b(?:meal|food|dietary|breakfast|brunch|lunch|supper|dinner|snack)\b/i;
const housingSemanticPattern = /\b(?:housing|lodging|accommodation|overnight|dorm|cabin|campsite|camp\s*site|rv|camper|tent|room|bed|nights?\s+staying)\b/i;
const housingQuantityPattern = /\b(?:count|number|qty|quantity|rooms?|beds?|cabins?|sites?|campsites?|tents?|nights?)\b/i;
const seminarSemanticPattern = /\b(?:seminar|workshop|session|breakout|class|track|program)\b/i;

function normalizeWords(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedIdentity(value: string) {
  return normalizeWords(value).toLocaleLowerCase("en-US");
}

function identifier(value: string) {
  return normalizedIdentity(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72) || "field";
}

function fieldCoreText(field: RegistrationFormField) {
  return normalizeWords(`${field.label} ${field.key}`);
}

function fieldContextText(metadata: FieldMetadata) {
  return normalizeWords(`${fieldCoreText(metadata.field)} ${metadata.sectionTitle}`);
}

function isSensitiveField(metadata: FieldMetadata) {
  return sensitiveSemanticPattern.test(fieldCoreText(metadata.field));
}

function definitionFields(definition: RegistrationFormDefinition): FieldMetadata[] {
  return definition.sections.flatMap((section) => section.fields.map((field) => ({
    field,
    sectionTitle: section.title,
  })));
}

function parseDefinition(value: unknown) {
  const parsed = registrationFormDefinitionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function stringAnswer(value: unknown) {
  if (typeof value !== "string") return null;
  const answer = normalizeWords(value);
  if (!answer || answer.length > 120) return null;
  return answer;
}

function groupingScore(metadata: FieldMetadata) {
  const semantic = fieldCoreText(metadata.field);
  if (/\bclub\b/i.test(semantic)) return 90;
  if (/\bgroup\b/i.test(semantic)) return 80;
  if (/\b(?:church|congregation)\b/i.test(semantic)) return 70;
  if (/\b(?:organization|organisation|ministry|school)\b/i.test(semantic)) return 60;
  if (/\b(?:household|family)\b/i.test(semantic)) return 50;
  return 0;
}

function registrationGrouping(
  fields: FieldMetadata[],
  responses: JsonRecord,
) {
  const candidates = fields
    .filter(({ field }) => (
      field.scope === "REGISTRATION"
      && ["TEXT", "SELECT", "RADIO"].includes(field.type)
    ))
    .filter((metadata) => !isSensitiveField(metadata))
    .map((metadata) => ({
      metadata,
      score: groupingScore(metadata),
      answer: stringAnswer(responses[metadata.field.key]),
    }))
    .filter((candidate) => candidate.score > 0 && candidate.answer)
    .sort((left, right) => (
      right.score - left.score
      || left.metadata.field.label.localeCompare(right.metadata.field.label)
    ));

  const selected = candidates[0];
  if (!selected?.answer) {
    return {
      key: "ungrouped",
      label: "Individual / ungrouped registrations",
      fieldLabel: null,
    };
  }

  return {
    key: `${normalizedIdentity(selected.metadata.field.label)}::${normalizedIdentity(selected.answer)}`,
    label: selected.answer,
    fieldLabel: selected.metadata.field.label,
  };
}

function fieldAggregateKey(field: RegistrationFormField) {
  return `${field.scope}:${normalizedIdentity(field.label)}`;
}

function ensureCountField(
  collection: Map<string, MutableCountField>,
  category: "meals" | "housing",
  field: RegistrationFormField,
) {
  const key = fieldAggregateKey(field);
  let aggregate = collection.get(key);
  if (!aggregate) {
    aggregate = {
      id: `${category}-${field.scope.toLocaleLowerCase("en-US")}-${identifier(field.label)}`,
      label: field.label,
      scope: field.scope,
      counts: new Map(),
    };
    collection.set(key, aggregate);
  }

  if (choiceFieldTypeSet.has(field.type)) {
    for (const option of field.options) {
      if (!aggregate.counts.has(option)) aggregate.counts.set(option, 0);
    }
  } else if (field.type === "NUMBER") {
    if (!aggregate.counts.has("Total requested")) {
      aggregate.counts.set("Total requested", 0);
    }
  } else if (field.type === "CHECKBOX") {
    if (!aggregate.counts.has("Yes")) aggregate.counts.set("Yes", 0);
  }
  return aggregate;
}

function safeQuantity(value: unknown) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity >= 0 && quantity <= 100_000
    ? quantity
    : null;
}

function addStructuredCount(
  aggregate: MutableCountField,
  field: RegistrationFormField,
  value: unknown,
) {
  if (choiceFieldTypeSet.has(field.type)) {
    const selections = Array.isArray(value) ? value : [value];
    const configuredOptions = new Set(field.options);
    for (const selection of selections) {
      if (typeof selection !== "string" || !configuredOptions.has(selection)) continue;
      aggregate.counts.set(selection, (aggregate.counts.get(selection) ?? 0) + 1);
    }
    return;
  }

  if (field.type === "NUMBER") {
    const quantity = safeQuantity(value);
    if (quantity !== null) {
      aggregate.counts.set(
        "Total requested",
        (aggregate.counts.get("Total requested") ?? 0) + quantity,
      );
    }
    return;
  }

  if (field.type === "CHECKBOX" && value === true) {
    aggregate.counts.set("Yes", (aggregate.counts.get("Yes") ?? 0) + 1);
  }
}

function ensureSeminarField(
  collection: Map<string, MutableSeminarField>,
  field: RegistrationFormField,
) {
  const key = fieldAggregateKey(field);
  let aggregate = collection.get(key);
  if (!aggregate) {
    aggregate = {
      id: `seminars-${field.scope.toLocaleLowerCase("en-US")}-${identifier(field.label)}`,
      label: field.label,
      scope: field.scope,
      choices: new Map(),
    };
    collection.set(key, aggregate);
  }
  for (const option of field.options) {
    if (!aggregate.choices.has(option)) {
      aggregate.choices.set(option, {
        firstChoice: 0,
        secondChoice: 0,
        totalInterest: 0,
      });
    }
  }
  return aggregate;
}

function addSeminarRanks(
  aggregate: MutableSeminarField,
  field: RegistrationFormField,
  value: unknown,
) {
  if (!Array.isArray(value)) return;
  const configuredOptions = new Set(field.options);
  value.forEach((selection, index) => {
    if (typeof selection !== "string" || !configuredOptions.has(selection)) return;
    const current = aggregate.choices.get(selection);
    if (!current) return;
    current.totalInterest += 1;
    if (index === 0) current.firstChoice += 1;
    if (index === 1) current.secondChoice += 1;
  });
}

function addResponseFields(
  fields: FieldMetadata[],
  scope: OperationalReportScope,
  responses: JsonRecord,
  mealFields: Map<string, MutableCountField>,
  housingFields: Map<string, MutableCountField>,
  seminarFields: Map<string, MutableSeminarField>,
) {
  for (const metadata of fields) {
    const { field } = metadata;
    if (field.scope !== scope || isSensitiveField(metadata)) continue;

    const structuredType = choiceFieldTypeSet.has(field.type)
      || field.type === "NUMBER"
      || field.type === "CHECKBOX";
    const semantic = fieldContextText(metadata);
    const coreSemantic = fieldCoreText(field);
    const isMealField = field.type === "NUMBER"
      ? mealSemanticPattern.test(coreSemantic)
      : mealSemanticPattern.test(semantic);
    const isHousingField = field.type === "NUMBER"
      ? housingSemanticPattern.test(coreSemantic) && housingQuantityPattern.test(coreSemantic)
      : housingSemanticPattern.test(semantic);

    if (structuredType && isMealField) {
      addStructuredCount(
        ensureCountField(mealFields, "meals", field),
        field,
        responses[field.key],
      );
    }

    if (structuredType && isHousingField) {
      addStructuredCount(
        ensureCountField(housingFields, "housing", field),
        field,
        responses[field.key],
      );
    }

    if (field.type === "RANKED_CHOICE" && seminarSemanticPattern.test(semantic)) {
      addSeminarRanks(
        ensureSeminarField(seminarFields, field),
        field,
        responses[field.key],
      );
    }
  }
}

function finishCountFields(collection: Map<string, MutableCountField>) {
  return [...collection.values()]
    .map((field): OperationalCountField => {
      const counts = [...field.counts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
      return {
        id: field.id,
        label: field.label,
        scope: field.scope,
        counts,
        total: counts.reduce((total, row) => total + row.count, 0),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

function finishSeminarFields(collection: Map<string, MutableSeminarField>) {
  return [...collection.values()]
    .map((field): OperationalSeminarField => {
      const choices = [...field.choices.entries()]
        .map(([label, counts]) => ({ label, ...counts }))
        .sort((left, right) => (
          right.totalInterest - left.totalInterest
          || right.firstChoice - left.firstChoice
          || left.label.localeCompare(right.label)
        ));
      return {
        id: field.id,
        label: field.label,
        scope: field.scope,
        choices,
        totalInterest: choices.reduce((total, choice) => total + choice.totalInterest, 0),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function buildOperationalReport(
  registrations: OperationalReportRegistration[],
): OperationalReport {
  const activeRegistrations = registrations.filter((registration) => (
    activeStatusSet.has(registration.status)
  ));
  const rosterGroups = new Map<string, OperationalRosterGroup>();
  const mealFields = new Map<string, MutableCountField>();
  const housingFields = new Map<string, MutableCountField>();
  const seminarFields = new Map<string, MutableSeminarField>();

  for (const registration of activeRegistrations) {
    const definition = registration.publicSubmission
      ? parseDefinition(registration.publicSubmission.definition)
      : null;
    const fields = definition ? definitionFields(definition) : [];
    const registrationResponses = registration.publicSubmission?.responses ?? {};
    const grouping = registrationGrouping(fields, registrationResponses);
    let group = rosterGroups.get(grouping.key);
    if (!group) {
      group = {
        id: `roster-${identifier(grouping.key)}`,
        label: grouping.label,
        fieldLabel: grouping.fieldLabel,
        attendees: [],
      };
      rosterGroups.set(grouping.key, group);
    }

    const accountHolderName = normalizeWords(
      `${registration.accountHolder.firstName} ${registration.accountHolder.lastName}`,
    );
    for (const attendee of registration.attendees) {
      group.attendees.push({
        attendeeId: attendee.id,
        registrationId: registration.id,
        confirmationCode: registration.confirmationCode,
        firstName: attendee.firstName,
        lastName: attendee.lastName,
        attendeeType: attendee.attendeeType,
        accountHolderName,
      });
    }

    if (!definition || !registration.publicSubmission) continue;
    addResponseFields(
      fields,
      "REGISTRATION",
      registrationResponses,
      mealFields,
      housingFields,
      seminarFields,
    );

    registration.attendees.forEach((attendee, index) => {
      const immutableResponses = registration.publicSubmission?.attendeeResponses[index]
        ?? attendee.responses
        ?? {};
      addResponseFields(
        fields,
        "ATTENDEE",
        immutableResponses,
        mealFields,
        housingFields,
        seminarFields,
      );
    });
  }

  const finishedRosterGroups = [...rosterGroups.values()]
    .map((group) => ({
      ...group,
      attendees: group.attendees.sort((left, right) => (
        left.lastName.localeCompare(right.lastName)
        || left.firstName.localeCompare(right.firstName)
        || left.confirmationCode.localeCompare(right.confirmationCode)
      )),
    }))
    .sort((left, right) => {
      if (left.fieldLabel === null && right.fieldLabel !== null) return 1;
      if (left.fieldLabel !== null && right.fieldLabel === null) return -1;
      return left.label.localeCompare(right.label);
    });
  const meals = finishCountFields(mealFields);
  const housing = finishCountFields(housingFields);
  const seminars = finishSeminarFields(seminarFields);

  return {
    summary: {
      activeRegistrations: activeRegistrations.length,
      attendees: finishedRosterGroups.reduce(
        (total, group) => total + group.attendees.length,
        0,
      ),
      rosterGroups: finishedRosterGroups.filter((group) => group.fieldLabel !== null).length,
      mealSelections: meals.reduce((total, field) => total + field.total, 0),
      housingSelections: housing.reduce((total, field) => total + field.total, 0),
      seminarInterests: seminars.reduce((total, field) => total + field.totalInterest, 0),
    },
    rosterGroups: finishedRosterGroups,
    meals,
    housing,
    seminars,
  };
}

function scopeLabel(scope: OperationalReportScope) {
  return scope === "ATTENDEE" ? "Each attendee" : "Each registration";
}

export function operationalReportCsv(
  report: OperationalReport,
  kind: OperationalReportKind,
) {
  if (kind === "roster") {
    const rows: Array<Array<string | number>> = [[
      "Group",
      "Group field",
      "Confirmation code",
      "Attendee last name",
      "Attendee first name",
      "Attendee type",
      "Account holder",
    ]];
    for (const group of report.rosterGroups) {
      for (const attendee of group.attendees) {
        rows.push([
          group.label,
          group.fieldLabel ?? "",
          attendee.confirmationCode,
          attendee.lastName,
          attendee.firstName,
          attendee.attendeeType,
          attendee.accountHolderName,
        ]);
      }
    }
    return toCsv(rows);
  }

  if (kind === "seminars") {
    const rows: Array<Array<string | number>> = [[
      "Ranked field",
      "Applies to",
      "Option",
      "First choice",
      "Second choice",
      "Total interest",
    ]];
    for (const field of report.seminars) {
      for (const choice of field.choices) {
        rows.push([
          field.label,
          scopeLabel(field.scope),
          choice.label,
          choice.firstChoice,
          choice.secondChoice,
          choice.totalInterest,
        ]);
      }
    }
    return toCsv(rows);
  }

  const fields = kind === "meals" ? report.meals : report.housing;
  const rows: Array<Array<string | number>> = [[
    "Field",
    "Applies to",
    "Choice or quantity",
    "Count",
  ]];
  for (const field of fields) {
    for (const count of field.counts) {
      rows.push([
        field.label,
        scopeLabel(field.scope),
        count.label,
        count.count,
      ]);
    }
  }
  return toCsv(rows);
}
