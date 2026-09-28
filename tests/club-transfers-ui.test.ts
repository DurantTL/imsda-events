import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ClubTransferCard, RequestTransferButton, transferActionEndpoint } from "@/components/club-transfers-panel";
import { StaffTransferCard } from "@/components/club-transfer-queue";
import { RegistrationMoveCard } from "@/components/registration-move-approvals";
import type { ClubTransferRecord, RegistrationMoveRecord, StaffTransferRecord } from "@/modules/club-transfers/repository";

const iso = "2026-10-05T15:00:00.000Z";
const noop = () => undefined;

describe("club member transfer screens (#489)", () => {
  it("shows the sending club accept, decline and cancel on a request waiting on it", () => {
    const transfer = {
      id: "t1", direction: "OUTGOING", memberName: "Ada Testperson", otherClubName: "Club B", reason: "Family moved.",
      status: "PENDING", statusLabel: "Waiting on your answer", initiatedAt: iso, acknowledgeDueAt: iso, resolvedAt: null,
      canAccept: true, canDecline: true, canCancel: true, events: [{ id: "e1", type: "REQUESTED", createdAt: iso }],
    } as ClubTransferRecord;
    const html = renderToStaticMarkup(createElement(ClubTransferCard, { transfer, onAction: noop }));
    expect(html).toContain("Accept");
    expect(html).toContain("Decline");
    expect(html).toContain("Cancel request");
    expect(html).toContain("answer by");
  });

  it("shows the receiving club only 'Pending' and cancel, with no accept", () => {
    const transfer = {
      id: "t2", direction: "INCOMING", memberName: "Ada Testperson", otherClubName: "Club A", reason: "Family moved.",
      status: "PENDING", statusLabel: "Pending", initiatedAt: iso, resolvedAt: null,
      canAccept: false, canDecline: false, canCancel: true, events: [],
    } as ClubTransferRecord;
    const html = renderToStaticMarkup(createElement(ClubTransferCard, { transfer, onAction: noop }));
    expect(html).toContain("Pending");
    expect(html).not.toContain(">Accept<");
    expect(html).toContain("Cancel request");
  });

  it("offers staff finish only when overdue, and override and close while open", () => {
    const base = {
      id: "t3", requestedName: "Sam Testperson", matchedMemberName: null, fromOrganizationId: "a", fromOrganizationName: "Club A",
      toOrganizationId: "b", toOrganizationName: "Club B", reason: "r", status: "UNMATCHED", staffReason: "NO_MATCH", resolution: null,
      staffNote: "", initiatedAt: iso, acknowledgeDueAt: iso, declinedAt: null, resolvedAt: null, overdue: false, canFinish: false,
      canOverride: true, canCancel: true, needsMemberChoice: true, pendingRegistrationMoves: 0, events: [],
    } as unknown as StaffTransferRecord;
    const html = renderToStaticMarkup(createElement(StaffTransferCard, { transfer: base, onAction: noop }));
    expect(html).not.toContain(">Finish<");
    expect(html).toContain("Override");
    expect(html).toContain("No active member of that club has exactly that name");
    const overdue = renderToStaticMarkup(createElement(StaffTransferCard, { transfer: { ...base, status: "PENDING", overdue: true, canFinish: true } as StaffTransferRecord, onAction: noop }));
    expect(overdue).toContain("Finish");
    expect(overdue).toContain("Overdue");
  });

  it("shows both registrations' totals on a move, and disables approve when blocked", () => {
    const move = {
      id: "m1", status: "PENDING", transferId: "t1", eventId: "e1", eventName: "Camporee", eventStartsAt: iso, memberName: "Ada Testperson",
      fromClubName: "Club A", toClubName: "Club B",
      fromRegistration: { id: "ra", confirmationCode: "A-1", status: "SUBMITTED", totalCents: 7500 },
      toRegistration: { id: "rb", confirmationCode: "B-1", status: "DRAFT", waitlisted: false, totalCents: 15000 },
      adjustmentCents: -2500, blocker: "DESTINATION_DRAFT", note: "", decidedAt: null, decidedByName: null, createdAt: iso,
    } as RegistrationMoveRecord;
    const html = renderToStaticMarkup(createElement(RegistrationMoveCard, { move, onDecide: noop }));
    expect(html).toContain("$75.00");
    expect(html).toContain("$150.00");
    expect(html).toContain("still a draft");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve move/);
  });

  it("renders the request button with plain props and builds club-scoped action endpoints", () => {
    const html = renderToStaticMarkup(createElement(RequestTransferButton, { organizationId: "club-b", clubOptions: [{ id: "club-a", name: "Club A" }] }));
    expect(html).toContain("Request a transfer");
    expect(transferActionEndpoint("club a", "t/1", "accept")).toBe("/api/attendee/clubs/club%20a/transfers/t%2F1/accept");
  });
});
