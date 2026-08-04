import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttendeeSignUpForm } from "@/components/attendee-sign-up-form";
import { PeopleWorkspace } from "@/components/people-workspace";
import { RegistrationAccountPrompt } from "@/components/registration-account-prompt";
import {
  attendeeAuthReturnPath,
  attendeeAuthReturnPathFromHash,
  attendeeSignUpEmailPrefill,
  takeAttendeeAuthReturnPath,
} from "@/modules/attendee-accounts/sign-up-prefill";
import type { RegistrationRecord } from "@/modules/registrations/repository";

const root = process.cwd();
const publicRegistrationForm = readFileSync(
  path.join(root, "components/public-registration-form.tsx"),
  "utf8",
);
const publicManagementPage = readFileSync(
  path.join(root, "app/(public)/manage/[token]/page.tsx"),
  "utf8",
);
const globalsCss = readFileSync(path.join(root, "app/globals.css"), "utf8");

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/use-accessible-dialog", () => ({
  useAccessibleDialog: () => ({ current: null }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
      eventTimezone: "America/Chicago",
      waitlistEnabled: true,
      initialRegistrations: [registration("2026-07-30T18:13:05.955Z")],
      initialRegistrationId: "registration-1",
      canEdit: true,
    }));

    expect(markup).toContain("Jul 30, 2026, 1:13 PM CDT");
    expect(markup).toContain("Times are shown in America/Chicago.");
    expect(markup).toContain("<small>Submitted</small>");
    expect(markup).toContain("<small>Last updated</small>");
    expect(markup).not.toContain("Not submitted");
  });

  it("labels drafts without inventing a submission time", () => {
    const markup = renderToStaticMarkup(createElement(PeopleWorkspace, {
      eventId: "event-1",
      eventSlug: "womens-retreat-2026",
      eventTimezone: "America/Chicago",
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
        returnTo: "/manage/private-registration-token",
      },
    ));

    expect(markup).toContain("Create an optional account to manage future registrations");
    expect(markup).toContain(
      "/account/sign-up#email=retreat%2Bprimary%40example.test&amp;returnTo=%2Fmanage%2Fprivate-registration-token",
    );
    expect(markup).toContain("Sign in to an existing account");
    expect(markup).toContain("Email me a private registration link");
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain("No account is required");
    expect(markup).toContain("no duplicate account is created");
  });

  it("offers the account choice on review and again on private management", () => {
    expect(publicRegistrationForm).toContain("Finish without an account");
    expect(publicRegistrationForm).toContain("Create an account after submitting");
    expect(publicRegistrationForm).toContain('name="optionalAccount"');
    expect(publicRegistrationForm).toContain('type="radio"');
    expect(publicRegistrationForm).toMatch(
      /does not\s+change either role or delay submission/,
    );
    expect(publicManagementPage).toContain("<RegistrationAccountPrompt");
    expect(publicManagementPage).toContain('returnTo={`/manage/${token}`}');
    expect(globalsCss).toContain(
      ".public-registration-review-account fieldset { grid-template-columns: 1fr; }",
    );
    expect(globalsCss).toContain(
      ".public-registration-account-prompt a:focus-visible",
    );
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

  it("keeps only a private local management path through account authentication", () => {
    expect(attendeeAuthReturnPath("/manage/private-token_123")).toBe(
      "/manage/private-token_123",
    );
    for (const unsafe of [
      "https://untrusted.example/manage/token",
      "//untrusted.example/manage/token",
      "/account",
      "/manage/token?next=https://untrusted.example",
      "/manage/token#other",
    ]) {
      expect(attendeeAuthReturnPath(unsafe)).toBeNull();
    }
  });

  it("stores the private return path outside the request URL and consumes it once", () => {
    const values = new Map<string, string>();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });

    expect(attendeeAuthReturnPathFromHash(
      "#email=retreat%40example.test&returnTo=%2Fmanage%2Fprivate-token",
    )).toBe("/manage/private-token");
    expect(takeAttendeeAuthReturnPath()).toBe("/manage/private-token");
    expect(takeAttendeeAuthReturnPath()).toBeNull();
  });
});
