import { createImportSnapshotIdentity, CsvImportError, parseCsvMatrix, type NormalizedImportData, type ParsedImportRow } from "@/modules/imports/csv-parser";

export type Wr26BundleFile = {
  name: string;
  text: string;
};

type CsvTable = {
  headers: string[];
  rows: Array<Record<string, string>>;
};

const supportedSheets = [
  "registrations",
  "attendees",
  "seminars",
  "seminarpreferences",
  "waitlist",
  "promocodes",
  "refunds",
  "checkins",
  "transferlog",
] as const;

// Included in the snapshot identity so a parser correction creates a fresh
// preview for the same source files instead of reusing normalized data written
// by an older parser.
const WR26_BUNDLE_PARSER_VERSION = 2;

function sheetKey(fileName: string) {
  return fileName
    .replace(/^.*[\\/]/, "")
    .replace(/\.csv$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function headerKey(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function parseTable(text: string): CsvTable {
  const matrix = parseCsvMatrix(text);
  const headers = matrix[0].map(headerKey);
  const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicates.length > 0) {
    throw new CsvImportError("INVALID_CSV", `Duplicate WR26 column: ${duplicates[0]}.`);
  }
  return {
    headers,
    rows: matrix.slice(1)
      .filter((values) => values.some((value) => value.trim() !== ""))
      .map((values) => Object.fromEntries(
        headers.map((header, index) => [header, values[index]?.trim() ?? ""]),
      )),
  };
}

function requireColumns(table: CsvTable, sheet: string, columns: string[]) {
  const missing = columns.filter((column) => !table.headers.includes(headerKey(column)));
  if (missing.length > 0) {
    throw new CsvImportError(
      "MISSING_COLUMNS",
      `${sheet}.csv is missing: ${missing.join(", ")}.`,
    );
  }
}

function cell(row: Record<string, string>, name: string) {
  return row[headerKey(name)] ?? "";
}

function cents(value: string) {
  const normalized = value.trim().replaceAll("$", "").replaceAll(",", "");
  const amount = Number(normalized || 0);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : 0;
}

function nonNegativeNumber(value: string) {
  const normalized = value
    .trim()
    .replaceAll("$", "")
    .replaceAll(",", "")
    .replaceAll("%", "");
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function money(centsValue: number) {
  return `$${(centsValue / 100).toFixed(2)}`;
}

function isoDate(value: string) {
  if (!value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function calendarDate(value: string) {
  const parsed = isoDate(value);
  return parsed?.slice(0, 10) ?? null;
}

function yes(value: string) {
  return ["true", "yes", "y", "1", "checked"].includes(value.trim().toLowerCase());
}

function registrationStatus(value: string): NormalizedImportData["status"] {
  const status = value.trim().toLowerCase();
  if (["cancelled", "canceled", "transferred", "inactive", "removed"].includes(status)) return "CANCELLED";
  if (["draft", "pending"].includes(status)) return "SUBMITTED";
  if (["waitlisted", "waiting"].includes(status)) return "WAITLISTED";
  return "CONFIRMED";
}

function attendeeType(value: string): "ATTENDEE" | "WORKER" | "CHILD" {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("worker") || normalized.includes("volunteer")) return "WORKER";
  if (normalized.includes("child")) return "CHILD";
  return "ATTENDEE";
}

function paymentStatus(value: string): "PENDING" | "SUCCEEDED" | "FAILED" | "VOIDED" {
  const normalized = value.trim().toLowerCase();
  if (["paid", "paid_onsite", "succeeded", "complete", "completed", "partial_refund", "refunded"].includes(normalized)) return "SUCCEEDED";
  if (["failed", "declined"].includes(normalized)) return "FAILED";
  if (["void", "voided", "cancelled", "canceled"].includes(normalized)) return "VOIDED";
  return "PENDING";
}

function paymentMethod(value: string): "CARD_REFERENCE" | "CASH" | "CHECK" | "MANUAL" {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("square") || normalized.includes("card")) return "CARD_REFERENCE";
  if (normalized.includes("cash")) return "CASH";
  if (normalized.includes("check")) return "CHECK";
  return "MANUAL";
}

function refundStatus(value: string): "PENDING" | "SUCCEEDED" | "FAILED" {
  const normalized = value.trim().toLowerCase();
  if (["failed", "declined"].includes(normalized)) return "FAILED";
  if (["pending", "requested", "processing"].includes(normalized)) return "PENDING";
  return "SUCCEEDED";
}

function waitlistStatus(value: string): "WAITING" | "PROMOTED" | "REMOVED" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "promoted") return "PROMOTED";
  if (["removed", "cancelled", "canceled"].includes(normalized)) return "REMOVED";
  return "WAITING";
}

function groupBy<T>(items: T[], keyFor: (item: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function countsBy<T>(items: T[], keyFor: (item: T) => string) {
  return Object.fromEntries(
    [...items.reduce((counts, item) => {
      const key = keyFor(item) || "(blank)";
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts;
    }, new Map<string, number>()).entries()]
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function seminarFieldKey(slot: string) {
  const normalized = slot.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return normalized.endsWith("_preferences") ? normalized : `${normalized}_preferences`;
}

function formChoice(value: string, choices: Record<string, string>) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return choices[normalized] ?? value.trim();
}

function attendeeFormType(value: string) {
  return formChoice(value, {
    adult: "Adult",
    teen: "Teen",
    teenager: "Teen",
    youth: "Teen",
    child: "Child",
    worker: "Adult",
    volunteer: "Adult",
  });
}

function mealFormChoice(value: string) {
  return formChoice(value, {
    regular: "Standard",
    standard: "Standard",
    vegetarian: "Vegetarian",
    vegan: "Vegan",
    gluten_free: "Gluten-free",
    glutenfree: "Gluten-free",
    other: "Other",
  });
}

function yesNoFormChoice(value: string) {
  return formChoice(value, {
    no: "No",
    false: "No",
    n: "No",
    "0": "No",
    yes: "Yes",
    true: "Yes",
    y: "Yes",
    "1": "Yes",
  });
}

function paymentFormChoice(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.includes("square") || normalized.includes("card")
    ? "Credit / debit card"
    : "Pay later";
}

export function parseWr26Bundle(
  files: Wr26BundleFile[],
  eventId: string,
  maxRegistrations = 2_000,
) {
  const tables = new Map<string, CsvTable>();
  for (const file of files) {
    const key = sheetKey(file.name);
    if (!(supportedSheets as readonly string[]).includes(key)) continue;
    if (tables.has(key)) {
      throw new CsvImportError("INVALID_CSV", `More than one ${key}.csv file was supplied.`);
    }
    tables.set(key, parseTable(file.text));
  }

  const registrations = tables.get("registrations");
  const attendees = tables.get("attendees");
  if (!registrations || !attendees) {
    throw new CsvImportError(
      "MISSING_COLUMNS",
      "A WR26 bundle requires Registrations.csv and Attendees.csv.",
    );
  }
  requireColumns(registrations, "Registrations", ["Registration ID", "First Name", "Last Name", "Email", "Final Amount", "Status"]);
  requireColumns(attendees, "Attendees", ["Attendee ID", "Registration ID", "First Name", "Last Name"]);
  if (registrations.rows.length > maxRegistrations) {
    throw new CsvImportError("TOO_MANY_ROWS", `This WR26 bundle contains more than ${maxRegistrations.toLocaleString()} registrations.`);
  }

  const seminarPreferenceRows = tables.get("seminarpreferences")?.rows ?? [];
  const attendeesByRegistration = groupBy(attendees.rows, (row) => cell(row, "Registration ID"));
  const attendeeById = new Map<string, Record<string, string>>();
  const duplicateAttendeeIds = new Set<string>();
  for (const attendee of attendees.rows) {
    const attendeeId = cell(attendee, "Attendee ID");
    if (!attendeeId) continue;
    if (attendeeById.has(attendeeId)) duplicateAttendeeIds.add(attendeeId);
    attendeeById.set(attendeeId, attendee);
  }
  const matchedPreferenceRows = seminarPreferenceRows.filter((preference) => {
    const attendee = attendeeById.get(cell(preference, "Attendee ID"));
    return attendee
      && cell(preference, "Registration ID") === cell(attendee, "Registration ID");
  });
  const stalePreferenceRows = seminarPreferenceRows.length - matchedPreferenceRows.length;
  const preferencesByAttendee = groupBy(
    matchedPreferenceRows,
    (row) => cell(row, "Attendee ID"),
  );
  const refundsByRegistration = groupBy(tables.get("refunds")?.rows ?? [], (row) => cell(row, "Registration ID"));
  const checkInsByRegistration = groupBy(tables.get("checkins")?.rows ?? [], (row) => cell(row, "Registration ID"));
  const transfersByRegistration = groupBy(
    tables.get("transferlog")?.rows ?? [],
    (row) => cell(row, "Original Reg ID"),
  );
  const registrationIds = new Set(registrations.rows.map((row) => cell(row, "Registration ID")));
  const legacySeminarCatalog = (tables.get("seminars")?.rows ?? []).flatMap((seminar) => {
    const title = cell(seminar, "Seminar Title");
    if (!title) return [];
    return [{
      slot: cell(seminar, "Slot"),
      slotLabel: cell(seminar, "Slot Label"),
      title,
      capacity: Math.max(0, Number(cell(seminar, "Capacity") || 0)),
      assignedCount: Math.max(0, Number(cell(seminar, "Assigned Count") || 0)),
      isActive: !["false", "no", "0", "inactive"].includes(cell(seminar, "Active").toLowerCase()),
      notes: cell(seminar, "Notes"),
    }];
  });
  let invalidPromoCodeRows = 0;
  const legacyPromoCodes = (tables.get("promocodes")?.rows ?? []).flatMap((promo) => {
    const code = cell(promo, "Code").trim().toUpperCase();
    if (!code) return [];
    const type = cell(promo, "Discount Type").toLowerCase();
    const amount = nonNegativeNumber(cell(promo, "Discount Amount"));
    if (amount === null) {
      invalidPromoCodeRows += 1;
      return [];
    }
    const percentage = type.includes("percent");
    const maximumUses = nonNegativeNumber(cell(promo, "Max Uses"));
    const redeemedCount = nonNegativeNumber(cell(promo, "Current Uses"));
    return [{
      code,
      description: cell(promo, "Description"),
      discountType: percentage ? "PERCENT_BPS" as const : "FIXED_CENTS" as const,
      // Dollar amounts become cents; percentage values become basis points.
      // Both use a factor of 100, but the separate domain names above keep
      // formatted inputs such as "$25.00" and "20%" finite before JSON storage.
      discountValue: Math.round(amount * 100),
      maximumUses: maximumUses === null ? null : Math.round(maximumUses),
      redeemedCount: Math.round(redeemedCount ?? 0),
      endsOn: calendarDate(cell(promo, "Expiry Date")),
      isActive: !["false", "no", "0", "inactive"].includes(cell(promo, "Active").toLowerCase()),
      minimumSubtotalCents: cell(promo, "Min Purchase") ? cents(cell(promo, "Min Purchase")) : null,
    }];
  });
  const sourceIds = new Set<string>();
  const confirmationCodes = new Set<string>();
  const legacyTestPaymentRows = registrations.rows.filter(
    (row) => cell(row, "Payment Method").trim().toLowerCase() === "test",
  ).length;
  const paidAmountMismatchRows = registrations.rows.filter((registration) => {
    const normalizedStatus = paymentStatus(cell(registration, "Payment Status"));
    return normalizedStatus === "SUCCEEDED"
      && cents(cell(registration, "Amount Paid")) !== cents(cell(registration, "Final Amount"));
  }).length;
  const attendeeHeaders = new Set(attendees.headers);
  const shirtSizeHeader = [
    "shirtsize",
    "tshirtsize",
    "conventionshirtsize",
  ].find((header) => attendeeHeaders.has(header)) ?? null;

  const rows: ParsedImportRow[] = registrations.rows.map((registration, index) => {
    const warnings: string[] = [];
    const errors: string[] = [];
    const sourceId = cell(registration, "Registration ID");
    const confirmationCode = sourceId.toUpperCase();
    const firstName = cell(registration, "First Name");
    const lastName = cell(registration, "Last Name");
    const email = cell(registration, "Email").toLowerCase();
    const submittedAt = isoDate(cell(registration, "Timestamp"));
    if (!sourceId) errors.push("Registration ID is required.");
    if (sourceIds.has(sourceId)) errors.push(`Duplicate Registration ID: ${sourceId}.`);
    sourceIds.add(sourceId);
    if (confirmationCodes.has(confirmationCode)) errors.push(`Duplicate confirmation code: ${confirmationCode}.`);
    confirmationCodes.add(confirmationCode);
    if (!firstName) errors.push("Registration first name is required.");
    if (!lastName) errors.push("Registration last name is required.");
    if (!email) warnings.push("No email is available for identity matching.");

    const registrationAttendees = attendeesByRegistration.get(sourceId) ?? [];
    if (registrationAttendees.length === 0) {
      warnings.push("No Attendees row was found; the primary contact will be used as the attendee.");
    }
    if (index === 0 && stalePreferenceRows > 0) {
      warnings.push(
        `${stalePreferenceRows} stale SeminarPreferences row${stalePreferenceRows === 1 ? "" : "s"} referenced attendees outside the current Attendees roster and were excluded.`,
      );
    }
    if (index === 0 && legacyTestPaymentRows > 0) {
      warnings.push(
        `${legacyTestPaymentRows} registration${legacyTestPaymentRows === 1 ? "" : "s"} use the legacy payment method “test”; the method is retained in audit data and imported as a manual payment reference.`,
      );
    }
    if (index === 0 && paidAmountMismatchRows > 0) {
      warnings.push(
        `${paidAmountMismatchRows} paid registration${paidAmountMismatchRows === 1 ? "" : "s"} have a recorded Amount Paid that differs from Final Amount. Paid status is authoritative, and both amounts remain in the migration audit data.`,
      );
    }
    if (index === 0 && !shirtSizeHeader) {
      warnings.push(
        "The Attendees sheet has no shirt-size column. Shirt sizes must be collected or reconfirmed after migration.",
      );
    }
    if (index === 0 && invalidPromoCodeRows > 0) {
      warnings.push(
        `${invalidPromoCodeRows} promo code row${invalidPromoCodeRows === 1 ? "" : "s"} had an invalid discount amount and were excluded.`,
      );
    }
    const normalizedAttendees = (registrationAttendees.length > 0 ? registrationAttendees : [{
      attendeeid: `${sourceId}-1`,
      registrationid: sourceId,
      firstname: firstName,
      lastname: lastName,
      email,
      phone: cell(registration, "Phone"),
      church: cell(registration, "Church"),
    }]).map((attendee, attendeeIndex) => {
      const attendeeSourceId = cell(attendee, "Attendee ID") || `${sourceId}-${attendeeIndex + 1}`;
      if (duplicateAttendeeIds.has(attendeeSourceId)) {
        errors.push(`Duplicate Attendee ID: ${attendeeSourceId}.`);
      }
      const attendeeEmail = cell(attendee, "Email").toLowerCase();
      const mayUsePrimaryContactName = registrationAttendees.length === 1
        && (!attendeeEmail || attendeeEmail === email);
      const attendeeFirstName = cell(attendee, "First Name")
        || (mayUsePrimaryContactName ? firstName : "");
      const attendeeLastName = cell(attendee, "Last Name")
        || (mayUsePrimaryContactName ? lastName : "");
      if (
        mayUsePrimaryContactName
        && (
          !cell(attendee, "First Name")
          || !cell(attendee, "Last Name")
        )
        && attendeeFirstName
        && attendeeLastName
      ) {
        warnings.push(
          `Attendee ${attendeeSourceId} had an incomplete name; the matching primary-contact name was used.`,
        );
      }
      if (!attendeeFirstName || !attendeeLastName) {
        errors.push(`Attendee ${attendeeSourceId} needs both a first and last name.`);
      }
      const preferences = preferencesByAttendee.get(attendeeSourceId) ?? [];
      const rankedByField = new Map<string, Array<{ rank: number; title: string }>>();
      for (const preference of preferences) {
        const title = cell(preference, "Seminar Title");
        if (!title) continue;
        const slot = cell(preference, "Session Slot").trim().toLowerCase();
        if (slot === "session_4") continue;
        const key = seminarFieldKey(slot);
        rankedByField.set(key, [
          ...(rankedByField.get(key) ?? []),
          { rank: Number(cell(preference, "Preference Rank") || 1), title },
        ]);
      }
      const formResponses: Record<string, string | boolean | string[]> = {
        first_name: attendeeFirstName,
        last_name: attendeeLastName,
      };
      const shirtSize = shirtSizeHeader ? attendee[shirtSizeHeader] ?? "" : "";
      const optionalResponses: Array<[string, string | boolean]> = [
        ["attendee_phone", cell(attendee, "Phone")],
        ["attendee_email", cell(attendee, "Email")],
        ["attendee_type", attendeeFormType(cell(attendee, "Adult/Child"))],
        ["shirt_size", shirtSize],
        ["meal_preference", mealFormChoice(cell(attendee, "Meal Preference"))],
        ["dietary_needs", cell(attendee, "Dietary Needs")],
        ["childcare_needed", yesNoFormChoice(cell(attendee, "Childcare Needed"))],
        ["childcare_children", cell(attendee, "Children Needing Care")],
        ["volunteer", yesNoFormChoice(cell(attendee, "Volunteer"))],
        ["attendee_notes", cell(attendee, "Notes")],
      ];
      for (const [key, value] of optionalResponses) {
        if (value !== "") formResponses[key] = value;
      }
      for (const [key, choices] of rankedByField) {
        formResponses[key] = choices.sort((left, right) => left.rank - right.rank).map((choice) => choice.title);
      }
      if (preferences.some((preference) => (
        cell(preference, "Session Slot").trim().toLowerCase() === "session_4"
        && Boolean(cell(preference, "Seminar Title"))
      ))) {
        formResponses.session_4_attendance = "Attending";
      }
      const assignments = preferences.filter((preference) => cell(preference, "Assigned Seminar")).map((preference) => ({
        slot: cell(preference, "Session Slot"),
        assigned: cell(preference, "Assigned Seminar"),
        status: cell(preference, "Assignment Status"),
      }));
      const legacySeminarPreferences = preferences.map((preference) => ({
        preferenceId: cell(preference, "Preference ID"),
        registrationId: cell(preference, "Registration ID"),
        attendeeId: cell(preference, "Attendee ID"),
        attendeeName: cell(preference, "Attendee Name"),
        slot: cell(preference, "Session Slot"),
        rank: Number(cell(preference, "Preference Rank") || 1),
        title: cell(preference, "Seminar Title"),
        seminarId: cell(preference, "Seminar ID"),
        assigned: cell(preference, "Assigned Seminar"),
        status: cell(preference, "Assignment Status"),
        notes: cell(preference, "Notes"),
      }));
      return {
        sourceId: attendeeSourceId,
        firstName: attendeeFirstName,
        lastName: attendeeLastName,
        email: attendeeEmail,
        phone: cell(attendee, "Phone"),
        attendeeType: attendeeType(cell(attendee, "Adult/Child")),
        profileSnapshot: {
          sourceId: attendeeSourceId,
          church: cell(attendee, "Church") || cell(registration, "Church"),
          legacyAttendeeType: cell(attendee, "Adult/Child"),
          seminarPreferencesComplete: cell(attendee, "Seminar Preferences Complete"),
          legacySeminarPreferences: legacySeminarPreferences.length > 0 ? JSON.stringify(legacySeminarPreferences) : "",
          legacySeminarAssignments: assignments.length > 0 ? JSON.stringify(assignments) : "",
        },
        formResponses,
      };
    });

    const refunds = (refundsByRegistration.get(sourceId) ?? []).map((refund, refundIndex) => ({
      sourceId: cell(refund, "Refund ID") || `${sourceId}-refund-${refundIndex + 1}`,
      amountCents: cents(cell(refund, "Amount")),
      status: refundStatus(cell(refund, "Status")),
      reason: [cell(refund, "Reason"), cell(refund, "Notes")].filter(Boolean).join(" — "),
    }));
    const finalAmountCents = cents(cell(registration, "Final Amount"));
    const recordedAmountPaid = cell(registration, "Amount Paid");
    const recordedAmountPaidCents = cents(recordedAmountPaid);
    const normalizedPaymentStatus = paymentStatus(cell(registration, "Payment Status"));
    const succeededRefundCents = refunds
      .filter((refund) => refund.status === "SUCCEEDED")
      .reduce((sum, refund) => sum + refund.amountCents, 0);
    const requiredGrossPaidCents = finalAmountCents + succeededRefundCents;
    const amountPaidCents = normalizedPaymentStatus === "SUCCEEDED"
      ? requiredGrossPaidCents
      : recordedAmountPaidCents;
    if (
      normalizedPaymentStatus === "SUCCEEDED"
      && recordedAmountPaidCents !== requiredGrossPaidCents
    ) {
      warnings.push(
        `Payment status is paid, so the imported successful payment will cover the full final amount; the source recorded ${money(recordedAmountPaidCents)} and the reconciled gross payment is ${money(amountPaidCents)}.`,
      );
    }
    const squarePaymentId = cell(registration, "Square Payment ID");
    const payment = amountPaidCents > 0 || refunds.length > 0
      ? {
          sourceId: squarePaymentId || `${sourceId}-legacy-payment`,
          amountCents: Math.max(amountPaidCents, refunds.reduce((sum, refund) => sum + refund.amountCents, 0)),
          status: normalizedPaymentStatus,
          method: paymentMethod(cell(registration, "Payment Method")),
          externalReference: squarePaymentId || `wr26:${sourceId}`,
          receivedAt: normalizedPaymentStatus === "SUCCEEDED" ? submittedAt : null,
        }
      : null;
    const checkIns = (checkInsByRegistration.get(sourceId) ?? []).flatMap((checkIn, checkInIndex) => {
      const checkedInAt = isoDate(cell(checkIn, "Timestamp"));
      return checkedInAt ? [{
        sourceId: cell(checkIn, "Check-In ID") || `${sourceId}-checkin-${checkInIndex + 1}`,
        checkedInAt,
        method: cell(checkIn, "Method") || "legacy",
        actor: cell(checkIn, "Admin User"),
      }] : [];
    });
    const registrationCheckedInAt = isoDate(cell(registration, "Check-In Time"));
    if (checkIns.length === 0 && yes(cell(registration, "Checked In")) && registrationCheckedInAt) {
      checkIns.push({
        sourceId: `${sourceId}-registration-checkin`,
        checkedInAt: registrationCheckedInAt,
        method: "legacy_registration",
        actor: cell(registration, "Check-In By"),
      });
    }

    const data: NormalizedImportData | null = errors.length > 0 ? null : {
      sourceId,
      confirmationCode,
      firstName,
      lastName,
      email,
      phone: cell(registration, "Phone"),
      attendeeType: normalizedAttendees[0]?.attendeeType ?? "ATTENDEE",
      status: registrationStatus(cell(registration, "Status")),
      totalAmountCents: finalAmountCents,
      submittedAt,
      contactSnapshot: {
        sourceSystem: "WR26_GOOGLE_SHEETS",
        sourceId,
        church: cell(registration, "Church"),
        arrivalDate: cell(registration, "Arrival Date"),
        departureDate: cell(registration, "Departure Date"),
        dietaryNeeds: cell(registration, "Dietary Needs"),
        emergencyContactName: cell(registration, "Emergency Contact Name"),
        emergencyContactPhone: cell(registration, "Emergency Contact Phone"),
        specialNeeds: cell(registration, "Special Needs"),
        promoCode: cell(registration, "Promo Code") || cell(registration, "Coupon Used"),
        legacyPromoCode: cell(registration, "Promo Code"),
        legacyCouponUsed: cell(registration, "Coupon Used"),
        discountAmountCents: cents(cell(registration, "Discount Amount")),
        originalAmountCents: cents(cell(registration, "Original Amount")),
        paymentMethod: cell(registration, "Payment Method"),
        paymentFormChoice: paymentFormChoice(cell(registration, "Payment Method")),
        paymentStatus: cell(registration, "Payment Status"),
        recordedAmountPaidCents,
        importedPaymentAmountCents: amountPaidCents,
        paymentAmountReconciled: normalizedPaymentStatus === "SUCCEEDED"
          && recordedAmountPaidCents !== requiredGrossPaidCents,
        ffEntryId: cell(registration, "FF Entry ID"),
        transferNotes: cell(registration, "Transfer Notes"),
        adminNotes: cell(registration, "Admin Notes"),
        checkedIn: cell(registration, "Checked In"),
        checkInTime: cell(registration, "Check-In Time"),
        checkInBy: cell(registration, "Check-In By"),
      },
      attendees: normalizedAttendees,
      payment,
      refunds,
      checkIns,
      legacyHistory: {
        transfers: (transfersByRegistration.get(sourceId) ?? []).map((transfer) => ({
          transferId: cell(transfer, "Transfer ID"),
          timestamp: cell(transfer, "Timestamp"),
          originalRegistrationId: cell(transfer, "Original Reg ID"),
          newRegistrationId: cell(transfer, "New Reg ID"),
          originalName: cell(transfer, "Original Name"),
          newName: cell(transfer, "New Name"),
          reason: cell(transfer, "Reason"),
          transferredBy: cell(transfer, "Transferred By"),
        })),
      },
      ...(index === 0 && legacyPromoCodes.length > 0 ? { legacyPromoCodes } : {}),
    };
    return {
      sourceRow: index + 2,
      raw: registration,
      data,
      warnings,
      errors,
    };
  });

  const waitlistRows = tables.get("waitlist")?.rows ?? [];
  const waitlistPositions = new Map(
    [...waitlistRows]
      .sort((left, right) => {
        const leftWaiting = waitlistStatus(cell(left, "Status")) === "WAITING" ? 0 : 1;
        const rightWaiting = waitlistStatus(cell(right, "Status")) === "WAITING" ? 0 : 1;
        return leftWaiting - rightWaiting
          || Number(cell(left, "Position") || 0) - Number(cell(right, "Position") || 0);
      })
      .map((row, index) => [row, index + 1]),
  );
  for (const [index, waitlist] of waitlistRows.entries()) {
    const sourceId = cell(waitlist, "Waitlist ID");
    const linkedRegistrationId = cell(waitlist, "Registration ID");
    if (!sourceId || (linkedRegistrationId && registrationIds.has(linkedRegistrationId))) continue;
    const firstName = cell(waitlist, "First Name");
    const lastName = cell(waitlist, "Last Name");
    const confirmationCode = `WL-${sourceId}`.toUpperCase();
    const warnings: string[] = [];
    const errors: string[] = [];
    if (!firstName) errors.push("Waitlist first name is required.");
    if (!lastName) errors.push("Waitlist last name is required.");
    const joinedAt = isoDate(cell(waitlist, "Timestamp"));
    const promotedAt = isoDate(cell(waitlist, "Promoted At"));
    const data: NormalizedImportData | null = errors.length > 0 ? null : {
      sourceId: `waitlist:${sourceId}`,
      confirmationCode,
      firstName,
      lastName,
      email: cell(waitlist, "Email").toLowerCase(),
      phone: cell(waitlist, "Phone"),
      attendeeType: "ATTENDEE",
      status: "WAITLISTED",
      totalAmountCents: 0,
      submittedAt: joinedAt,
      contactSnapshot: {
        sourceSystem: "WR26_GOOGLE_SHEETS",
        sourceId,
        church: cell(waitlist, "Church"),
        ffEntryId: cell(waitlist, "FF Entry ID"),
        legacyWaitlistPosition: Math.max(1, Number(cell(waitlist, "Position") || 1)),
      },
      attendees: [{
        sourceId: `${sourceId}-1`,
        firstName,
        lastName,
        email: cell(waitlist, "Email").toLowerCase(),
        phone: cell(waitlist, "Phone"),
        attendeeType: "ATTENDEE",
        profileSnapshot: { sourceId: `${sourceId}-1`, church: cell(waitlist, "Church") },
        formResponses: { first_name: firstName, last_name: lastName },
      }],
      waitlist: {
        position: waitlistPositions.get(waitlist) ?? index + 1,
        status: waitlistStatus(cell(waitlist, "Status")),
        joinedAt,
        promotedAt,
        notes: cell(waitlist, "Notes"),
      },
    };
    rows.push({
      sourceRow: registrations.rows.length + index + 2,
      raw: waitlist,
      data,
      warnings,
      errors,
    });
  }

  const canonicalFiles = files
    .filter((file) => (supportedSheets as readonly string[]).includes(sheetKey(file.name)))
    .sort((left, right) => left.name.localeCompare(right.name));
  const snapshotText = [
    `WR26_BUNDLE_PARSER_VERSION=${WR26_BUNDLE_PARSER_VERSION}`,
    ...canonicalFiles.map((file) => `${file.name}\n${file.text}`),
  ].join("\n--WR26-SHEET--\n");
  const identity = createImportSnapshotIdentity(eventId, snapshotText);
  const missingOptionalSheets = supportedSheets
    .filter((sheet) => !["registrations", "attendees"].includes(sheet))
    .filter((sheet) => !tables.has(sheet));

  return {
    ...identity,
    rows,
    headers: registrations.headers,
    fileName: `WR26 bundle (${canonicalFiles.length} sheets)`,
    summary: {
      sheets: [...tables.keys()],
      missingOptionalSheets,
      registrations: registrations.rows.length,
      attendees: attendees.rows.length,
      sourcePaymentStatuses: countsBy(
        registrations.rows,
        (registration) => cell(registration, "Payment Status").trim().toLowerCase(),
      ),
      sourcePaymentMethods: countsBy(
        registrations.rows,
        (registration) => cell(registration, "Payment Method").trim().toLowerCase(),
      ),
      sourceRecordedPaymentCents: registrations.rows.reduce(
        (sum, registration) => sum + cents(cell(registration, "Amount Paid")),
        0,
      ),
      importedSuccessfulPaymentCents: rows.reduce((sum, row) => (
        sum + (
          row.data?.payment?.status === "SUCCEEDED"
            ? row.data.payment.amountCents
            : 0
        )
      ), 0),
      importedSuccessfulPaymentRows: rows.filter(
        (row) => row.data?.payment?.status === "SUCCEEDED",
      ).length,
      waitlistEntries: waitlistRows.length,
      refunds: tables.get("refunds")?.rows.length ?? 0,
      checkIns: tables.get("checkins")?.rows.length ?? 0,
      transferLogs: tables.get("transferlog")?.rows.length ?? 0,
      promoCodes: legacyPromoCodes.length,
      invalidPromoCodes: invalidPromoCodeRows,
      seminarCatalog: legacySeminarCatalog,
      seminarPreferences: tables.get("seminarpreferences")?.rows.length ?? 0,
      importedSeminarPreferences: matchedPreferenceRows.length,
      staleSeminarPreferences: stalePreferenceRows,
      shirtSizesAvailable: Boolean(shirtSizeHeader),
      legacyTestPaymentRows,
      paidAmountMismatchRows,
    },
  };
}
