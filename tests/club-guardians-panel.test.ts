import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listGuardianContactsForClub: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/club-rosters/guardians-repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/guardians-repository")>("@/modules/club-rosters/guardians-repository");
  return { ...actual, listGuardianContactsForClub: mocks.listGuardianContactsForClub };
});

import { ClubGuardiansPanel } from "@/components/club-guardians-panel";
import { GuardianAccessError } from "@/modules/club-rosters/guardians-repository";
import type { GuardianViewer } from "@/modules/club-rosters/guardians-domain";

const coordinator: GuardianViewer = { kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: "coordinator-1" } };

async function render(viewer: GuardianViewer = coordinator) {
  const element = await ClubGuardiansPanel({ organizationId: "club-1", viewer });
  return element ? renderToStaticMarkup(element) : "";
}

beforeEach(() => vi.clearAllMocks());

describe("the guardian contacts panel on a club page (#510)", () => {
  it("lists each member's guardians with tap-to-call and email links", async () => {
    mocks.listGuardianContactsForClub.mockResolvedValue([{
      memberId: "member-1", firstName: "Test", lastName: "Youth", attendeeType: "YOUTH", status: "ACTIVE",
      guardians: [
        { position: 1, name: "Synthetic Guardian", relationship: "Mother", email: "guardian@example.test", phone: "(555) 010-0101" },
        { position: 2, name: "", relationship: "Uncle", email: "", phone: "" },
      ],
    }]);
    const html = await render();
    expect(html).toContain("Guardian contacts");
    expect(html).toContain("Test Youth");
    expect(html).toContain("Synthetic Guardian");
    expect(html).toContain('href="tel:5550100101"');
    expect(html).toContain('href="mailto:guardian@example.test"');
    expect(html).toContain("Name not given");
    expect(mocks.listGuardianContactsForClub).toHaveBeenCalledWith(coordinator, "club-1", expect.any(String));
  });

  it("says so when no guardian is on file", async () => {
    mocks.listGuardianContactsForClub.mockResolvedValue([]);
    expect(await render()).toContain("No guardian contacts are on file");
  });

  it("renders nothing for a viewer the repository refuses", async () => {
    mocks.listGuardianContactsForClub.mockRejectedValue(new GuardianAccessError());
    expect(await render({ kind: "CLUB_LEADER", organizationId: "club-2", actor: { kind: "ATTENDEE", accountId: "a" } })).toBe("");
  });

  it("lets any other failure through instead of hiding it", async () => {
    mocks.listGuardianContactsForClub.mockRejectedValue(new Error("audit down"));
    await expect(render()).rejects.toThrow("audit down");
  });
});
