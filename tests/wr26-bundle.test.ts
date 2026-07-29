import { describe, expect, it } from "vitest";
import { CsvImportError } from "@/modules/imports/csv-parser";
import { parseWr26Bundle } from "@/modules/imports/wr26-bundle";

function csv(headers: string[], rows: string[][]) {
  const escape = (value: string) => value.includes(",") ? `"${value.replaceAll('"', '""')}"` : value;
  return [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
}

const registrationHeaders = [
  "Registration ID", "Timestamp", "First Name", "Last Name", "Email", "Phone",
  "Church", "Final Amount", "Payment Method", "Payment Status",
  "Square Payment ID", "Status", "Amount Paid", "Promo Code",
];
const attendeeHeaders = [
  "Attendee ID", "Registration ID", "First Name", "Last Name", "Phone", "Email",
  "Church", "Adult/Child", "Meal Preference", "Dietary Needs", "Childcare Needed",
  "Seminar Preferences Complete", "Notes", "Children Needing Care", "Volunteer",
];

describe("WR26 Google Sheets bundle parser", () => {
  it("joins registration, attendees, seminars, finance, check-in, transfer, and waitlist history", () => {
    const result = parseWr26Bundle([
      {
        name: "Registrations.csv",
        text: csv(registrationHeaders, [[
          "REG-100", "2026-07-22T12:00:00Z", "Avery", "Leader",
          "avery@example.test", "555-1000", "Ames SDA Church", "250.00",
          "square", "paid", "sq-100", "active", "250.00", "SCHOLAR",
        ]]),
      },
      {
        name: "Attendees.csv",
        text: csv(attendeeHeaders, [
          ["ATT-1", "REG-100", "Avery", "Leader", "555-1000", "avery@example.test", "Ames SDA Church", "Adult", "Vegetarian", "", "No", "Yes", "", "0", "No"],
          ["ATT-2", "REG-100", "Jamie", "Guest", "", "jamie@example.test", "Ames SDA Church", "Child", "Standard", "Peanut allergy", "Yes", "Yes", "", "1", "Yes"],
        ]),
      },
      {
        name: "SeminarPreferences.csv",
        text: csv(
          ["Preference ID", "Registration ID", "Attendee ID", "Attendee Name", "Session Slot", "Preference Rank", "Seminar Title", "Seminar ID", "Assigned Seminar", "Assignment Status", "Notes"],
          [
            ["P-1", "REG-100", "ATT-2", "Jamie Guest", "session_2", "2", "Seminar B", "", "Seminar A", "assigned", ""],
            ["P-2", "REG-100", "ATT-2", "Jamie Guest", "session_2", "1", "Seminar A", "", "Seminar A", "assigned", ""],
          ],
        ),
      },
      {
        name: "Seminars.csv",
        text: csv(
          ["Slot", "Slot Label", "Seminar Title", "Capacity", "Assigned Count", "Active", "Notes"],
          [["session_2", "Sabbath 2:00–3:15 PM", "Seminar A", "75", "12", "true", "Presenter notes"]],
        ),
      },
      {
        name: "Refunds.csv",
        text: csv(
          ["Refund ID", "Timestamp", "Registration ID", "Name", "Amount", "Method", "Reason", "Status", "Refunded By", "Notes"],
          [["RF-1", "2026-07-23T12:00:00Z", "REG-100", "Avery Leader", "25.00", "square", "Adjustment", "refunded", "admin", ""]],
        ),
      },
      {
        name: "PromoCodes.csv",
        text: csv(
          ["Code", "Description", "Discount Type", "Discount Amount", "Max Uses", "Current Uses", "Expiry Date", "Active", "Min Purchase"],
          [["SCHOLAR", "Per-lady scholarship", "fixed", "$25.00", "20", "4", "2026-09-17", "true", "$100.00"]],
        ),
      },
      {
        name: "CheckIns.csv",
        text: csv(
          ["Check-In ID", "Timestamp", "Registration ID", "Name", "Church", "Method", "Admin User"],
          [["CI-1", "2026-10-09T18:00:00Z", "REG-100", "Avery Leader", "Ames SDA Church", "qr", "staff"]],
        ),
      },
      {
        name: "TransferLog.csv",
        text: csv(
          ["Transfer ID", "Timestamp", "Original Reg ID", "New Reg ID", "Original Name", "New Name", "Original Email", "New Email", "Reason", "Refund Notes", "Admin Notes", "Transferred By"],
          [["TR-1", "2026-08-01T12:00:00Z", "REG-100", "REG-101", "Old Name", "New Name", "old@example.test", "new@example.test", "Unable to attend", "", "", "admin"]],
        ),
      },
      {
        name: "Waitlist.csv",
        text: csv(
          ["Waitlist ID", "Timestamp", "First Name", "Last Name", "Email", "Phone", "Church", "FF Entry ID", "Status", "Position", "Promoted At", "Notes"],
          [["WAIT-1", "2026-08-15T12:00:00Z", "Robin", "Waiting", "robin@example.test", "", "Boone SDA Church", "900", "waiting", "1", "", ""]],
        ),
      },
    ], "event_wr26");

    expect(result.rows).toHaveLength(2);
    expect(result.summary).toMatchObject({
      registrations: 1,
      attendees: 2,
      refunds: 1,
      promoCodes: 1,
      checkIns: 1,
      transferLogs: 1,
      seminarPreferences: 2,
      seminarCatalog: [{
        slot: "session_2",
        title: "Seminar A",
        capacity: 75,
        assignedCount: 12,
        isActive: true,
      }],
      waitlistEntries: 1,
    });
    const registration = result.rows[0].data!;
    expect(registration).toMatchObject({
      sourceId: "REG-100",
      confirmationCode: "REG-100",
      totalAmountCents: 25_000,
      payment: {
        amountCents: 27_500,
        status: "SUCCEEDED",
        method: "CARD_REFERENCE",
        externalReference: "sq-100",
      },
      refunds: [{ sourceId: "RF-1", amountCents: 2_500, status: "SUCCEEDED" }],
      checkIns: [{ sourceId: "CI-1", method: "qr", actor: "staff" }],
    });
    expect(registration.attendees).toHaveLength(2);
    expect(registration.attendees?.[1]).toMatchObject({
      sourceId: "ATT-2",
      attendeeType: "CHILD",
      formResponses: {
        childcare_needed: "Yes",
        childcare_children: "1",
        volunteer: "Yes",
        session_2_preferences: ["Seminar A", "Seminar B"],
      },
      profileSnapshot: {
        legacyAttendeeType: "Child",
        legacySeminarPreferences: expect.stringContaining("\"preferenceId\":\"P-1\""),
      },
    });
    expect(registration.legacyHistory?.transfers).toHaveLength(1);
    expect(registration.legacyPromoCodes).toEqual([expect.objectContaining({
      code: "SCHOLAR",
      discountType: "FIXED_CENTS",
      discountValue: 2_500,
      maximumUses: 20,
      redeemedCount: 4,
    })]);
    expect(result.rows[1].data).toMatchObject({
      sourceId: "waitlist:WAIT-1",
      status: "WAITLISTED",
      waitlist: { position: 1, status: "WAITING" },
    });
    expect(result.checksum).toHaveLength(64);
  });

  it("requires the two source-of-truth WR26 sheets", () => {
    expect(() => parseWr26Bundle([
      { name: "Registrations.csv", text: csv(registrationHeaders, []) },
    ], "event_wr26")).toThrowError(expect.objectContaining({
      code: "MISSING_COLUMNS",
    }) as CsvImportError);
  });

  it("recovers a lone matching attendee name and reports stale seminar history", () => {
    const result = parseWr26Bundle([
      {
        name: "Registrations.csv",
        text: csv(registrationHeaders, [[
          "REG-200", "2026-07-22T12:00:00Z", "Primary", "Contact",
          "primary@example.test", "555-2000", "Boone SDA Church", "125.00",
          "test", "pending_offline", "", "active", "0", "",
        ]]),
      },
      {
        name: "Attendees.csv",
        text: csv(
          [...attendeeHeaders, "T-Shirt Size"],
          [[
            "ATT-200", "REG-200", "", "", "", "primary@example.test",
            "Boone SDA Church", "Adult", "Regular", "", "No", "Yes", "",
            "0", "No", "Adult M",
          ]],
        ),
      },
      {
        name: "SeminarPreferences.csv",
        text: csv(
          ["Preference ID", "Registration ID", "Attendee ID", "Attendee Name", "Session Slot", "Preference Rank", "Seminar Title", "Seminar ID", "Assigned Seminar", "Assignment Status", "Notes"],
          [
            ["P-200", "REG-200", "ATT-200", "Primary Contact", "session_1", "1", "Seminar A", "", "", "pending_review", ""],
            ["P-201", "REG-200", "ATT-200", "Primary Contact", "session_4", "1", "Brushstrokes of Leadership", "", "", "pending_review", ""],
            ["P-stale", "REG-old", "ATT-old", "Removed Person", "session_1", "1", "Old Seminar", "", "", "pending_review", ""],
          ],
        ),
      },
    ], "event_wr26");

    expect(result.rows[0]).toMatchObject({
      warnings: expect.arrayContaining([
        expect.stringContaining("stale SeminarPreferences row"),
        expect.stringContaining("matching primary-contact name was used"),
        expect.stringContaining("legacy payment method “test”"),
      ]),
      data: {
        attendees: [{
          firstName: "Primary",
          lastName: "Contact",
          formResponses: {
            first_name: "Primary",
            last_name: "Contact",
            attendee_type: "Adult",
            meal_preference: "Standard",
            childcare_needed: "No",
            volunteer: "No",
            shirt_size: "Adult M",
            session_1_preferences: ["Seminar A"],
            session_4_attendance: "Attending",
          },
        }],
      },
    });
    expect(result.summary).toMatchObject({
      seminarPreferences: 3,
      importedSeminarPreferences: 2,
      staleSeminarPreferences: 1,
      shirtSizesAvailable: true,
      legacyTestPaymentRows: 1,
    });
  });

  it("honors paid status when the legacy recorded amount is inconsistent", () => {
    const result = parseWr26Bundle([
      {
        name: "Registrations.csv",
        text: csv(registrationHeaders, [[
          "REG-PAID", "2026-07-22T12:00:00Z", "Paid", "Registrant",
          "paid@example.test", "555-4000", "Ames SDA Church", "125.00",
          "test", "paid", "", "active", "0", "",
        ]]),
      },
      {
        name: "Attendees.csv",
        text: csv(attendeeHeaders, [[
          "ATT-PAID", "REG-PAID", "Paid", "Registrant", "", "paid@example.test",
          "Ames SDA Church", "worker", "gluten_free", "", "yes", "Yes", "",
          "1", "yes",
        ]]),
      },
    ], "event_wr26");

    expect(result.rows[0]).toMatchObject({
      warnings: expect.arrayContaining([
        expect.stringContaining("Paid status is authoritative"),
        expect.stringContaining("Payment status is paid"),
      ]),
      data: {
        payment: {
          amountCents: 12_500,
          status: "SUCCEEDED",
          method: "MANUAL",
        },
        contactSnapshot: {
          recordedAmountPaidCents: 0,
          importedPaymentAmountCents: 12_500,
          paymentAmountReconciled: true,
          paymentFormChoice: "Pay later",
        },
        attendees: [{
          attendeeType: "WORKER",
          profileSnapshot: {
            legacyAttendeeType: "worker",
          },
          formResponses: {
            attendee_type: "Adult",
            meal_preference: "Gluten-free",
            childcare_needed: "Yes",
            volunteer: "Yes",
          },
        }],
      },
    });
    expect(result.summary).toMatchObject({
      paidAmountMismatchRows: 1,
    });
  });

  it("blocks an attendee with no safely recoverable name", () => {
    const result = parseWr26Bundle([
      {
        name: "Registrations.csv",
        text: csv(registrationHeaders, [[
          "REG-300", "2026-07-22T12:00:00Z", "Primary", "Contact",
          "primary@example.test", "555-3000", "Ames SDA Church", "250.00",
          "check", "pending_offline", "", "active", "0", "",
        ]]),
      },
      {
        name: "Attendees.csv",
        text: csv(attendeeHeaders, [
          ["ATT-300-1", "REG-300", "Primary", "Contact", "", "primary@example.test", "Ames SDA Church", "Adult", "Regular", "", "No", "Yes", "", "0", "No"],
          ["ATT-300-2", "REG-300", "", "", "", "", "Ames SDA Church", "Adult", "Regular", "", "No", "No", "", "0", "No"],
        ]),
      },
    ], "event_wr26");

    expect(result.rows[0].data).toBeNull();
    expect(result.rows[0].errors).toContain(
      "Attendee ATT-300-2 needs both a first and last name.",
    );
  });
});
