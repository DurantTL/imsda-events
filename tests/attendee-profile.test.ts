import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: dependencies.writeAuditLog }));

import {
  attendeeProfilePrefill,
  getAttendeeProfile,
  updateAttendeeProfile,
  withoutPersonalDetails,
} from "@/modules/attendee-accounts/profile-service";

const stored = {
  firstName: "Avery",
  lastName: "Person",
  phone: "555-0100",
  shirtSize: "M",
  dietaryNeeds: "Vegetarian",
  accessibilityNeeds: null,
  mailingLine1: null,
  mailingLine2: null,
  mailingCity: null,
  mailingRegion: null,
  mailingPostalCode: null,
  mailingCountry: null,
  emergencyContactName: null,
  emergencyContactRelationship: null,
  emergencyContactPhone: null,
  displayName: "Avery Person",
};
const input = {
  firstName: "Avery",
  lastName: "Person",
  phone: "555-0100",
  shirtSize: "M",
  dietaryNeeds: "Vegetarian",
  accessibilityNeeds: "",
  mailingLine1: "",
  mailingLine2: "",
  mailingCity: "",
  mailingRegion: "",
  mailingPostalCode: "",
  mailingCountry: "",
  emergencyContactName: "",
  emergencyContactRelationship: "",
  emergencyContactPhone: "",
};
const withDetails = {
  ...input,
  mailingLine1: "1 Example Way",
  mailingLine2: "Unit 2",
  mailingCity: "Sampletown",
  mailingRegion: "MI",
  mailingPostalCode: "49000",
  mailingCountry: "United States",
  emergencyContactName: "Casey Contact",
  emergencyContactRelationship: "Sibling",
  emergencyContactPhone: "555-0101",
};

const attendeeAccount = {
  findUniqueOrThrow: vi.fn(),
  update: vi.fn(),
};
const tx = { attendeeAccount };

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getPrisma.mockReturnValue({
    attendeeAccount,
    $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
  });
  attendeeAccount.findUniqueOrThrow.mockResolvedValue(stored);
  attendeeAccount.update.mockResolvedValue(stored);
});

describe("attendee profile", () => {
  it("loads reusable details without nulls", async () => {
    await expect(getAttendeeProfile("acct-1")).resolves.toEqual(input);
  });

  it("updates the display name from the saved profile", async () => {
    await updateAttendeeProfile("acct-1", input);
    expect(attendeeAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ displayName: "Avery Person" }),
      }),
    );
  });

  it("stores trimmed address and emergency values, and empty ones as null", async () => {
    attendeeAccount.update.mockResolvedValue({
      ...stored, mailingLine1: "1 Example Way", mailingCity: "Sampletown", emergencyContactName: "Casey Contact",
    });
    const saved = await updateAttendeeProfile("acct-1", {
      ...input, mailingLine1: "  1 Example Way ", mailingCity: "Sampletown", emergencyContactName: "Casey Contact",
    });
    const data = attendeeAccount.update.mock.calls[0]![0].data;
    expect(data).toMatchObject({ mailingLine1: "1 Example Way", mailingLine2: null, mailingRegion: null, emergencyContactPhone: null });
    expect(saved).toMatchObject({ mailingLine1: "1 Example Way", mailingLine2: "", emergencyContactName: "Casey Contact" });
  });

  it("clears a stored address and emergency contact with empty strings", async () => {
    attendeeAccount.findUniqueOrThrow.mockResolvedValue({
      ...stored, mailingLine1: "1 Example Way", mailingCity: "Sampletown", emergencyContactName: "Casey Contact",
    });
    const saved = await updateAttendeeProfile("acct-1", input);
    expect(attendeeAccount.update.mock.calls[0]![0].data).toMatchObject({
      mailingLine1: null, mailingCity: null, emergencyContactName: null,
    });
    expect(saved.mailingLine1).toBe("");
  });

  it("rejects over-long values before touching the database", async () => {
    await expect(updateAttendeeProfile("acct-1", { ...input, mailingLine1: "x".repeat(201) })).rejects.toThrow();
    expect(attendeeAccount.update).not.toHaveBeenCalled();
  });
});

describe("profile edit audit", () => {
  it("records the changed field names and never their values", async () => {
    attendeeAccount.update.mockResolvedValue({ ...stored, ...withDetails, accessibilityNeeds: null });
    await updateAttendeeProfile("acct-1", withDetails);
    expect(dependencies.writeAuditLog).toHaveBeenCalledTimes(1);
    const [entry, client] = dependencies.writeAuditLog.mock.calls[0]!;
    expect(client).toBe(tx);
    expect(entry).toMatchObject({
      action: "ATTENDEE_PROFILE_UPDATED",
      entityType: "AttendeeAccount",
      entityId: "acct-1",
      metadata: {
        actorAttendeeAccountId: "acct-1",
        changedFields: [
          "mailingLine1", "mailingLine2", "mailingCity", "mailingRegion", "mailingPostalCode",
          "mailingCountry", "emergencyContactName", "emergencyContactRelationship", "emergencyContactPhone",
        ],
      },
    });
    const serialized = JSON.stringify(entry);
    for (const value of ["1 Example Way", "Sampletown", "Casey Contact", "555-0101", "49000", "Sibling"]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("writes nothing when nothing changed", async () => {
    await updateAttendeeProfile("acct-1", input);
    expect(dependencies.writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("registration prefill", () => {
  it("maps common form keys for opt-in prefill", () => {
    expect(attendeeProfilePrefill(input, "avery@example.com")).toMatchObject({
      first_name: "Avery",
      primary_contact_first_name: "Avery",
      last_name: "Person",
      primary_contact_last_name: "Person",
      phone: "555-0100",
      attendee_phone: "555-0100",
      shirt_size: "M",
      dietary_needs: "Vegetarian",
      email: "avery@example.com",
    });
  });

  it("maps the emergency contact onto the Women's Retreat form keys", () => {
    expect(attendeeProfilePrefill(withDetails)).toMatchObject({
      emergency_contact_name: "Casey Contact",
      emergency_contact_phone: "555-0101",
      emergency_contact_relationship: "Sibling",
    });
  });

  it("maps the address onto the structured field and the plain text keys", () => {
    expect(attendeeProfilePrefill(withDetails)).toMatchObject({
      mailing_address: {
        line1: "1 Example Way", line2: "Unit 2", locality: "Sampletown", region: "MI",
        postalCode: "49000", country: "United States",
      },
      address_line_1: "1 Example Way",
      address_line_2: "Unit 2",
      city: "Sampletown",
      state: "MI",
      zip: "49000",
      country: "United States",
    });
  });

  it("omits the structured address when none is saved", () => {
    expect(attendeeProfilePrefill(input)).not.toHaveProperty("mailing_address");
  });

  it("can be stripped of the address and emergency contact", () => {
    const prefill = attendeeProfilePrefill(withoutPersonalDetails(withDetails));
    expect(prefill).not.toHaveProperty("mailing_address");
    expect(prefill.city).toBe("");
    expect(prefill.emergency_contact_name).toBe("");
    expect(prefill.phone).toBe("555-0100");
  });
});
