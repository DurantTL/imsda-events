import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  account: null as { id: string; verifiedEmail: string | null } | null,
}));

vi.mock("@/modules/attendee-accounts/current-attendee", () => ({
  getCurrentAttendee: async () => ({ account: mocks.account }),
}));
vi.mock("@/modules/forms/public-repository", () => ({
  getPublicRegistrationExperience: async () => ({
    event: { name: "Synthetic Retreat", slug: "synthetic-retreat", startsAt: new Date("2026-10-09T00:00:00Z"), endsAt: new Date("2026-10-11T00:00:00Z"), timezone: "America/Chicago", location: null, capacity: null, billingMode: "ATTENDEE_PAY" },
    form: { slug: "main", versionId: "version-1", versionNumber: 1, definition: { title: "Synthetic", sections: [] } },
    choiceUsage: {},
    pricingDate: "2026-09-29",
    lifecycle: { phase: "OPEN", capacityDecision: "REGISTER", remainingSpots: null, waitingRegistrations: 0 },
  }),
}));

import EmbeddedRegistrationPage from "@/app/(public)/embed/[eventSlug]/[formSlug]/page";

function findFormProps(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const element = node as ReactElement<{ children?: unknown } & Record<string, unknown>>;
  if (element.props && "form" in element.props && "lifecycle" in element.props) return element.props;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findFormProps(child);
    if (found) return found;
  }
  return null;
}

async function renderEmbed() {
  const tree = await EmbeddedRegistrationPage({ params: Promise.resolve({ eventSlug: "synthetic-retreat", formSlug: "main" }) });
  return findFormProps(tree);
}

describe("embed page drafts (#574)", () => {
  beforeEach(() => {
    mocks.account = null;
  });

  it("disables browser drafts for a signed-in attendee", async () => {
    mocks.account = { id: "account-1", verifiedEmail: "guest@example.test" };
    expect((await renderEmbed())?.disableDrafts).toBe(true);
  });

  it("keeps drafts available for an anonymous visitor", async () => {
    expect((await renderEmbed())?.disableDrafts).toBe(false);
  });
});

describe("form wiring guards (#574)", () => {
  const source = readFileSync("components/public-registration-form.tsx", "utf8");
  const body = (name: string) => {
    const start = source.indexOf(`function ${name}(`);
    return source.slice(start, source.indexOf("\n  }\n", start));
  };

  it("clears the idempotency key when an attendee answer changes", () => {
    expect(body("setAttendeeFieldValue")).toContain("setIdempotencyKey(null)");
  });

  it("never restores or stores the idempotency key from a draft", () => {
    expect(source).not.toContain("draft.idempotencyKey");
  });

  it("start another registration resets the dirty flag and the initial state", () => {
    const fn = body("startAnotherRegistration");
    expect(fn).toContain("setDraftDirty(false)");
    expect(fn).toContain("buildInitialAttendees()");
    expect(fn).toContain("setResponses(initialResponses)");
  });
});
