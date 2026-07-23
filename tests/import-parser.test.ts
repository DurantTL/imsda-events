import { describe, expect, it } from "vitest";
import { createImportSnapshotIdentity, CsvImportError, parseImportCsv } from "@/modules/imports/csv-parser";

const headers = "source_id,confirmation_code,first_name,last_name,email,phone,attendee_type,status,total_amount,submitted_at";

describe("WR26 CSV staging parser", () => {
  it("parses quoted fields, money, defaults, and ISO dates", () => {
    const parsed = parseImportCsv(`${headers}\r\nSRC-1,ABC-1,Alex,\"Rivera, Jr.\",alex@example.test,,ATTENDEE,CONFIRMED,\"1,234.50\",2026-07-22T15:00:00Z\r\n`);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].data).toMatchObject({
      sourceId: "SRC-1",
      confirmationCode: "ABC-1",
      lastName: "Rivera, Jr.",
      totalAmountCents: 123_450,
      submittedAt: "2026-07-22T15:00:00.000Z",
    });
    expect(parsed.rows[0].errors).toEqual([]);
  });

  it("records row-level validation errors and duplicate source identifiers", () => {
    const parsed = parseImportCsv(`${headers}\nSRC-1,ABC-1,Alex,Rivera,not-an-email,,ATTENDEE,CONFIRMED,175.00,\nSRC-1,ABC-2,Jamie,Lee,,,UNKNOWN,NOPE,-1,not-a-date\n`);
    expect(parsed.rows[0].data).toBeNull();
    expect(parsed.rows[0].errors).toContain("email is not valid.");
    expect(parsed.rows[1].errors.join(" ")).toContain("Duplicate source_id");
    expect(parsed.rows[1].errors.join(" ")).toContain("attendee_type");
  });

  it("warns when identity matching cannot use email", () => {
    const parsed = parseImportCsv(`${headers}\nSRC-1,ABC-1,Alex,Rivera,,,ATTENDEE,SUBMITTED,0.00,\n`);
    expect(parsed.rows[0].data).not.toBeNull();
    expect(parsed.rows[0].warnings).toContain("No email is available for identity matching.");
  });

  it("rejects structurally incomplete CSV files", () => {
    expect(() => parseImportCsv("source_id,first_name\nSRC-1,Alex\n")).toThrowError(expect.objectContaining({ code: "MISSING_COLUMNS" }) as CsvImportError);
  });

  it("uses a deterministic event-scoped checksum identity", () => {
    const first = createImportSnapshotIdentity("evt_one", "a,b\n1,2\n");
    const same = createImportSnapshotIdentity("evt_one", "a,b\n1,2\n");
    const otherEvent = createImportSnapshotIdentity("evt_two", "a,b\n1,2\n");
    expect(first).toEqual(same);
    expect(first.checksum).toHaveLength(64);
    expect(otherEvent.sourceRunKey).not.toBe(first.sourceRunKey);
  });
});
