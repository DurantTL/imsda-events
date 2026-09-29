import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ACKNOWLEDGE_WINDOW_DAYS,
  acknowledgeDueAt,
  dedupeNotificationRecipients,
  isOpenTransfer,
  isOverdueForStaffQueue,
  moveMoneyBlocker,
  normalizeTransferName,
  receivingClubStatusLabel,
  registrationMoveBlocker,
  registrationMoveBlockerLabels,
  sameTransferName,
  sendingClubStatusLabel,
  transferOrganizationsProblem,
  transferReasonProblem,
} from "@/modules/club-transfers/domain";
import { transferNotificationKey, transferRequestKey } from "@/modules/club-transfers/keys";

describe("club member transfer rules (#489)", () => {
  it("is due for the staff queue 14 days after it was requested, only while pending", () => {
    const initiated = new Date("2026-09-01T12:00:00Z");
    const due = acknowledgeDueAt(initiated);
    expect(ACKNOWLEDGE_WINDOW_DAYS).toBe(14);
    expect(due.toISOString()).toBe("2026-09-15T12:00:00.000Z");
    expect(isOverdueForStaffQueue({ status: "PENDING", acknowledgeDueAt: due }, new Date("2026-09-15T11:59:59Z"))).toBe(false);
    expect(isOverdueForStaffQueue({ status: "PENDING", acknowledgeDueAt: due }, due)).toBe(true);
    // Declined and unmatched requests are already with staff; they are never "overdue".
    expect(isOverdueForStaffQueue({ status: "DECLINED", acknowledgeDueAt: due }, new Date("2026-10-01"))).toBe(false);
    expect(isOverdueForStaffQueue({ status: "UNMATCHED", acknowledgeDueAt: due }, new Date("2026-10-01"))).toBe(false);
  });

  it("requires a written reason and two different clubs", () => {
    expect(transferReasonProblem("   ")).toBe("Enter a reason for the transfer.");
    expect(transferReasonProblem("x".repeat(501))).toBe("Keep the reason under 500 characters.");
    expect(transferReasonProblem("Family moved.")).toBeNull();
    expect(transferOrganizationsProblem("club-1", "club-1")).not.toBeNull();
    expect(transferOrganizationsProblem("club-1", "club-2")).toBeNull();
  });

  it("matches names exactly after normalizing case, spacing and Unicode form, never by substring", () => {
    expect(normalizeTransferName("  Ada   LOVELACE ")).toBe("ada lovelace");
    expect(sameTransferName({ firstName: " ada", lastName: "TESTPERSON " }, { firstName: "Ada", lastName: "Testperson" })).toBe(true);
    // Composed and decomposed accents are the same name.
    expect(sameTransferName({ firstName: "Zoé", lastName: "X" }, { firstName: "Zoé", lastName: "X" })).toBe(true);
    expect(sameTransferName({ firstName: "Sam", lastName: "Testperson" }, { firstName: "Samuel", lastName: "Testperson" })).toBe(false);
    expect(sameTransferName({ firstName: "Ada", lastName: "Test" }, { firstName: "Ada", lastName: "Testperson" })).toBe(false);
  });

  it("tells the receiving club only 'Pending' for every open state, so a request can't probe a roster", () => {
    expect(receivingClubStatusLabel("PENDING")).toBe("Pending");
    expect(receivingClubStatusLabel("UNMATCHED")).toBe("Pending");
    expect(receivingClubStatusLabel("DECLINED")).toBe("Pending");
    expect(receivingClubStatusLabel("COMPLETED")).toBe("Completed");
    expect(receivingClubStatusLabel("CANCELLED")).toBe("Cancelled");
    expect(sendingClubStatusLabel("DECLINED")).toMatch(/conference staff/);
    expect(isOpenTransfer("DECLINED")).toBe(true);
    expect(isOpenTransfer("COMPLETED")).toBe(false);
  });

  it("dedupes notice recipients by normalized email, keeping the first (account) entry", () => {
    const recipients = dedupeNotificationRecipients([
      { accountId: "account-a", email: "Director@Example.test" },
      { accountId: "account-a", email: "director@example.test" },
      { accountId: "account-b", email: " director@example.test " },
      { email: "director@example.test" },
      { accountId: "account-c", email: "other@example.test" },
      { email: "" },
    ]);
    expect(recipients).toEqual([
      { accountId: "account-a", email: "Director@Example.test" },
      { accountId: "account-c", email: "other@example.test" },
    ]);
  });

  it("builds idempotency keys from transfer, template and account, never a raw email", () => {
    expect(transferNotificationKey("t1", "MEMBER_TRANSFER_COMPLETED", { accountId: "acct-1", email: "a@example.test" }))
      .toBe("member-transfer:t1:MEMBER_TRANSFER_COMPLETED:account:acct-1");
    const guest = transferNotificationKey("t1", "MEMBER_TRANSFER_COMPLETED", { email: "Guardian@Example.test" });
    expect(guest).not.toContain("@");
    expect(guest).not.toContain("guardian");
    expect(guest).toBe(transferNotificationKey("t1", "MEMBER_TRANSFER_COMPLETED", { email: " guardian@example.test" }));
  });

  it("keys one open request per club pair and normalized typed name, hashed", () => {
    const key = transferRequestKey({ toOrganizationId: "b", fromOrganizationId: "a", firstName: "Ada", lastName: "Testperson" });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(transferRequestKey({ toOrganizationId: "b", fromOrganizationId: "a", firstName: " ada ", lastName: "TESTPERSON" }));
    expect(key).not.toBe(transferRequestKey({ toOrganizationId: "c", fromOrganizationId: "a", firstName: "Ada", lastName: "Testperson" }));
  });

  it("refuses a registration move to a draft, waitlisted or cancelled registration, or one the person is already on", () => {
    const open = { attendeeOnSource: true, sourceStatus: "SUBMITTED" };
    const destination = { status: "SUBMITTED", waitlisted: false, personAlreadyThere: false };
    expect(registrationMoveBlocker({ ...open, destination })).toBeNull();
    expect(registrationMoveBlocker({ ...open, destination: null })).toBe("NO_DESTINATION");
    expect(registrationMoveBlocker({ ...open, destination: { ...destination, status: "DRAFT" } })).toBe("DESTINATION_DRAFT");
    expect(registrationMoveBlocker({ ...open, destination: { ...destination, status: "WAITLISTED" } })).toBe("DESTINATION_WAITLISTED");
    expect(registrationMoveBlocker({ ...open, destination: { ...destination, waitlisted: true } })).toBe("DESTINATION_WAITLISTED");
    expect(registrationMoveBlocker({ ...open, destination: { ...destination, status: "CANCELLED" } })).toBe("DESTINATION_CANCELLED");
    expect(registrationMoveBlocker({ ...open, destination: { ...destination, personAlreadyThere: true } })).toBe("ALREADY_ON_DESTINATION");
    expect(registrationMoveBlocker({ attendeeOnSource: false, sourceStatus: "SUBMITTED", destination })).toBe("ATTENDEE_GONE");
    expect(registrationMoveBlocker({ attendeeOnSource: true, sourceStatus: "CANCELLED", destination })).toBe("SOURCE_NOT_OPEN");
  });

  it("refuses a stale move and a class over the per-club limit", () => {
    const destination = { status: "SUBMITTED", waitlisted: false, personAlreadyThere: false };
    expect(registrationMoveBlocker({ attendeeOnSource: true, sourceStatus: "SUBMITTED", receivingMemberActive: false, destination })).toBe("MEMBER_LEFT_RECEIVING_CLUB");
    expect(registrationMoveBlocker({ attendeeOnSource: true, sourceStatus: "SUBMITTED", destination, classLimitExceeded: true })).toBe("CLUB_CLASS_LIMIT");
  });

  it("keeps a move's adjustment shift inside the same money guards as a staff adjustment", () => {
    const base = { fromTotalCents: 7500, fromPaidCents: 2000, toTotalCents: 15000, toPaidCents: 0 };
    expect(moveMoneyBlocker({ ...base, shiftCents: -2500 })).toBeNull();
    expect(moveMoneyBlocker({ ...base, fromTotalCents: 0, shiftCents: 0 })).toBeNull();
    expect(moveMoneyBlocker({ ...base, toTotalCents: 0, shiftCents: -2500 })).toBe("TOTAL_CLAMPED");
    expect(moveMoneyBlocker({ ...base, fromTotalCents: 0, shiftCents: 500 })).toBe("TOTAL_CLAMPED");
    expect(moveMoneyBlocker({ ...base, shiftCents: 20000 })).toBe("TOTAL_BELOW_ZERO");
    expect(moveMoneyBlocker({ ...base, shiftCents: -20000 })).toBe("TOTAL_BELOW_ZERO");
    expect(moveMoneyBlocker({ ...base, shiftCents: 6000 })).toBe("TOTAL_BELOW_PAID");
    expect(moveMoneyBlocker({ ...base, toPaidCents: 14000, shiftCents: -2500 })).toBe("TOTAL_BELOW_PAID");
  });
});

describe("a full receiving location blocks a registration move (#413)", () => {
  const destination = { status: "SUBMITTED", waitlisted: false, personAlreadyThere: false };
  const open = { attendeeOnSource: true, sourceStatus: "SUBMITTED", destination };

  it("reports LOCATION_FULL with a message staff can act on", () => {
    expect(registrationMoveBlocker({ ...open, locationFull: true })).toBe("LOCATION_FULL");
    expect(registrationMoveBlockerLabels.LOCATION_FULL).toContain("no room for one more person");
    expect(registrationMoveBlocker({ ...open, locationFull: false })).toBeNull();
  });

  it("ranks it after the class limit and before the money guards, like the other capacity block", () => {
    expect(registrationMoveBlocker({ ...open, classLimitExceeded: true, locationFull: true })).toBe("CLUB_CLASS_LIMIT");
    expect(registrationMoveBlocker({
      ...open, locationFull: true, money: { fromTotalCents: 0, fromPaidCents: 0, toTotalCents: 100, toPaidCents: 0, shiftCents: 50 },
    })).toBe("LOCATION_FULL");
  });
});
