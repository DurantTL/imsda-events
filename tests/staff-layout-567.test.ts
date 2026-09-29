import { readFileSync } from "node:fs";
import path from "node:path";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: vi.fn() }));

const globalsCss = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

function rule(selector: string) {
  const escaped = selector.replace(/[.]/g, "\\.");
  const match = globalsCss.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`));
  expect(match, `${selector} rule`).not.toBeNull();
  return match![1];
}

describe("staff sidebar stays reachable at short heights (#567 F-5, regression of #468)", () => {
  it("scrolls the fixed sidebar itself when its contents are taller than the window", () => {
    const sidebar = rule(".sidebar");
    expect(sidebar).toMatch(/position:\s*fixed/);
    expect(sidebar).toMatch(/overflow-y:\s*auto/);
  });

  it("lets the primary nav shrink and scroll inside the flex column", () => {
    const nav = rule(".primary-nav");
    expect(nav).toMatch(/min-height:\s*0/);
    expect(nav).toMatch(/overflow-y:\s*auto/);
  });
});

describe("/dashboard redirects to the staff overview (#567 F-27)", () => {
  it("redirects exactly /dashboard to /overview", async () => {
    vi.resetModules();
    const nextConfig = (await import("../next.config")).default;
    const rules = (await nextConfig.redirects?.()) ?? [];
    const found = rules.find((candidate) => candidate.source === "/dashboard");
    expect(found).toMatchObject({ destination: "/overview", permanent: false });
    const matches = (pathname: string) =>
      getPathMatch(found!.source, { removeUnnamedParams: true, strict: true })(pathname) !== false;
    expect(matches("/dashboard")).toBe(true);
    expect(matches("/dashboard/anything")).toBe(false);
  });
});
