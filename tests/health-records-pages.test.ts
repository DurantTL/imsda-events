import { beforeEach, describe, expect, it, vi } from "vitest";
import { HealthRecordError } from "@/modules/health-records/errors";

const mocks = vi.hoisted(() => ({
  enabled: true,
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  coordinatorViewer: vi.fn(),
  methods: vi.fn(),
  view: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock("@/modules/health-records/flag", () => ({ healthRecordsEnabled: () => mocks.enabled }));
vi.mock("@/modules/health-records/access", () => ({
  requireAreaCoordinatorHealthViewer: mocks.coordinatorViewer,
  attendeeUnlockMethods: mocks.methods,
}));
vi.mock("@/modules/health-records/repository", () => ({ viewHealthRecord: mocks.view }));
vi.mock("@/components/passkey-unlock-button", () => ({ PasskeyUnlockButton: () => null }));
vi.mock("@/components/roster-unlock-form", () => ({ RosterUnlockForm: () => null }));

import CoordinatorHealthPage from "@/app/(public)/account/(portal)/area-clubs/health/[eventId]/[organizationId]/[memberId]/page";
import { HealthStepUp } from "@/components/health-step-up";
import { PasskeyUnlockButton } from "@/components/passkey-unlock-button";
import { RosterUnlockForm } from "@/components/roster-unlock-form";

const props = { params: Promise.resolve({ eventId: "event-1", organizationId: "club-a", memberId: "member-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled = true;
  mocks.methods.mockResolvedValue({ code: true, passkey: false });
});

describe("the Area Coordinator health page", () => {
  it("is a 404 with the feature off, before any access check", async () => {
    mocks.enabled = false;
    await expect(CoordinatorHealthPage(props)).rejects.toThrow("NOT_FOUND");
    expect(mocks.coordinatorViewer).not.toHaveBeenCalled();
  });

  it("is a 404 for anyone who is not a coordinator", async () => {
    mocks.coordinatorViewer.mockRejectedValue(new HealthRecordError("NOT_FOUND", "That page could not be found."));
    await expect(CoordinatorHealthPage(props)).rejects.toThrow("NOT_FOUND");
    expect(mocks.view).not.toHaveBeenCalled();
  });

  it("shows the roster's own unlock form, and loads no record, when the second step is too old", async () => {
    mocks.coordinatorViewer.mockRejectedValue(new HealthRecordError("STEP_UP_REQUIRED", "Confirm it's you."));
    const element = (await CoordinatorHealthPage(props)) as { type: unknown; props: { methods: unknown } };
    expect(element.type).toBe(HealthStepUp);
    expect(element.props.methods).toEqual({ code: true, passkey: false });
    expect(mocks.view).not.toHaveBeenCalled();
  });

  it("the step-up panel offers the code form and the passkey button the roster's unlock uses", () => {
    const types = (node: unknown): unknown[] => {
      if (!node || typeof node !== "object") return [];
      const element = node as { type?: unknown; props?: { children?: unknown } };
      const children = ([] as unknown[]).concat(element.props?.children ?? []);
      return [element.type, ...children.flatMap(types)];
    };
    const both = types(HealthStepUp({ methods: { code: true, passkey: true } }));
    expect(both).toContain(RosterUnlockForm);
    expect(both).toContain(PasskeyUnlockButton);
    const codeOnly = types(HealthStepUp({ methods: { code: true, passkey: false } }));
    expect(codeOnly).toContain(RosterUnlockForm);
    expect(codeOnly).not.toContain(PasskeyUnlockButton);
  });

  it("opens the record, with the event id, once the step is fresh", async () => {
    mocks.coordinatorViewer.mockResolvedValue({ kind: "AREA_COORDINATOR", accountId: "acct-1" });
    mocks.view.mockResolvedValue({
      member: { id: "member-1", firstName: "Casey", lastName: "Sample" },
      club: { name: "Synthetic Pathfinders", sponsoringChurch: null },
      status: "CURRENT",
      values: {},
    });
    await CoordinatorHealthPage(props);
    expect(mocks.view).toHaveBeenCalledWith(expect.objectContaining({ kind: "AREA_COORDINATOR" }), "club-a", "member-1", expect.any(Date), { eventId: "event-1" });
  });
});
