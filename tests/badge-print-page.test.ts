import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  resolveEventContext: vi.fn(),
  listRegistrations: vi.fn(),
  getEventBadgeBackground: vi.fn(),
  listBadgeBackgroundOptions: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/events/selection", () => ({
  resolveEventContext: dependencies.resolveEventContext,
}));
vi.mock("@/modules/registrations/repository", () => ({
  listRegistrations: dependencies.listRegistrations,
}));
vi.mock("@/modules/checkin/badge-background-repository", () => ({
  getEventBadgeBackground: dependencies.getEventBadgeBackground,
  listBadgeBackgroundOptions: dependencies.listBadgeBackgroundOptions,
}));

import PrintableNameBadgesPage from "@/app/(workspace)/check-in/badges/page";

const registration = {
  id: "registration_1",
  confirmationCode: "REG-1",
  attendees: [{
    id: "attendee_1",
    attendeeType: "Adult",
    firstName: "Sample",
    lastName: "Attendee",
    responses: {},
  }],
};

async function render(query: Record<string, string | string[]>) {
  return renderToStaticMarkup(
    await PrintableNameBadgesPage({ searchParams: Promise.resolve(query) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.resolveEventContext.mockResolvedValue({
    event: { id: "event_1", name: "Synthetic Retreat" },
    permissions: ["MANAGE_CHECK_IN"],
  });
  dependencies.listRegistrations.mockResolvedValue([registration]);
  dependencies.getEventBadgeBackground.mockResolvedValue(null);
  dependencies.listBadgeBackgroundOptions.mockResolvedValue([]);
});

describe("printable name badge page layout options", () => {
  it("prints the event title on each label by default", async () => {
    const markup = await render({});
    expect(markup).toContain("<header>Synthetic Retreat</header>");
    expect(markup).toContain("--badge-font-scale:1");
    expect(markup).toContain("badge-sheet-avery-5395");
  });

  it("links to the Avery Design & Print CSV export", async () => {
    const markup = await render({});
    expect(markup).toContain("/api/events/event_1/exports/badge-labels-csv");
    expect(markup).toContain("Export CSV for Avery Design &amp; Print");
  });

  it("offers a Position column select defaulting to none, and carries an eligible choice to the export link", async () => {
    const definition = {
      title: "Synthetic Form",
      description: "",
      confirmationMessage: "Thanks",
      sections: [{ id: "sec_one", title: "Section", description: "", fields: [
        { id: "field_church_role", key: "church_role", label: "Church role", helpText: "", type: "TEXT", scope: "ATTENDEE", required: false, options: [] },
        { id: "field_emergency_role", key: "emergency_role", label: "Emergency contact role", helpText: "", type: "TEXT", scope: "ATTENDEE", required: false, options: [] },
      ] }],
    };
    dependencies.listRegistrations.mockResolvedValue([{ ...registration, publicSubmission: { definition, responses: {} } }]);
    const plain = await render({});
    expect(plain).toContain("None (leave blank)");
    expect(plain).toContain("Church role");
    expect(plain).not.toContain("Emergency contact role");
    expect(plain).not.toContain("positionField=");
    expect(await render({ positionField: "church_role" })).toContain("badge-labels-csv?positionField=church_role");
    expect(await render({ positionField: "emergency_role" })).not.toContain("positionField=");
  });

  it("omits the event title from every label when title=0", async () => {
    const markup = await render({ title: "0" });
    expect(markup).not.toContain("<header>");
    expect(markup).toContain("Attendee");
  });

  it("scales text with the size option and falls back to 100", async () => {
    expect(await render({ size: "130" })).toContain("--badge-font-scale:1.3");
    expect(await render({ size: "bogus" })).toContain("--badge-font-scale:1");
  });

  it("maps old Avery 5163 links to the Presta 94237 sheet", async () => {
    const markup = await render({ template: "avery-5163" });
    expect(markup).toContain("badge-sheet-avery-presta-94237");
    expect(markup).not.toContain("badge-sheet-avery-5163");
  });
});

describe("printable name badge attendee-type line", () => {
  const withTeenAnswer = () => {
    const definition = {
      title: "Synthetic Form",
      description: "",
      confirmationMessage: "Thanks",
      sections: [{ id: "sec_one", title: "Section", description: "", fields: [
        { id: "field_type", key: "attendee_type", label: "Attendee type", helpText: "", type: "SELECT", scope: "ATTENDEE", required: true, options: ["adult", "teen"], optionLabels: { adult: "Adult", teen: "Teen" } },
      ] }],
    };
    dependencies.listRegistrations.mockResolvedValue([{
      ...registration,
      attendees: [{ ...registration.attendees[0], attendeeType: "CHILD", responses: { attendee_type: "teen" } }],
      publicSubmission: { definition, responses: {} },
    }]);
  };

  it("shows the form answer's label by default and offers a checked toggle", async () => {
    withTeenAnswer();
    const markup = await render({});
    expect(markup).toContain("<footer><span>Teen</span></footer>");
    expect(markup).toContain("Show attendee type");
    expect(markup).toMatch(/<input[^>]*name="type"[^>]*checked=""/);
  });

  it("hides the line, and an empty footer, when type=0", async () => {
    withTeenAnswer();
    const markup = await render({ type: "0" });
    expect(markup).not.toContain("<footer>");
    expect(markup).not.toContain(">Teen<");
    expect(markup).not.toMatch(/<input[^>]*name="type"[^>]*checked=""/);
  });
});
