import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  staffLoginRedirectPath: vi.fn(),
  getClubFormBuilderView: vi.fn(),
  listClubFormTemplatesForAdmin: vi.fn(),
  getRosterAccessStateForPage: vi.fn(),
  getEnabledClubFormTemplate: vi.fn(),
  listRosterChoices: vi.fn(),
}));

class Redirect extends Error {
  constructor(public readonly to: string) {
    super(`REDIRECT:${to}`);
  }
}

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Redirect(to); },
  notFound: () => { throw new Error("NOT_FOUND"); },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/login-redirect", () => ({ staffLoginRedirectPath: mocks.staffLoginRedirectPath }));
vi.mock("@/modules/club-forms/builder", () => ({ getClubFormBuilderView: mocks.getClubFormBuilderView }));
vi.mock("@/modules/club-forms/templates", () => ({
  listClubFormTemplatesForAdmin: mocks.listClubFormTemplatesForAdmin,
  getEnabledClubFormTemplate: mocks.getEnabledClubFormTemplate,
  withLiveDirectory: async (definition: unknown) => definition,
}));
vi.mock("@/modules/club-forms/submissions", () => ({ listRosterChoices: mocks.listRosterChoices }));
vi.mock("@/modules/club-forms/access", () => ({ clubLeaderViewerFromAccess: vi.fn() }));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessStateForPage: mocks.getRosterAccessStateForPage }));
vi.mock("@/components/back-link", () => ({ BackLink: () => null }));

import AdminClubFormsPage from "@/app/(workspace)/admin/club-forms/page";
import ClubFormBuilderPage from "@/app/(workspace)/admin/club-forms/[templateKey]/page";
import NewClubFormPage from "@/app/(public)/account/(portal)/clubs/[organizationId]/forms/[templateKey]/new/page";
import { ClubFormFillIn } from "@/components/club-form-fill-in";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import { parseClubFormTemplate } from "@/modules/club-forms/domain";

const params = Promise.resolve({ templateKey: "off_premises_permission_slip" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffLoginRedirectPath.mockResolvedValue("/login");
});

describe("the club form builder page is for system administrators only (#712)", () => {
  it("sends a visitor who is not signed in to sign in, and reads no form", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    await expect(ClubFormBuilderPage({ params })).rejects.toMatchObject({ to: "/login" });
    expect(mocks.getClubFormBuilderView).not.toHaveBeenCalled();
  });

  it("refuses a signed-in user who is not a system administrator, and reads no form", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "user-2", globalRole: "USER" } });
    await expect(ClubFormBuilderPage({ params })).rejects.toMatchObject({ to: "/no-access" });
    expect(mocks.getClubFormBuilderView).not.toHaveBeenCalled();
  });

  it("refuses the same user on the list page", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "user-2", globalRole: "USER" } });
    await expect(AdminClubFormsPage()).rejects.toMatchObject({ to: "/no-access" });
    expect(mocks.listClubFormTemplatesForAdmin).not.toHaveBeenCalled();
  });
});

function findElements(node: ReactNode, match: (element: { type: unknown; props: Record<string, unknown> }) => boolean, found: Array<{ props: Record<string, unknown> }> = []) {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, match, found);
  } else if (isValidElement(node)) {
    const element = node as unknown as { type: unknown; props: Record<string, unknown> };
    if (match(element)) found.push(element);
    findElements(element.props.children as ReactNode, match, found);
  }
  return found;
}

describe("a hidden field is not offered on the director's new-fill page (#712)", () => {
  it("passes the fill definition, without the hidden fields, to the form", async () => {
    const seed = clubFormTemplateSeeds.find((candidate) => candidate.key === "off_premises_permission_slip")!;
    const template = parseClubFormTemplate({
      id: "t", key: seed.key, name: seed.name, description: "", version: 2, definition: seed.definition, sectionNotes: seed.sectionNotes,
      sensitiveFieldKeys: seed.sensitiveFieldKeys, birthDateFieldKeys: seed.birthDateFieldKeys, staffOnlyFieldKeys: seed.staffOnlyFieldKeys,
      hiddenFieldKeys: ["activity", "physician_name"], printLayout: "STANDARD", enabled: true, customizedAt: new Date(),
    });
    mocks.getRosterAccessStateForPage.mockResolvedValue({ state: "OPEN", club: { role: "DIRECTOR", name: "Example Pathfinders" } });
    mocks.getEnabledClubFormTemplate.mockResolvedValue(template);
    mocks.listRosterChoices.mockResolvedValue([]);
    const page = await NewClubFormPage({
      params: Promise.resolve({ organizationId: "club-a", templateKey: seed.key }),
      searchParams: Promise.resolve({}),
    });
    const fills = findElements(page as ReactNode, (element) => element.type === ClubFormFillIn);
    expect(fills).toHaveLength(1);
    const definition = fills[0].props.definition as typeof template.definition;
    const keys = definition.sections.flatMap((section) => section.fields.map((field) => field.key));
    expect(keys).not.toContain("activity");
    expect(keys).not.toContain("physician_name");
    expect(keys).toContain("child_name");
  });
});

describe("a form behind the code points to Sync templates, not a terminal (#810)", () => {
  it("tells the system administrator to use the in-app Sync templates button", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "user-1", globalRole: "SYSTEM_ADMIN" } });
    const seed = clubFormTemplateSeeds.find((candidate) => candidate.key === "off_premises_permission_slip")!;
    mocks.getClubFormBuilderView.mockResolvedValue({
      key: seed.key, version: 1, needsSync: true, draftStale: false, draftBaseVersion: null, draft: null, draftUnreadable: false,
      customized: false, published: { name: seed.name, definition: seed.definition },
    });
    const markup = renderToStaticMarkup((await ClubFormBuilderPage({ params })) as React.ReactElement);
    expect(markup).toContain("Sync templates");
    expect(markup).toContain('href="/admin/club-forms"');
    expect(markup).not.toContain("npm run");
    expect(markup).not.toContain("club-forms:sync");
  });
});
