import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma as PrismaErrors } from "@prisma/client";

/**
 * `/api/event-clones/**` (#157): signed-out, non-admin, cross-origin, unknown
 * source, invalid input, incomplete review, and conflict handling for both
 * routes. The repository is stubbed (its real error classes are kept) and the
 * session is synthetic.
 */
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  previewEventClone: vi.fn(),
  cloneEvent: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/lib/logger", async () => {
  const actual = await vi.importActual<typeof import("@/lib/logger")>("@/lib/logger");
  return { ...actual, logError: mocks.logError };
});
vi.mock("@/modules/event-clones/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/event-clones/repository")>("@/modules/event-clones/repository");
  return { ...actual, previewEventClone: mocks.previewEventClone, cloneEvent: mocks.cloneEvent };
});

import { POST as previewRoute } from "@/app/api/event-clones/preview/route";
import { POST as cloneRoute } from "@/app/api/event-clones/route";
import { EventCloneOperationError } from "@/modules/event-clones/repository";
import { EventCloneReviewError, confirmEventCloneInputSchema, previewEventCloneInputSchema } from "@/modules/event-clones/domain";

const staff = { id: "usr_synthetic_staff", email: "staff@imsda-events.test", displayName: "Synthetic Staff", globalRole: null };
const admin = { ...staff, id: "usr_synthetic_admin", globalRole: "SYSTEM_ADMIN" as const };
const origin = "https://events.imsda.test";

function request(body?: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/event-clones`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: requestOrigin },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const include = Object.fromEntries([
  "eventDetails", "moduleToggles", "contentSections", "registrationForms", "attendeeTypes",
  "attendeeClassifications", "messageTemplates", "tags", "promoCodes", "honors",
].map((key) => [key, true]));
const validPreview = { sourceEventId: "event-src" };
const validClone = {
  sourceEventId: "event-src", expectedFingerprint: "a".repeat(64), requestKey: "idempotency-key-0001",
  name: "Annual 2028", slug: "annual-2028", startsOn: "2028-05-03", endsOn: "2028-05-05",
  capacity: { value: null, none: true }, registrationOpensOn: { value: null, none: true }, registrationClosesOn: { value: null, none: true },
  include, formChoiceLimits: [],
};

type Case = { label: string; call: (requestOrigin?: string) => Promise<Response>; repository: ReturnType<typeof vi.fn> };
const cases: Case[] = [
  { label: "POST /api/event-clones/preview", call: (o) => previewRoute(request(validPreview, o)), repository: mocks.previewEventClone },
  { label: "POST /api/event-clones", call: (o) => cloneRoute(request(validClone, o)), repository: mocks.cloneEvent },
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

  it("rejects a cross-origin request before the session is read", async () => {
    const response = await call("https://evil.example");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "INVALID_REQUEST_ORIGIN" });
    expect(mocks.getCurrentSession).not.toHaveBeenCalled();
    expect(repository).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown source event", async () => {
    repository.mockRejectedValue(new EventCloneOperationError("SOURCE_NOT_FOUND", "That source event was not found."));
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "SOURCE_NOT_FOUND" });
  });

  it("logs an unexpected failure and returns a generic 500", async () => {
    repository.mockRejectedValue(new Error("synthetic failure"));
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "EVENT_CLONE_REQUEST_FAILED" });
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });

  it("returns a retryable 409 when the source lock wait times out", async () => {
    const { Prisma } = await import("@prisma/client");
    repository.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("timeout", { code: "P2028", clientVersion: "test" }));
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "SOURCE_BUSY" });
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it.each([
    ["a raw-query lock timeout (P2010, SQLSTATE 55P03)", () => new PrismaErrors.PrismaClientKnownRequestError("Raw query failed. Code: `55P03`. Message: `ERROR: canceling statement due to lock timeout`", { code: "P2010", clientVersion: "test", meta: { code: "55P03", message: "ERROR: canceling statement due to lock timeout" } })],
    ["a transaction lock timeout (P2034 naming 55P03)", () => new PrismaErrors.PrismaClientKnownRequestError("Transaction failed: 55P03 lock timeout", { code: "P2034", clientVersion: "test" })],
    ["a plain error carrying SQLSTATE 55P03", () => Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" })],
    ["a non-raw query lock timeout (unknown request error, 55P03 in the message)", () => new PrismaErrors.PrismaClientUnknownRequestError("Error occurred during query execution: code: \"55P03\", message: \"canceling statement due to lock timeout\"", { clientVersion: "test" })],
  ])("returns a retryable 409 for %s", async (_label, makeError) => {
    repository.mockRejectedValue(makeError());
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "SOURCE_BUSY" });
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});

describe("invalid input → 400", () => {
  it("preview maps the repository's ZodError to 400", async () => {
    mocks.previewEventClone.mockImplementation(async (_actor: string, body: unknown) => previewEventCloneInputSchema.parse(body));
    const response = await previewRoute(request({}));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_EVENT_CLONE_PREVIEW" });
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("clone maps the repository's ZodError to 400 for a missing capacity", async () => {
    mocks.cloneEvent.mockImplementation(async (_actor: string, body: unknown) => confirmEventCloneInputSchema.parse(body));
    const withoutCapacity: Partial<typeof validClone> = { ...validClone };
    delete withoutCapacity.capacity;
    const response = await cloneRoute(request(withoutCapacity));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_EVENT_CLONE" });
  });

  it("clone maps a bare null capacity (not answered) to 400", async () => {
    mocks.cloneEvent.mockImplementation(async (_actor: string, body: unknown) => confirmEventCloneInputSchema.parse(body));
    const response = await cloneRoute(request({ ...validClone, capacity: null }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_EVENT_CLONE" });
  });

  it("clone maps a missing formChoiceLimits to 400", async () => {
    mocks.cloneEvent.mockImplementation(async (_actor: string, body: unknown) => confirmEventCloneInputSchema.parse(body));
    const withoutLimits: Partial<typeof validClone> = { ...validClone };
    delete withoutLimits.formChoiceLimits;
    const response = await cloneRoute(request(withoutLimits));
    expect(response.status).toBe(400);
  });

  it("clone rejects a body that is not JSON without logging", async () => {
    const response = await cloneRoute(request("{not json"));
    expect(response.status).toBe(400);
    expect(mocks.cloneEvent).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("clone reports an incomplete review as 400 with every issue", async () => {
    mocks.cloneEvent.mockRejectedValue(new EventCloneReviewError(["Enter a new late-pricing date.", "Enter a capacity."]));
    const response = await cloneRoute(request(validClone));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "CLONE_REVIEW_INCOMPLETE", issues: ["Enter a new late-pricing date.", "Enter a capacity."] });
  });
});

describe("conflicts → 409", () => {
  it.each(["SOURCE_CHANGED", "REQUEST_KEY_REUSED", "EVENT_SLUG_TAKEN"] as const)("%s", async (code) => {
    mocks.cloneEvent.mockRejectedValue(new EventCloneOperationError(code, "conflict"));
    const response = await cloneRoute(request(validClone));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: code });
  });

  it("reads a leftover unique violation as a taken event address", async () => {
    const { Prisma } = await import("@prisma/client");
    mocks.cloneEvent.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" }));
    const response = await cloneRoute(request(validClone));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "EVENT_SLUG_TAKEN" });
  });
});

describe("success", () => {
  it("preview returns the plan", async () => {
    mocks.previewEventClone.mockResolvedValue({ fingerprint: "f" });
    const response = await previewRoute(request(validPreview));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plan: { fingerprint: "f" } });
    expect(mocks.previewEventClone).toHaveBeenCalledWith(admin.id, validPreview);
  });

  it("a successful clone is 201, and an idempotent retry is 200", async () => {
    const summary = { copiedCounts: { tags: 2 }, skipped: { forms: 0, messageTemplates: 0, assetLinks: 0, privateLinks: 3 }, pricing: { pricedFormFields: 1, lateFormFields: 0, formsWithCardFees: 0, promoCodes: 2 }, pricingMessage: "Prices copied, review before publishing: 1 priced form field, 2 promo codes." };
    mocks.cloneEvent.mockResolvedValueOnce({ event: { id: "event-1" }, alreadyCloned: false, summary });
    mocks.cloneEvent.mockResolvedValueOnce({ event: { id: "event-1" }, alreadyCloned: true, summary });
    const first = await cloneRoute(request(validClone));
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ summary: { skipped: { privateLinks: 3 }, pricingMessage: expect.stringContaining("Prices copied") } });
    expect((await cloneRoute(request(validClone))).status).toBe(200);
    expect(mocks.cloneEvent).toHaveBeenCalledWith(admin.id, validClone);
  });
});
