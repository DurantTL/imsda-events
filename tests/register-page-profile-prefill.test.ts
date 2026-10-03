import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublicRegistrationExperience: vi.fn(),
  getCurrentAttendee: vi.fn(),
  getAttendeeProfile: vi.fn(),
  secondStepPending: vi.fn(),
  formProps: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: vi.fn() }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/modules/forms/public-repository", () => ({ getPublicRegistrationExperience: mocks.getPublicRegistrationExperience }));
vi.mock("@/modules/event-info-cards/repository", () => ({ getAutoEventInfoCards: vi.fn().mockResolvedValue(null) }));
vi.mock("@/modules/events/content-repository", () => ({ listPublishedRegistrationInfoCards: vi.fn().mockResolvedValue([]) }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/portal-second-step", () => ({ attendeeSecondStepPending: mocks.secondStepPending }));
vi.mock("@/modules/attendee-accounts/profile-service", async () => {
  const actual = await vi.importActual<typeof import("@/modules/attendee-accounts/profile-service")>(
    "@/modules/attendee-accounts/profile-service",
  );
  return { ...actual, getAttendeeProfile: mocks.getAttendeeProfile };
});
vi.mock("@/components/public-registration-form", () => ({
  PublicRegistrationForm: (props: unknown) => {
    mocks.formProps(props);
    return null;
  },
}));
vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));

import RegisterPage from "@/app/(public)/register/[eventSlug]/[formSlug]/page";

const profile = {
  firstName: "Avery", lastName: "Person", phone: "555-0100", shirtSize: "", dietaryNeeds: "", accessibilityNeeds: "",
  mailingLine1: "1 Example Way", mailingLine2: "", mailingCity: "Sampletown", mailingRegion: "MI",
  mailingPostalCode: "49000", mailingCountry: "United States",
  emergencyContactName: "Casey Contact", emergencyContactRelationship: "Sibling", emergencyContactPhone: "555-0101",
};

function field(key: string, type: string, options: string[] = []) {
  return { id: `f_${key}`, key, label: key, helpText: "", type, scope: "REGISTRATION", required: false, options };
}

function experience() {
  return {
    event: { name: "Synthetic Event", slug: "synthetic-event", startsAt: new Date("2026-11-06T15:00:00Z"), endsAt: new Date("2026-11-08T18:00:00Z") },
    lifecycle: { phase: "OPEN", capacityDecision: "OPEN" },
    form: { definition: { sections: [{ id: "s", title: "S", description: "", fields: [
      field("phone", "PHONE"),
      field("mailing_address", "ADDRESS"),
      field("city", "TEXT"),
      field("country", "SELECT", ["United States", "Canada"]),
      field("emergency_contact_name", "TEXT"),
      field("emergency_contact_phone", "PHONE"),
    ] }] } },
    choiceUsage: {},
    pricingDate: "2026-10-01",
  };
}

async function prefill() {
  renderToStaticMarkup(await RegisterPage({ params: Promise.resolve({ eventSlug: "synthetic-event", formSlug: "general" }) }));
  return mocks.formProps.mock.calls[0]![0].initialResponses as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPublicRegistrationExperience.mockResolvedValue(experience());
  mocks.getAttendeeProfile.mockResolvedValue(profile);
  mocks.secondStepPending.mockResolvedValue(false);
  mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "acct-1", verifiedEmail: "avery@example.test" }, via: "attendee" });
});

describe("registration page prefill of address and emergency contact", () => {
  it("prefills everything for the attendee's own finished session", async () => {
    expect(await prefill()).toEqual({
      phone: "555-0100",
      mailing_address: { line1: "1 Example Way", locality: "Sampletown", region: "MI", postalCode: "49000", country: "United States" },
      city: "Sampletown",
      country: "United States",
      emergency_contact_name: "Casey Contact",
      emergency_contact_phone: "555-0101",
    });
  });

  it("leaves a SELECT blank when the profile value is not one of its options", async () => {
    mocks.getAttendeeProfile.mockResolvedValue({ ...profile, mailingCountry: "Elsewhere" });
    const responses = await prefill();
    expect(responses).not.toHaveProperty("country");
    expect(responses.city).toBe("Sampletown");
  });

  it("prefills only the ordinary profile fields while the second step is pending", async () => {
    mocks.secondStepPending.mockResolvedValue(true);
    expect(await prefill()).toEqual({ phone: "555-0100" });
  });

  it("prefills only the ordinary profile fields for a staff act-as session", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "acct-1", verifiedEmail: "avery@example.test" }, via: "staff" });
    expect(await prefill()).toEqual({ phone: "555-0100" });
  });
});
