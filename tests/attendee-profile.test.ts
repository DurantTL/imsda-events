import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import {
  attendeeProfilePrefill,
  getAttendeeProfile,
  updateAttendeeProfile,
} from "@/modules/attendee-accounts/profile-service";

const stored = {
  firstName: "Avery",
  lastName: "Person",
  phone: "555-0100",
  shirtSize: "M",
  dietaryNeeds: "Vegetarian",
  accessibilityNeeds: "",
  displayName: "Avery Person",
};
const input = {
  firstName: stored.firstName,
  lastName: stored.lastName,
  phone: stored.phone,
  shirtSize: stored.shirtSize,
  dietaryNeeds: stored.dietaryNeeds,
  accessibilityNeeds: stored.accessibilityNeeds,
};

const attendeeAccount = {
  findUniqueOrThrow: vi.fn(),
  update: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getPrisma.mockReturnValue({ attendeeAccount });
  attendeeAccount.findUniqueOrThrow.mockResolvedValue(stored);
  attendeeAccount.update.mockResolvedValue(stored);
});

describe("attendee profile", () => {
  it("loads reusable details without nulls", async () => {
    await expect(getAttendeeProfile("acct-1")).resolves.toEqual({
      firstName: "Avery",
      lastName: "Person",
      phone: "555-0100",
      shirtSize: "M",
      dietaryNeeds: "Vegetarian",
      accessibilityNeeds: "",
    });
  });

  it("updates the display name from the saved profile", async () => {
    await updateAttendeeProfile("acct-1", input);
    expect(attendeeAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ displayName: "Avery Person" }),
      }),
    );
  });

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
});
