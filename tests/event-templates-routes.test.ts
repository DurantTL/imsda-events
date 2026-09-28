import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/event-templates/**` (#152): signed-out, non-admin, cross-origin,
 * unknown-template, invalid-input, and unexpected-failure handling for every
 * route. The repository is stubbed (its real error classes are kept) and the
 * session is synthetic.
 */
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  listEventTemplates: vi.fn(),
  createEventTemplate: vi.fn(),
  getEventTemplate: vi.fn(),
  saveEventTemplateDraft: vi.fn(),
  publishEventTemplateVersion: vi.fn(),
  archiveEventTemplate: vi.fn(),
  applyEventTemplate: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/lib/logger", async () => {
  const actual = await vi.importActual<typeof import("@/lib/logger")>("@/lib/logger");
  return { ...actual, logError: mocks.logError };
});
vi.mock("@/modules/event-templates/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/event-templates/repository")>("@/modules/event-templates/repository");
  return {
    ...actual,
    listEventTemplates: mocks.listEventTemplates,
    createEventTemplate: mocks.createEventTemplate,
    getEventTemplate: mocks.getEventTemplate,
    saveEventTemplateDraft: mocks.saveEventTemplateDraft,
    publishEventTemplateVersion: mocks.publishEventTemplateVersion,
    archiveEventTemplate: mocks.archiveEventTemplate,
    applyEventTemplate: mocks.applyEventTemplate,
  };
});

import { GET as listRoute, POST as createRoute } from "@/app/api/event-templates/route";
import { GET as getRoute, PATCH as saveRoute } from "@/app/api/event-templates/[templateId]/route";
import { POST as publishRoute } from "@/app/api/event-templates/[templateId]/publish/route";
import { POST as archiveRoute } from "@/app/api/event-templates/[templateId]/archive/route";
import { POST as applyRoute } from "@/app/api/event-templates/[templateId]/apply/route";
import { EventTemplateOperationError } from "@/modules/event-templates/repository";
import { EventTemplateReferenceError } from "@/modules/event-templates/domain";

const staff = { id: "usr_synthetic_staff", email: "staff@imsda-events.test", displayName: "Synthetic Staff", globalRole: null };
const admin = { ...staff, id: "usr_synthetic_admin", globalRole: "SYSTEM_ADMIN" as const };
const origin = "https://events.imsda.test";
const ctx = (templateId = "template-1") => ({ params: Promise.resolve({ templateId }) });

function request(method: string, body?: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/event-templates/x`, {
    method,
    headers: { "content-type": "application/json", origin: requestOrigin },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validDraft = { name: "Weekend Retreat", description: "", payload: {}, expectedUpdatedAt: "2027-01-01T00:00:00.000Z" };
const validApply = { name: "Weekend Retreat 2027", slug: "weekend-retreat-2027", startsOn: "2027-05-01", endsOn: "2027-05-03", requestKey: "idempotency-key-0001" };

type Case = { label: string; call: (requestOrigin?: string) => Promise<Response>; mutation: boolean; repository: ReturnType<typeof vi.fn> };
const cases: Case[] = [
  { label: "GET /api/event-templates", call: () => listRoute(request("GET")), mutation: false, repository: mocks.listEventTemplates },
  { label: "POST /api/event-templates", call: (o) => createRoute(request("POST", { name: "Retreat" }, o)), mutation: true, repository: mocks.createEventTemplate },
  { label: "GET /api/event-templates/[id]", call: () => getRoute(request("GET"), ctx()), mutation: false, repository: mocks.getEventTemplate },
  { label: "PATCH /api/event-templates/[id]", call: (o) => saveRoute(request("PATCH", validDraft, o), ctx()), mutation: true, repository: mocks.saveEventTemplateDraft },
  { label: "POST /api/event-templates/[id]/publish", call: (o) => publishRoute(request("POST", undefined, o), ctx()), mutation: true, repository: mocks.publishEventTemplateVersion },
  { label: "POST /api/event-templates/[id]/archive", call: (o) => archiveRoute(request("POST", undefined, o), ctx()), mutation: true, repository: mocks.archiveEventTemplate },
  { label: "POST /api/event-templates/[id]/apply", call: (o) => applyRoute(request("POST", validApply, o), ctx()), mutation: true, repository: mocks.applyEventTemplate },
];

beforeEach(() => {
  mocks.getCurrentSession.mockResolvedValue({ user: admin });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe.each(cases)("$label", ({ call, repository }) => {
  it("rejects a signed-out request with 401 and does nothing", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    const response = await call();
    expect(response.status).toBe(401);
    expect(repository).not.toHaveBeenCalled();
  });

  it("rejects a signed-in non-admin with 403 and does nothing", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: staff });
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "PERMISSION_DENIED" });
    expect(repository).not.toHaveBeenCalled();
  });

  it("logs an unexpected failure and returns a generic 500", async () => {
    repository.mockRejectedValue(new Error("synthetic failure"));
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "EVENT_TEMPLATE_REQUEST_FAILED" });
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });
});

describe("cross-origin mutations are rejected before the session is read", () => {
  it.each(cases.filter((entry) => entry.mutation))("$label", async ({ call, repository }) => {
    const response = await call("https://evil.example");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "INVALID_REQUEST_ORIGIN" });
    expect(mocks.getCurrentSession).not.toHaveBeenCalled();
    expect(repository).not.toHaveBeenCalled();
  });
});

describe("unknown template → 404", () => {
  it.each(cases.filter((entry) => entry.label.includes("[id]")))("$label", async ({ call, repository }) => {
    repository.mockRejectedValue(new EventTemplateOperationError("TEMPLATE_NOT_FOUND", "That event template was not found."));
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "TEMPLATE_NOT_FOUND" });
  });
});

describe("invalid input → 400", () => {
  it("POST /api/event-templates rejects a missing name", async () => {
    const response = await createRoute(request("POST", { description: "no name" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_EVENT_TEMPLATE" });
    expect(mocks.createEventTemplate).not.toHaveBeenCalled();
  });

  it("PATCH rejects a save without expectedUpdatedAt (B1)", async () => {
    const withoutGuard: Partial<typeof validDraft> = { ...validDraft };
    delete withoutGuard.expectedUpdatedAt;
    const response = await saveRoute(request("PATCH", withoutGuard), ctx());
    expect(response.status).toBe(400);
    expect(mocks.saveEventTemplateDraft).not.toHaveBeenCalled();
  });

  it("PATCH rejects a message default with an unknown token (B2)", async () => {
    const response = await saveRoute(request("PATCH", {
      ...validDraft,
      payload: { messageTemplateDefaults: [{ key: "REGISTRATION_CONFIRMATION", subjectTemplate: "Hi {{not_a_token}}", bodyTemplate: "Body" }] },
    }), ctx());
    expect(response.status).toBe(400);
    expect(mocks.saveEventTemplateDraft).not.toHaveBeenCalled();
  });

  it("PATCH rejects a body that is not JSON", async () => {
    const response = await saveRoute(request("PATCH", "{not json"), ctx());
    expect(response.status).toBe(400);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("apply maps the repository's ZodError to 400", async () => {
    const { applyEventTemplateInputSchema } = await import("@/modules/event-templates/domain");
    mocks.applyEventTemplate.mockImplementation(async (_templateId: string, _actor: string, body: unknown) => applyEventTemplateInputSchema.parse(body));
    const response = await applyRoute(request("POST", { ...validApply, startsOn: "2027-02-30" }), ctx());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_EVENT_TEMPLATE_APPLICATION" });
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});

describe("conflicts → 409", () => {
  it.each([
    ["EDIT_CONFLICT", saveRoute, mocks.saveEventTemplateDraft, validDraft],
    ["TEMPLATE_ARCHIVED", saveRoute, mocks.saveEventTemplateDraft, validDraft],
    ["TEMPLATE_ARCHIVED", publishRoute, mocks.publishEventTemplateVersion, undefined],
    ["REQUEST_KEY_REUSED", applyRoute, mocks.applyEventTemplate, validApply],
    ["EVENT_SLUG_TAKEN", applyRoute, mocks.applyEventTemplate, validApply],
  ] as const)("%s", async (code, route, repository, body) => {
    repository.mockRejectedValue(new EventTemplateOperationError(code, "conflict"));
    const response = await route(request(body === undefined ? "POST" : route === saveRoute ? "PATCH" : "POST", body), ctx());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: code });
  });

  it("apply reports stale template references as 409, publish as 400", async () => {
    mocks.applyEventTemplate.mockRejectedValue(new EventTemplateReferenceError(["stale"]));
    mocks.publishEventTemplateVersion.mockRejectedValue(new EventTemplateReferenceError(["stale"]));
    expect((await applyRoute(request("POST", validApply), ctx())).status).toBe(409);
    expect((await publishRoute(request("POST"), ctx())).status).toBe(400);
  });

  it("a successful apply is 201, and an idempotent retry is 200", async () => {
    mocks.applyEventTemplate.mockResolvedValueOnce({ event: { id: "event-1" }, alreadyApplied: false });
    mocks.applyEventTemplate.mockResolvedValueOnce({ event: { id: "event-1" }, alreadyApplied: true });
    expect((await applyRoute(request("POST", validApply), ctx())).status).toBe(201);
    expect((await applyRoute(request("POST", validApply), ctx())).status).toBe(200);
    expect(mocks.applyEventTemplate).toHaveBeenCalledWith("template-1", admin.id, validApply);
  });
});
