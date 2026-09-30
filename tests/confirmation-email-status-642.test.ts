import { describe, expect, it } from "vitest";
import {
  CLUB_SUPPORT_FALLBACK_EMAIL,
  confirmationEmailHeadline,
  confirmationEmailStatusFromMessages,
  describeClubConfirmationEmail,
} from "@/modules/forms/confirmation-email-status";

describe("confirmation email status (#642)", () => {
  it("uses the newest message and maps each outbox status honestly", () => {
    expect(confirmationEmailStatusFromMessages(["SENT", "FAILED"])).toBe("SENT");
    expect(confirmationEmailStatusFromMessages(["FAILED", "SENT"])).toBe("FAILED");
    expect(confirmationEmailStatusFromMessages(["CAPTURED"])).toBe("CAPTURED");
    expect(confirmationEmailStatusFromMessages(["PENDING"])).toBe("PENDING");
    expect(confirmationEmailStatusFromMessages(["PROCESSING"])).toBe("PENDING");
    expect(confirmationEmailStatusFromMessages([])).toBe("DISABLED");
    expect(confirmationEmailStatusFromMessages(["SUPPRESSED"])).toBe("DISABLED");
    expect(confirmationEmailStatusFromMessages(["CANCELLED"])).toBe("DISABLED");
  });

  it("keeps the public form's headline wording", () => {
    expect(confirmationEmailHeadline("SENT")).toBe("Your confirmation email was accepted for delivery.");
    expect(confirmationEmailHeadline("PENDING")).toContain("queued");
    expect(confirmationEmailHeadline("FAILED")).toContain("could not be sent");
  });

  it("club card: sent reads as accepted for delivery, with no support prompt", () => {
    const notice = describeClubConfirmationEmail("SENT", "events@example.test");
    expect(notice.email).toContain("accepted for delivery");
    expect(notice.supportEmail).toBeNull();
    expect(notice.registrationSaved).toContain("saved");
  });

  it("club card: queued never reads as delivered and shows the event help email", () => {
    const notice = describeClubConfirmationEmail("PENDING", " events@example.test ");
    expect(notice.email).toContain("queued");
    expect(notice.email).toContain("not been delivered");
    expect(notice.email).not.toMatch(/was sent|accepted for delivery/);
    expect(notice.supportEmail).toBe("events@example.test");
  });

  it("club card: failed shows a support path, falling back to the youth office", () => {
    const failed = describeClubConfirmationEmail("FAILED", "Call the office at 555-0100");
    expect(failed.email).toContain("could not be sent");
    expect(failed.supportEmail).toBe(CLUB_SUPPORT_FALLBACK_EMAIL);
    expect(describeClubConfirmationEmail("FAILED", null).supportEmail).toBe("youth@imsda.org");
  });

  it("club card: disabled and captured claim no delivery", () => {
    expect(describeClubConfirmationEmail("DISABLED", null).email).toContain("No confirmation email");
    expect(describeClubConfirmationEmail("CAPTURED", null).email).toContain("no external email was sent");
  });
});
