import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("attendee type persistence", () => {
  it("keeps the historical text beside nullable identity and orthogonal joins", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const migration = readFileSync("prisma/migrations/20260809050000_event_attendee_types/migration.sql", "utf8");
    expect(schema).toContain("attendeeType    String");
    expect(schema).toContain("attendeeTypeDefinitionId String?");
    expect(schema).toContain("model RegistrationAttendeeClassification");
    expect(schema).toContain("enum AttendeeClassificationKind");
    expect(migration).not.toMatch(/UPDATE\s+"RegistrationAttendee"/i);
    expect(migration).toContain("attendee type belongs to another event");
  });
});
