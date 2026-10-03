import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formTemplates } from "@/modules/forms/definition";

const dependencies = vi.hoisted(() => ({
  resolveEventContext: vi.fn(),
  listRegistrations: vi.fn(),
  resolveLocationFilter: vi.fn(),
  workspaceProps: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/events/selection", () => ({ resolveEventContext: dependencies.resolveEventContext }));
vi.mock("@/modules/registrations/repository", () => ({ listRegistrations: dependencies.listRegistrations }));
vi.mock("@/modules/event-locations/filter", () => ({ resolveLocationFilter: dependencies.resolveLocationFilter }));
vi.mock("@/modules/background-checks/repository", () => ({ backgroundFlaggedAttendeeIds: vi.fn(async () => new Set<string>()) }));
vi.mock("@/components/people-workspace", () => ({
  PeopleWorkspace: (props: Record<string, unknown>) => {
    dependencies.workspaceProps(props);
    return null;
  },
}));

import PeoplePage from "@/app/(workspace)/people/page";

const definition = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition;

function registration(id: string, meal: string) {
  return {
    id,
    confirmationCode: `WR26-${id}`,
    status: "CONFIRMED",
    accountHolder: { id: `p-${id}`, firstName: "Holder", lastName: id, email: "", phone: "" },
    attendees: [{ id: `at-${id}`, firstName: "Guest", lastName: id, email: "", phone: "", responses: { meal_preference: meal } }],
    publicSubmission: { definition, responses: {}, attendeeResponses: [] },
  };
}

async function render(query: Record<string, string>) {
  return renderToStaticMarkup(await PeoplePage({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.resolveLocationFilter.mockResolvedValue({
    locations: [{ id: "loc_1", name: "North Site", isActive: true }],
    locationId: "loc_1",
    selected: null,
  });
  dependencies.listRegistrations.mockResolvedValue([registration("R1", "Vegan"), registration("R2", "Standard")]);
});

describe("People page with a choice-answer filter", () => {
  it("shows the restricted state, and reads nothing, without VIEW_SENSITIVE_DATA", async () => {
    dependencies.resolveEventContext.mockResolvedValue({ event: { id: "evt", slug: "wr", timezone: "UTC", waitlistEnabled: false }, permissions: ["VIEW_EVENT", "VIEW_REPORTS"] });
    const html = await render({ event: "evt", answerQuestion: "ATTENDEE:meal_preference", answerValue: "Vegan" });
    expect(html).toContain("People records are restricted");
    expect(html).not.toContain("WR26-");
    expect(dependencies.listRegistrations).not.toHaveBeenCalled();
    expect(dependencies.workspaceProps).not.toHaveBeenCalled();
  });

  it("keeps the filter in the location links and narrows the list on the server", async () => {
    dependencies.resolveEventContext.mockResolvedValue({ event: { id: "evt", slug: "wr", timezone: "UTC", waitlistEnabled: false }, permissions: ["VIEW_SENSITIVE_DATA"] });
    const html = await render({ event: "evt", answerQuestion: "ATTENDEE:meal_preference", answerValue: "Vegan" });
    expect(html).toContain("All locations");
    const allLocations = html.match(/href="([^"]*)"[^>]*>All locations/)![1].replaceAll("&amp;", "&");
    expect(allLocations).toContain("answerQuestion=ATTENDEE%3Ameal_preference");
    expect(allLocations).toContain("answerValue=Vegan");
    const props = dependencies.workspaceProps.mock.calls[0][0] as { initialRegistrations: Array<{ id: string }>; matchingPersonFilter: boolean };
    expect(props.initialRegistrations.map((entry) => entry.id)).toEqual(["R1"]);
    expect(props.matchingPersonFilter).toBe(true);
  });

  it("ignores a sensitive question from the URL and lists everyone", async () => {
    dependencies.resolveEventContext.mockResolvedValue({ event: { id: "evt", slug: "wr", timezone: "UTC", waitlistEnabled: false }, permissions: ["VIEW_SENSITIVE_DATA"] });
    await render({ event: "evt", answerQuestion: "ATTENDEE:dietary_needs", answerValue: "x" });
    const props = dependencies.workspaceProps.mock.calls[0][0] as { initialRegistrations: unknown[]; matchingPersonFilter: boolean };
    expect(props.initialRegistrations).toHaveLength(2);
    expect(props.matchingPersonFilter).toBe(false);
  });

  it("hides the export button from staff who cannot use the filtered export", async () => {
    const query = { event: "evt", answerQuestion: "ATTENDEE:meal_preference", answerValue: "Vegan" };
    const event = { id: "evt", slug: "wr", timezone: "UTC", waitlistEnabled: false };
    dependencies.resolveEventContext.mockResolvedValue({ event, permissions: ["VIEW_SENSITIVE_DATA"] });
    expect(await render(query)).not.toContain("Export this list");
    dependencies.resolveEventContext.mockResolvedValue({ event, permissions: ["VIEW_SENSITIVE_DATA", "VIEW_REPORTS"] });
    expect(await render(query)).toContain("Export this list");
  });

  it("with the staff viewer on a legacy form: offers the meal question, not is_minor or health questions", async () => {
    dependencies.resolveEventContext.mockResolvedValue({ event: { id: "evt", slug: "wr", timezone: "UTC", waitlistEnabled: false }, permissions: ["VIEW_SENSITIVE_DATA"] });
    const html = await render({ event: "evt" });
    expect(html).toContain("Meal preference");
    expect(html).not.toContain("Dietary needs");
    const manCamp = formTemplates.find((template) => template.key === "man_camp_export")!.definition;
    dependencies.listRegistrations.mockResolvedValue([{ ...registration("R9", "x"), publicSubmission: { definition: manCamp, responses: {}, attendeeResponses: [] } }]);
    const manCampHtml = await render({ event: "evt", answerQuestion: "ATTENDEE:is_minor", answerValue: "Yes" });
    expect(manCampHtml).not.toContain("Is this attendee under 18?");
    const props = dependencies.workspaceProps.mock.calls.at(-1)![0] as { matchingPersonFilter: boolean };
    expect(props.matchingPersonFilter).toBe(false);
  });
});
