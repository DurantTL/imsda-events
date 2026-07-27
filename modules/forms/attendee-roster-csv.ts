import type {
  RegistrationFormDefinition,
  RegistrationFormField,
} from "@/modules/forms/definition";

export type AttendeeRosterCsvValue = string | boolean | string[];
export type AttendeeRosterCsvResponses = Record<string, AttendeeRosterCsvValue>;

export class AttendeeRosterCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendeeRosterCsvError";
  }
}

function attendeeFields(definition: RegistrationFormDefinition) {
  return definition.sections
    .flatMap((section) => section.fields)
    .filter((field) => field.scope === "ATTENDEE" && field.type !== "CALCULATED");
}

function escapeCsvCell(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function createAttendeeRosterCsvTemplate(
  definition: RegistrationFormDefinition,
) {
  return `${attendeeFields(definition).map((field) => escapeCsvCell(field.key)).join(",")}\n`;
}

function parseCsvRows(csv: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"') {
      if (cell.length > 0) {
        throw new AttendeeRosterCsvError("A quoted CSV value must begin at the start of its cell.");
      }
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") {
      cell += character;
    }
  }

  if (quoted) {
    throw new AttendeeRosterCsvError("The CSV contains a quoted value that is not closed.");
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((value) => value.trim().length > 0));
}

function normalizeHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function canonicalChoice(field: RegistrationFormField, rawValue: string, rowNumber: number) {
  const match = field.options.find((option) => option.toLowerCase() === rawValue.trim().toLowerCase());
  if (!match) {
    throw new AttendeeRosterCsvError(
      `Row ${rowNumber}: “${rawValue.trim()}” is not a valid choice for ${field.label}. Use one of: ${field.options.join(", ")}.`,
    );
  }
  return match;
}

function convertValue(field: RegistrationFormField, rawValue: string, rowNumber: number) {
  const value = rawValue.trim();
  if (!value) return undefined;

  if (field.type === "CHECKBOX") {
    if (/^(yes|true|1|y)$/i.test(value)) return true;
    if (/^(no|false|0|n)$/i.test(value)) return false;
    throw new AttendeeRosterCsvError(
      `Row ${rowNumber}: ${field.label} must be Yes or No.`,
    );
  }
  if (field.type === "SELECT" || field.type === "RADIO") {
    return canonicalChoice(field, value, rowNumber);
  }
  if (field.type === "MULTISELECT" || field.type === "RANKED_CHOICE") {
    const choices = value
      .split("|")
      .map((choice) => choice.trim())
      .filter(Boolean)
      .map((choice) => canonicalChoice(field, choice, rowNumber));
    if (new Set(choices).size !== choices.length) {
      throw new AttendeeRosterCsvError(
        `Row ${rowNumber}: ${field.label} contains the same choice more than once.`,
      );
    }
    if (field.minSelections && choices.length < field.minSelections) {
      throw new AttendeeRosterCsvError(
        `Row ${rowNumber}: ${field.label} needs at least ${field.minSelections} choices.`,
      );
    }
    if (field.maxSelections && choices.length > field.maxSelections) {
      throw new AttendeeRosterCsvError(
        `Row ${rowNumber}: ${field.label} allows at most ${field.maxSelections} choices.`,
      );
    }
    return choices;
  }
  if (field.type === "NUMBER" && !Number.isFinite(Number(value))) {
    throw new AttendeeRosterCsvError(
      `Row ${rowNumber}: ${field.label} must be a number.`,
    );
  }
  return value;
}

export function parseAttendeeRosterCsv(
  csv: string,
  definition: RegistrationFormDefinition,
) {
  const rows = parseCsvRows(csv.replace(/^\uFEFF/, ""));
  if (rows.length < 2) {
    throw new AttendeeRosterCsvError(
      "Add at least one attendee row below the CSV header.",
    );
  }

  const fields = attendeeFields(definition);
  const aliases = new Map<string, RegistrationFormField>();
  for (const field of fields) {
    aliases.set(normalizeHeader(field.key), field);
    aliases.set(normalizeHeader(field.label), field);
  }

  const mappedFields = rows[0].map((header) => {
    const field = aliases.get(normalizeHeader(header));
    if (!field) {
      throw new AttendeeRosterCsvError(
        `The CSV column “${header.trim() || "(blank)"}” does not match an attendee field. Download a fresh template and keep its headers.`,
      );
    }
    return field;
  });
  const duplicateField = mappedFields.find((field, index) => (
    mappedFields.findIndex((candidate) => candidate.key === field.key) !== index
  ));
  if (duplicateField) {
    throw new AttendeeRosterCsvError(
      `The CSV contains more than one column for ${duplicateField.label}.`,
    );
  }

  const mappedKeys = new Set(mappedFields.map((field) => field.key));
  const missingRequired = fields.find((field) => (
    field.required && !field.conditional && !mappedKeys.has(field.key)
  ));
  if (missingRequired) {
    throw new AttendeeRosterCsvError(
      `The required attendee column “${missingRequired.key}” is missing. Download a fresh template and keep its headers.`,
    );
  }

  const roster = definition.attendeeRoster;
  const dataRows = rows.slice(1);
  const maxAttendees = roster?.enabled ? roster.maxAttendees : 1;
  const minAttendees = roster?.enabled ? roster.minAttendees : 1;
  if (dataRows.length > maxAttendees) {
    throw new AttendeeRosterCsvError(
      `This form allows at most ${maxAttendees} attendees, but the CSV contains ${dataRows.length}.`,
    );
  }
  if (dataRows.length < minAttendees) {
    throw new AttendeeRosterCsvError(
      `This form requires at least ${minAttendees} attendees.`,
    );
  }

  return dataRows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const responses: AttendeeRosterCsvResponses = {};
    mappedFields.forEach((field, columnIndex) => {
      const rawValue = row[columnIndex] ?? "";
      if (field.required && !field.conditional && !rawValue.trim()) {
        throw new AttendeeRosterCsvError(
          `Row ${rowNumber}: ${field.label} is required.`,
        );
      }
      const value = convertValue(field, rawValue, rowNumber);
      if (value !== undefined) responses[field.key] = value;
    });
    return responses;
  });
}
