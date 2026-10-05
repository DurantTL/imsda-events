import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formTemplates } from "@/modules/forms/definition";

const dependencies = vi.hoisted(() => ({
  resolveEventContext: vi.fn(),
  listRegistrations: vi.fn(),
  isClubAudienceEvent: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/events/selection", () => ({ resolveEventContext: dependencies.resolveEventContext }));
vi.mock("@/modules/events/repository", () => ({ isClubAudienceEvent: dependencies.isClubAudienceEvent }));
vi.mock("@/modules/registrations/repository", () => ({ listRegistrations: dependencies.listRegistrations }));

import AttendeeListingPage from "@/app/(workspace)/people/attendees/page";

const definition = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition;

function registration(id: string) {
  return {
    id,
    confirmationCode: `WR26-${id}`,
    status: "CONFIRMED",
    accountHolder: { id: `p-${id}`, firstName: "Holder", lastName: id, email: "", phone: "" },
    attendees: [{ id: `at-${id}`, firstName: "Guest", lastName: id, email: "", phone: "", attendeeType: "Adult", responses: { meal_preference: "Vegan", dietary_needs: "synthetic: no peanuts" } }],
    publicSubmission: { definition, responses: {}, attendeeResponses: [] },
  };
}

const render = async (query: Record<string, string> = { event: "evt" }) => renderToStaticMarkup(await AttendeeListingPage({ searchParams: Promise.resolve(query) }));
const context = (permissions: string[]) => ({ event: { id: "evt", name: "Synthetic Retreat" }, permissions });

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.isClubAudienceEvent.mockResolvedValue(false);
  dependencies.listRegistrations.mockResolvedValue([registration("R1")]);
});

describe("attendee listing page", () => {
  it("shows the restricted state, and reads nothing, without VIEW_SENSITIVE_DATA", async () => {
    dependencies.resolveEventContext.mockResolvedValue(context(["VIEW_EVENT", "VIEW_REPORTS"]));
    const html = await render();
    expect(html).toContain("The attendee list is restricted");
    expect(html).not.toContain("WR26-");
    expect(dependencies.listRegistrations).not.toHaveBeenCalled();
  });

  it("lists attendees with dietary text for staff with reports and sensitive access", async () => {
    dependencies.resolveEventContext.mockResolvedValue(context(["VIEW_REPORTS", "VIEW_SENSITIVE_DATA"]));
    const html = await render();
    expect(html).toContain("WR26-R1");
    expect(html).toContain("synthetic: no peanuts");
    expect(html).toContain("Download CSV");
    expect(html).not.toContain("Dietary details are limited");
  });

  it("hides the dietary text and says why when the viewer lacks reports access", async () => {
    dependencies.resolveEventContext.mockResolvedValue(context(["VIEW_SENSITIVE_DATA"]));
    const html = await render();
    expect(html).toContain("WR26-R1");
    expect(html).not.toContain("synthetic: no peanuts");
    expect(html).toContain("Dietary details are limited to staff with health access");
    expect(html).not.toContain("Download CSV");
  });

  it("hides the dietary text on a club event without health access", async () => {
    dependencies.isClubAudienceEvent.mockResolvedValue(true);
    dependencies.resolveEventContext.mockResolvedValue(context(["VIEW_REPORTS", "VIEW_SENSITIVE_DATA"]));
    const html = await render();
    expect(html).not.toContain("synthetic: no peanuts");
    expect(html).toContain("Dietary details are limited to staff with health access");
  });
});
