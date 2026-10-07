import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; displayName: string; globalRole: string; accountStatus: string } },
  membership: null as null | { role: string; status: string; permissions: string[] },
  stored: [] as Array<{ title: string; body: string; isPublished: boolean }>,
  created: [] as Array<Record<string, unknown>>,
  deleted: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: async () => state.session ?? { user: null } }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: async () => state.membership }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: () => null }));
vi.mock("@/lib/prisma", () => {
  const tx = {
    eventAsset: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, contentType: "image/png" })) },
    eventContentSection: {
      findMany: async () => state.stored,
      deleteMany: async () => { state.deleted += 1; },
      create: async ({ data }: { data: Record<string, unknown> }) => { state.created.push(data); },
    },
    auditLog: { create: async () => ({}) },
  };
  return {
    getPrisma: () => ({
      ...tx,
      $transaction: async (run: (client: typeof tx) => unknown) => run(tx),
    }),
  };
});

import { PUT } from "@/app/api/events/[eventId]/content/route";
import { POST as previewHtml } from "@/app/api/events/[eventId]/content/html-preview/route";

const user = (globalRole: string) => ({
  user: { id: "user-1", email: "person@example.org", displayName: "Synthetic Person", globalRole, accountStatus: "ACTIVE" },
});
const context = { params: Promise.resolve({ eventId: "event-1" }) };
const put = (sections: unknown[]) => PUT(
  new Request("https://events.imsda.test/api/events/event-1/content", {
    method: "PUT",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify({ sections }),
  }),
  context,
);
const post = (html: string) => previewHtml(
  new Request("https://events.imsda.test/api/events/event-1/content/html-preview", {
    method: "POST",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify({ html }),
  }),
  context,
);

const htmlBlock = (patch: Record<string, unknown> = {}) => ({
  kind: "CUSTOM_HTML",
  title: "Welcome banner",
  body: `<p>Hello</p><script>alert(1)</script>`,
  isPublished: true,
  ...patch,
});
const textBlock = { kind: "RICH_TEXT", title: "About", body: "Plain text.", isPublished: true };

beforeEach(() => {
  state.session = user("USER");
  state.membership = { role: "EVENT_ADMIN", status: "ACTIVE", permissions: [] };
  state.stored = [];
  state.created = [];
  state.deleted = 0;
});

describe("custom HTML is system-administrator only, on the server (#816)", () => {
  it("refuses an event admin who adds an HTML block, and writes nothing", async () => {
    const response = await put([textBlock, htmlBlock()]);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("CUSTOM_HTML_FORBIDDEN");
    expect(state.deleted).toBe(0);
    expect(state.created).toHaveLength(0);
  });

  it("refuses an event admin who edits an existing HTML block", async () => {
    state.stored = [{ title: "Welcome banner", body: "<p>Original</p>", isPublished: true }];
    const response = await put([htmlBlock({ body: "<p>Changed by an event admin</p>" })]);
    expect(response.status).toBe(403);
    expect(state.created).toHaveLength(0);
  });

  it("refuses an event admin who retitles or removes an existing HTML block", async () => {
    state.stored = [{ title: "Welcome banner", body: "<p>Original</p>", isPublished: true }];
    expect((await put([htmlBlock({ body: "<p>Original</p>", title: "New title" })])).status).toBe(403);
    expect((await put([textBlock])).status).toBe(403);
    expect(state.created).toHaveLength(0);
  });

  it("lets an event admin save other blocks and carry an existing HTML block back unchanged", async () => {
    state.stored = [{ title: "Welcome banner", body: "<p>Original</p>", isPublished: true }];
    const response = await put([textBlock, htmlBlock({ body: "<p>Original</p>" })]);
    expect(response.status).toBe(200);
    expect(state.created.map((row) => row.kind)).toEqual(["RICH_TEXT", "CUSTOM_HTML"]);
  });

  it("lets an event admin without HTML blocks save as before", async () => {
    expect((await put([textBlock])).status).toBe(200);
  });

  it("does not let an event admin smuggle the block in under another kind's body", async () => {
    // Only CUSTOM_HTML keeps raw HTML; a RICH_TEXT body is plain text rendered by React.
    const response = await put([{ ...textBlock, body: "<script>alert(1)</script>" }]);
    expect(response.status).toBe(200);
    expect(state.created[0].kind).toBe("RICH_TEXT");
  });

  it("refuses an event admin who publishes or unpublishes an existing HTML block, and writes nothing", async () => {
    state.stored = [{ title: "Welcome banner", body: "<p>Original</p>", isPublished: true }];
    const response = await put([htmlBlock({ body: "<p>Original</p>", isPublished: false })]);
    expect(response.status).toBe(403);
    expect(state.created).toHaveLength(0);
    state.stored = [{ title: "Welcome banner", body: "<p>Original</p>", isPublished: false }];
    expect((await put([htmlBlock({ body: "<p>Original</p>", isPublished: true })])).status).toBe(403);
    expect(state.created).toHaveLength(0);
  });

  it("lets an event admin reorder an HTML block", async () => {
    state.stored = [{ title: "Welcome banner", body: "<p>Original</p>", isPublished: true }];
    const response = await put([htmlBlock({ body: "<p>Original</p>" }), textBlock]);
    expect(response.status).toBe(200);
    expect(state.created.map((row) => row.kind)).toEqual(["CUSTOM_HTML", "RICH_TEXT"]);
  });

  it("stores HTML trimmed, so an event admin can save the page unchanged afterwards (edge whitespace, trailing comment)", async () => {
    state.session = user("SYSTEM_ADMIN");
    state.membership = null;
    for (const body of ["<p>Hello</p>\n<!-- note -->", "  \n<p>Hello</p>\n  ", "<!-- a --><p>Hello</p>\n<!-- b -->\n"]) {
      state.created = [];
      expect((await put([htmlBlock({ body })])).status).toBe(200);
      const stored = String(state.created[0].body);
      expect(stored).toBe(stored.trim());
      // The event admin's editor sends back what was stored.
      state.session = user("USER");
      state.membership = { role: "EVENT_ADMIN", status: "ACTIVE", permissions: [] };
      state.stored = [{ title: "Welcome banner", body: stored, isPublished: true }];
      state.created = [];
      expect((await put([htmlBlock({ body: stored })])).status, body).toBe(200);
      // Rows saved before the trim fix may still carry edge whitespace.
      state.stored = [{ title: "Welcome banner", body: `${stored}\n`, isPublished: true }];
      expect((await put([htmlBlock({ body: stored })])).status, body).toBe(200);
      state.session = user("SYSTEM_ADMIN");
      state.membership = null;
    }
  });

  it("keeps the header banner first, whatever order is sent", async () => {
    const hero = { kind: "HERO", title: "Banner", isPublished: true, data: { assetId: "a1", alt: "x" } };
    const response = await put([textBlock, hero]);
    expect(response.status).toBe(200);
    expect(state.created.map((row) => row.kind)).toEqual(["HERO", "RICH_TEXT"]);
  });

  it("lets a system administrator add an HTML block, and stores it sanitized", async () => {
    state.session = user("SYSTEM_ADMIN");
    state.membership = null;
    const response = await put([htmlBlock({ body: `<p onclick="x()">Hello</p><script>alert(1)</script><a href="javascript:alert(1)">go</a>` })]);
    expect(response.status).toBe(200);
    const body = String(state.created[0].body);
    expect(body).toContain("<p>Hello</p>");
    expect(body).not.toMatch(/script|onclick|javascript:/i);
  });

  it("refuses a visitor with no session and a staff member with no CONFIGURE_EVENT", async () => {
    state.session = null;
    expect((await put([textBlock])).status).toBe(401);
    state.session = user("USER");
    state.membership = { role: "READ_ONLY_STAFF", status: "ACTIVE", permissions: [] };
    const response = await put([htmlBlock()]);
    expect(response.status).toBe(403);
    expect(state.created).toHaveLength(0);
  });

  it("keeps the HTML preview for system administrators", async () => {
    expect((await post("<p>x</p>")).status).toBe(403);
    state.session = user("SYSTEM_ADMIN");
    const response = await post(`<p>x</p><script>alert(1)</script>`);
    expect(response.status).toBe(200);
    expect((await response.json()).html).toBe("<p>x</p>");
  });
});
