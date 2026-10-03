import { describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  eventAttendeeType: { count: vi.fn(async () => 1) },
  registrationForm: { count: vi.fn(async () => 1), findMany: vi.fn() },
  formTestSubmission: { count: vi.fn(async () => 2) },
  registrationFormVersion: { count: vi.fn(async () => 0), findMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => prisma }));

import { getSetupChecklistFacts } from "@/modules/events/setup-checklist-repository";

describe("setup checklist facts", () => {
  it("reads four counts only, counts only valid tests, and never reads form definitions", async () => {
    const facts = await getSetupChecklistFacts({ id: "e1", slug: "s", name: "N", startsAt: new Date("2027-10-08T12:00:00Z"), endsAt: new Date("2027-10-10T12:00:00Z"), isPublished: false });
    expect(prisma.formTestSubmission.count).toHaveBeenCalledWith({ where: { eventId: "e1", isValid: true } });
    expect(prisma.eventAttendeeType.count).toHaveBeenCalledWith({ where: { eventId: "e1", isActive: true } });
    expect(prisma.registrationForm.findMany).not.toHaveBeenCalled();
    expect(prisma.registrationFormVersion.findMany).not.toHaveBeenCalled();
    expect(facts).toMatchObject({ activeAttendeeTypeCount: 1, formCount: 1, testSubmissionCount: 2, publishedFormCount: 0 });
  });
});
