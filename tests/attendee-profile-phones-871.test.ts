import { beforeEach, describe, expect, it, vi } from "vitest";

/** #871: the profile phones use the shared validators. Synthetic data only. */
const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: dependencies.writeAuditLog }));

import { updateAttendeeProfile } from "@/modules/attendee-accounts/profile-service";

const stored = {
  firstName: "Avery",
  lastName: "Person",
  phone: "555-0100",
  shirtSize: "M",
  dietaryNeeds: null,
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
};
const input = {
  firstName: "Avery",
  lastName: "Person",
  phone: "555-0100",
  shirtSize: "M",
  dietaryNeeds: "",
  accessibilityNeeds: "",
  emergencyContactPhone: "",
};

const attendeeAccount = { findUniqueOrThrow: vi.fn(), update: vi.fn() };
const tx = { attendeeAccount };

function dataSaved() {
  return attendeeAccount.update.mock.calls[0]![0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getPrisma.mockReturnValue({
    attendeeAccount,
    $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
  });
  attendeeAccount.findUniqueOrThrow.mockResolvedValue(stored);
  attendeeAccount.update.mockResolvedValue(stored);
});

describe("profile phones use the shared validator (#871)", () => {
  it("stores a changed phone normalised", async () => {
    await updateAttendeeProfile("acct-1", { ...input, phone: " 515.555.0134 " });
    expect(dataSaved().phone).toBe("(515) 555-0134");
  });

  it("accepts a valid international number and an extension", async () => {
    await updateAttendeeProfile("acct-1", { ...input, phone: "+52 55 1234 5678", emergencyContactPhone: "515-555-0134 ext. 12" });
    expect(dataSaved()).toMatchObject({ phone: "+52 55 1234 5678", emergencyContactPhone: "(515) 555-0134 x12" });
  });

  it("rejects a changed bad phone, and nothing it says carries the number", async () => {
    const error = await updateAttendeeProfile("acct-1", { ...input, phone: "idk 911" }).catch((caught: unknown) => caught) as { issues: Array<{ path: string[]; message: string }>; message: string };
    expect(error.issues[0]!.path).toEqual(["phone"]);
    expect(error.issues[0]!.message).toMatch(/10-digit US number/);
    expect(JSON.stringify(error.issues)).not.toContain("idk 911");
    expect(error.message).not.toContain("idk 911");
    expect(attendeeAccount.update).not.toHaveBeenCalled();
  });

  it("lets an old unusable phone stay when it is untouched, even when only its formatting differs", async () => {
    await updateAttendeeProfile("acct-1", { ...input, phone: "555 0100", shirtSize: "L" });
    expect(dataSaved()).toMatchObject({ phone: "555-0100", shirtSize: "L" });
  });

  it("keeps an untouched valid but unformatted phone exactly, so the audit records no change", async () => {
    attendeeAccount.findUniqueOrThrow.mockResolvedValue({ ...stored, phone: "515-555-0134" });
    attendeeAccount.update.mockResolvedValue({ ...stored, phone: "515-555-0134" });
    await updateAttendeeProfile("acct-1", { ...input, phone: "515-555-0134" });
    expect(dataSaved().phone).toBe("515-555-0134");
    expect(dependencies.writeAuditLog).not.toHaveBeenCalled();
  });

  it("lets the old unusable phone stay on an exact resave", async () => {
    await updateAttendeeProfile("acct-1", input);
    expect(dataSaved().phone).toBe("555-0100");
  });

  it("is not fooled by a client claiming a changed bad phone is unchanged: the stored value decides", async () => {
    attendeeAccount.findUniqueOrThrow.mockResolvedValue({ ...stored, phone: "(515) 555-0134" });
    await expect(updateAttendeeProfile("acct-1", { ...input, phone: "555-0100", unchanged: true } as never)).rejects.toThrow();
    await expect(updateAttendeeProfile("acct-1", { ...input, phone: "555-0100" })).rejects.toThrow();
    expect(attendeeAccount.update).not.toHaveBeenCalled();
  });

  it("allows clearing the phone, and leaves an omitted emergency phone alone", async () => {
    const { emergencyContactPhone: omitted, ...withoutEmergencyPhone } = input;
    expect(omitted).toBe("");
    await updateAttendeeProfile("acct-1", { ...withoutEmergencyPhone, phone: "" });
    expect(dataSaved().phone).toBe("");
    expect(dataSaved().emergencyContactPhone).toBeUndefined();
  });

  it("judges the emergency phone against its own stored value", async () => {
    attendeeAccount.findUniqueOrThrow.mockResolvedValue({ ...stored, emergencyContactPhone: "call mom" });
    await expect(updateAttendeeProfile("acct-1", { ...input, emergencyContactPhone: "call mom" })).resolves.toBeTruthy();
    await expect(updateAttendeeProfile("acct-1", { ...input, emergencyContactPhone: "call dad" })).rejects.toThrow();
  });
});
