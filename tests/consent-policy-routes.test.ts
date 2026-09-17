import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => {
  class MockConsentPolicyError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    MockConsentPolicyError,
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    findActiveMembership: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    createConsentPolicy: vi.fn(),
    listConsentPoliciesForEvent: vi.fn(),
    updateDraftPolicyVersion: vi.fn(),
    publishPolicyVersion: vi.fn(),
    createEventPolicyApplicability: vi.fn(),
  };
});

vi.mock("@/modules/access/authorization", () => ({
  requirePermission: dependencies.requirePermission,
  AccessDeniedError: class AccessDeniedError extends Error {},
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: dependencies.getCurrentSession }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: dependencies.rejectCrossOriginRequest }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: dependencies.findActiveMembership }));
vi.mock("@/modules/consent/repository", () => ({
  ConsentPolicyError: dependencies.MockConsentPolicyError,
  createConsentPolicy: dependencies.createConsentPolicy,
  listConsentPoliciesForEvent: dependencies.listConsentPoliciesForEvent,
  updateDraftPolicyVersion: dependencies.updateDraftPolicyVersion,
  publishPolicyVersion: dependencies.publishPolicyVersion,
  createEventPolicyApplicability: dependencies.createEventPolicyApplicability,
}));

import { POST as createPolicy } from "@/app/api/events/[eventId]/consent-policies/route";
import { POST as publishPolicy } from "@/app/api/events/[eventId]/consent-policies/[policyId]/publish/route";
import { PATCH as editVersion } from "@/app/api/events/[eventId]/consent-policies/[policyId]/versions/[versionId]/route";
import { POST as createApplicability } from "@/app/api/events/[eventId]/consent-policy-applicability/route";

function jsonRequest(body: unknown, method = "POST") {
  return new Request("http://localhost/api", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getCurrentSession.mockResolvedValue({ user: { id: "user-1" } });
  dependencies.requirePermission.mockResolvedValue({ user: { id: "user-1" } });
  dependencies.rejectCrossOriginRequest.mockReturnValue(null);
});

describe("consent policy routes", () => {
  it("creates an event-scoped policy under event configuration permission", async () => {
    dependencies.createConsentPolicy.mockResolvedValue({ id: "policy-1" });
    const body = { kind: "WAIVER", slug: "synthetic-waiver", name: "Synthetic waiver", title: "Synthetic title", bodyText: "Placeholder body." };

    const response = await createPolicy(jsonRequest(body), { params: Promise.resolve({ eventId: "event-1" }) });

    expect(response.status).toBe(201);
    expect(dependencies.requirePermission).toHaveBeenCalledWith(expect.anything(), "event-1", "CONFIGURE_EVENT", dependencies.findActiveMembership);
    expect(dependencies.createConsentPolicy).toHaveBeenCalledWith("event-1", "user-1", body);
  });

  it("rejects cross-origin writes before authorization", async () => {
    dependencies.rejectCrossOriginRequest.mockReturnValue(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));

    const response = await publishPolicy(jsonRequest({}), { params: Promise.resolve({ eventId: "event-1", policyId: "policy-1" }) });

    expect(response.status).toBe(403);
    expect(dependencies.requirePermission).not.toHaveBeenCalled();
    expect(dependencies.publishPolicyVersion).not.toHaveBeenCalled();
  });

  it("answers an edit of a published version with a conflict", async () => {
    dependencies.updateDraftPolicyVersion.mockRejectedValue(new dependencies.MockConsentPolicyError("VERSION_IMMUTABLE", "Published policy versions cannot be changed."));

    const response = await editVersion(
      jsonRequest({ title: "Synthetic", bodyText: "Placeholder." }, "PATCH"),
      { params: Promise.resolve({ eventId: "event-1", policyId: "policy-1", versionId: "version-1" }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "VERSION_IMMUTABLE" });
  });

  it("reports a policy outside the event as not found", async () => {
    dependencies.createEventPolicyApplicability.mockRejectedValue(new dependencies.MockConsentPolicyError("POLICY_NOT_FOUND", "That policy was not found for this event."));

    const response = await createApplicability(jsonRequest({ policyId: "policy-elsewhere" }), { params: Promise.resolve({ eventId: "event-1" }) });

    expect(response.status).toBe(404);
  });
});
