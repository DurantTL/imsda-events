import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `?next=` deep links for staff (#108): a signed-out request to a workspace
 * page goes to `/login?next=<path and query>`, and post-login routing sends
 * the person back there. Everything is synthetic.
 */

const mocks = vi.hoisted(() => ({
  requestTarget: null as string | null,
  headersThrows: false,
  getCurrentSession: vi.fn(),
  listEventsForUser: vi.fn(),
  readLastUsedEventId: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => {
    if (mocks.headersThrows) throw new Error("outside a request scope");
    return new Headers(mocks.requestTarget === null ? {} : { "x-imsda-request-target": mocks.requestTarget });
  },
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({
  listEventsForUser: mocks.listEventsForUser,
  findActiveMembership: vi.fn(),
}));
vi.mock("@/modules/events/last-used-event", () => ({ readLastUsedEventId: mocks.readLastUsedEventId }));

import { NextRequest } from "next/server";
import { config, proxy } from "@/proxy";
import { staffLoginPathFor } from "@/modules/access/login-routing";
import { resolvePostLoginDestination } from "@/modules/access/post-login-destination";
import { loadWorkspaceEventContext } from "@/modules/events/selection";

afterEach(() => {
  mocks.requestTarget = null;
  mocks.headersThrows = false;
  vi.clearAllMocks();
});

async function redirectedTo(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("REDIRECT:")) return message.slice("REDIRECT:".length);
    throw error;
  }
  throw new Error("expected a redirect");
}

describe("signed-out workspace request", () => {
  it("redirects to /login?next= carrying the original path and query", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    mocks.requestTarget = "/more/documents?event=evt_synthetic";

    const destination = await redirectedTo(() => loadWorkspaceEventContext());

    expect(destination).toBe(`/login?next=${encodeURIComponent("/more/documents?event=evt_synthetic")}`);
  });

  it("falls back to a plain /login without a recorded path or outside a request", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    expect(await redirectedTo(() => loadWorkspaceEventContext())).toBe("/login");

    mocks.headersThrows = true;
    expect(await redirectedTo(() => loadWorkspaceEventContext())).toBe("/login");
  });

  it("never reflects an unsafe recorded target", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil"]) {
      mocks.requestTarget = bad;
      expect(await redirectedTo(() => loadWorkspaceEventContext())).toBe("/login");
    }
  });
});

describe("staffLoginPathFor", () => {
  it("encodes a safe path and query", () => {
    expect(staffLoginPathFor("/admin/team?tab=a&b=c")).toBe(`/login?next=${encodeURIComponent("/admin/team?tab=a&b=c")}`);
  });

  it.each(["//evil.com", "https://evil.com", "/\\evil", "javascript:alert(1)", "/api/secret", "/%2F%2Fevil.com", "", null, undefined])(
    "uses a plain /login for %s",
    (value) => {
      expect(staffLoginPathFor(value)).toBe("/login");
    },
  );

  it("does not loop back into the sign-in page", () => {
    expect(staffLoginPathFor("/login?next=/overview")).toBe("/login");
  });
});

describe("post-login return", () => {
  const staff = { id: "usr_synthetic_staff", globalRole: null };

  it("sends the person back to the page they started from", async () => {
    mocks.listEventsForUser.mockResolvedValue([{ id: "evt_a" }, { id: "evt_b" }]);
    mocks.readLastUsedEventId.mockResolvedValue(null);
    const next = "/more/documents?event=evt_b";
    const loginPath = staffLoginPathFor(next);
    const carried = new URL(loginPath, "https://events.imsda.test").searchParams.get("next");

    expect(await resolvePostLoginDestination(staff, { returnTo: carried })).toBe(next);
  });

  it.each(["//evil.com", "https://evil.com", "/\\evil"])("ignores a malicious next of %s", async (bad) => {
    mocks.listEventsForUser.mockResolvedValue([{ id: "evt_only" }]);
    mocks.readLastUsedEventId.mockResolvedValue(null);

    expect(await resolvePostLoginDestination(staff, { returnTo: bad })).toBe("/overview?event=evt_only");
  });
});

describe("proxy", () => {
  it("records the path and query on the request and touches nothing else", () => {
    const request = new NextRequest("https://events.imsda.test/more/documents?event=evt_1", {
      headers: { "x-imsda-request-target": "//evil.com" },
    });
    const response = proxy(request);

    expect(response.headers.get("x-middleware-request-x-imsda-request-target")).toBe("/more/documents?event=evt_1");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("matches workspace pages but not assets, API routes or public pages", () => {
    const matchers = config.matcher.map((source) => new RegExp(`^${source.replace(/\/:path\*$/, "(?:/.*)?")}$`));
    const matches = (path: string) => matchers.some((matcher) => matcher.test(path));

    expect(matches("/admin/team")).toBe(true);
    expect(matches("/more/documents")).toBe(true);
    expect(matches("/select-event")).toBe(true);
    for (const path of ["/_next/static/app.js", "/_next/image", "/favicon.ico", "/api/auth/login", "/events/x", "/login", "/robots.txt"]) {
      expect(matches(path)).toBe(false);
    }
  });
});
