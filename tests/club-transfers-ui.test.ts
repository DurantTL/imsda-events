import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ClubTransferCard, RequestTransferButton, transferActionEndpoint } from "@/components/club-transfers-panel";
import { ClubTransferQueue, StaffTransferCard } from "@/components/club-transfer-queue";
import { formatTransferDate, transferEventLabels } from "@/components/transfer-format";
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
      fromRegistration: { id: "ra", confirmationCode: "A-1", status: "SUBMITTED", totalCents: 7500, paidCents: 2000 },
      toRegistration: { id: "rb", confirmationCode: "B-1", status: "DRAFT", waitlisted: false, totalCents: 15000, paidCents: 0 },
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

  it("lays out card actions in one scoped row, primary first, and keeps dates on one line", () => {
    const transfer = {
      id: "t4", requestedName: "Ada Testperson", matchedMemberName: "Ada Testperson", fromOrganizationId: "a", fromOrganizationName: "Club A",
      toOrganizationId: "b", toOrganizationName: "Club B", reason: "r", status: "PENDING", staffReason: null, resolution: null,
      staffNote: "", initiatedAt: iso, acknowledgeDueAt: iso, declinedAt: null, resolvedAt: null, overdue: true, canFinish: true,
      canOverride: true, canCancel: true, needsMemberChoice: false, pendingRegistrationMoves: 0,
      events: [
        { id: "e1", type: "REQUESTED", note: "reason text", actorName: "Director B", createdAt: iso },
        { id: "e2", type: "STAFF_OVERRIDDEN", note: "", actorName: null, createdAt: iso },
        { id: "e3", type: "NOTIFIED", note: "", actorName: null, createdAt: iso },
      ],
    } as unknown as StaffTransferRecord;
    const html = renderToStaticMarkup(createElement(StaffTransferCard, { transfer, onAction: noop }));
    const actions = html.slice(html.indexOf('class="transfer-card-actions"'));
    expect(actions.indexOf(">Finish<")).toBeLessThan(actions.indexOf(">Override<"));
    expect(actions.indexOf(">Override<")).toBeLessThan(actions.indexOf(">Close<"));
    // Staff history uses the same labels as the director panel, never a lowercased enum.
    expect(html).toContain(`${transferEventLabels.REQUESTED}, <span class="transfer-date">${formatTransferDate(iso)}</span>`);
    expect(html).toContain(transferEventLabels.STAFF_OVERRIDDEN);
    expect(html).not.toMatch(/staff overridden|requested,/);
    expect(html).not.toContain("Notice queued");
    expect(html).toContain(`due <span class="transfer-date">${formatTransferDate(iso)}</span>`);
  });

  it("styles the staff queue's Show filter as a visible field", () => {
    const html = renderToStaticMarkup(createElement(ClubTransferQueue));
    expect(html).toMatch(/<label class="filter-field transfer-filter-field">/);
    expect(html).toContain('class="transfer-filter-select"');
    expect(html).toContain("All open");
  });

  it("keeps move dates on one line", () => {
    const move = {
      id: "m2", status: "SKIPPED", transferId: "t1", eventId: "e1", eventName: "Camporee", eventStartsAt: iso, memberName: "Ada Testperson",
      fromClubName: "Club A", toClubName: "Club B", fromRegistration: null, toRegistration: null, adjustmentCents: 0, blocker: null,
      note: "Stays", decidedAt: iso, decidedByName: "Staff", createdAt: iso,
    } as RegistrationMoveRecord;
    const html = renderToStaticMarkup(createElement(RegistrationMoveCard, { move, onDecide: noop }));
    expect(html).toContain(`Skipped <span class="transfer-date">${formatTransferDate(iso)}</span>`);
  });

  it("scopes equal-width, 44px actions to transfer cards and leaves the global phone rule alone", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.transfer-card-actions \.primary-button,\s*\.transfer-card-actions \.secondary-button \{ flex: 1 1 120px; width: auto; min-height: 44px;/);
    // The global phone rule is untouched; the scoped rule above is more specific, so it wins inside transfer cards.
    expect(css).toMatch(/\n  \.secondary-button \{ width: 100%; \}/);
    expect(css).toMatch(/\.transfer-history \{ margin: 0; padding: 0;/);
    expect(css).toContain(".transfer-date { white-space: nowrap; }");
  });
});
