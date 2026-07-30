import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AttendeeSignUpForm } from "@/components/attendee-sign-up-form";
import { PeopleWorkspace } from "@/components/people-workspace";
import { RegistrationAccountPrompt } from "@/components/registration-account-prompt";
import { attendeeSignUpEmailPrefill } from "@/modules/attendee-accounts/sign-up-prefill";
import type { RegistrationRecord } from "@/modules/registrations/repository";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/use-accessible-dialog", () => ({
  useAccessibleDialog: () => ({ current: null }),
}));

function registration(
  submittedAt: string | null,
): RegistrationRecord {
  return {
    id: "registration-1",
    confirmationCode: "WR26-TEST",
    status: submittedAt ? "SUBMITTED" : "DRAFT",
    totalAmountCents: 12_500,
    paidCents: 0,
    balanceCents: 12_500,
    submittedAt,
    createdAt: "2026-07-30T18:13:05.955Z",
    updatedAt: "2026-07-30T18:13:05.955Z",
    accountHolder: {
      id: "person-1",
      firstName: "Synthetic",
      lastName: "Registrant",
      email: "retreat@example.test",
      phone: "",
    },
    attendees: [{
      id: "attendee-1",
      firstName: "Synthetic",
      lastName: "Registrant",
      email: "retreat@example.test",
      phone: "",
      attendeeType: "ATTENDEE",
      position: 0,
      source: "PUBLIC_REGISTRATION",
      responses: {},
      checkedIn: false,
      checkInId: null,
      checkedInAt: null,
    }],
    attendeeType: "ATTENDEE",
    attendeeCount: 1,
    checkedInCount: 0,
    payments: [],
    messages: [],
    publicSubmission: null,
  };
}

describe("Women’s Retreat registration visibility", () => {
  it("shows a compact submission date and full submitted detail to staff", () => {
    const markup = renderToStaticMarkup(createElement(PeopleWorkspace, {
      eventId: "event-1",
      eventSlug: "womens-retreat-2026",
      waitlistEnabled: true,
      initialRegistrations: [registration("2026-07-30T18:13:05.955Z")],
      initialRegistrationId: "registration-1",
      canEdit: true,
    }));

    expect(markup).toContain("Jul 30, 2026");
    expect(markup).toContain("<small>Submitted</small>");
    expect(markup).not.toContain("Not submitted");
  });

  it("labels drafts without inventing a submission time", () => {
    const markup = renderToStaticMarkup(createElement(PeopleWorkspace, {
      eventId: "event-1",
      eventSlug: "womens-retreat-2026",
      waitlistEnabled: true,
      initialRegistrations: [registration(null)],
      initialRegistrationId: "registration-1",
      canEdit: true,
    }));

    expect(markup).toContain("Not submitted");
  });

  it("offers account creation after registration without making it required", () => {
    const markup = renderToStaticMarkup(createElement(
      RegistrationAccountPrompt,
      {
        email: "retreat+primary@example.test",
        embedded: true,
      },
    ));

    expect(markup).toContain("Keep every registration in one account");
    expect(markup).toContain(
      "/account/sign-up#email=retreat%2Bprimary%40example.test",
    );
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain("work without an account");
  });

  it("prefills only the attendee sign-up email field", () => {
    const markup = renderToStaticMarkup(createElement(AttendeeSignUpForm, {
      initialEmail: "retreat@example.test",
    }));

    expect(markup).toContain('name="email"');
    expect(markup).toContain('value="retreat@example.test"');
    expect(markup).not.toContain('name="displayName" value=');
  });

  it("treats the sign-up query email as untrusted convenience text", () => {
    expect(attendeeSignUpEmailPrefill(" retreat@example.test "))
      .toBe("retreat@example.test");
    expect(attendeeSignUpEmailPrefill(["first@example.test", "second@example.test"]))
      .toBe("");
    expect(attendeeSignUpEmailPrefill("not-an-email")).toBe("");
    expect(attendeeSignUpEmailPrefill(`a@${"x".repeat(251)}.test`)).toBe("");
  });
});
