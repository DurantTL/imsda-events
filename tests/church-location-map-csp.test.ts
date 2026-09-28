import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const tileOrigin = "https://tile.openstreetmap.org";
const locationPath = "/admin/organizations/org_synthetic_church/location";

// Next.js applies every matching header rule in order and, for a key set by
// more than one rule, sends the last value: one header, not several. This
// mirrors that for the `:name` and `:name*` patterns next.config.ts uses.
function sourceMatches(source: string, pathname: string) {
  const pattern = source
    .replace(/:[A-Za-z]+\*/g, ".*")
    .replace(/:[A-Za-z]+/g, "[^/]+");
  return new RegExp(`^${pattern}$`).test(pathname);
}

async function sentHeaders(pathname: string) {
  vi.resetModules();
  const nextConfig = (await import("../next.config")).default;
  const rules = (await nextConfig.headers?.()) ?? [];
  const sent = new Map<string, string>();
  for (const rule of rules.filter((candidate) => sourceMatches(candidate.source, pathname))) {
    for (const header of rule.headers) {
      // A later rule's value for the same key replaces the earlier one.
      sent.set(header.key.toLowerCase(), header.value);
    }
  }
  return sent;
}

describe("church location map: Content-Security-Policy (#542)", () => {
  it("sends one policy for the location page, and it admits the tile origin", async () => {
    const policy = (await sentHeaders(locationPath)).get("content-security-policy") ?? "";
    const directives = policy.split("; ");

    expect(directives.filter((entry) => entry.startsWith("default-src "))).toHaveLength(1);
    expect(directives.find((entry) => entry.startsWith("img-src "))?.split(" ")).toContain(tileOrigin);
  });

  it("does not admit the tile origin on the neighbouring staff pages", async () => {
    for (const pathname of ["/admin", "/admin/organizations", "/admin/organizations/org_synthetic_church"]) {
      const policy = (await sentHeaders(pathname)).get("content-security-policy") ?? "";
      expect(policy).not.toContain(tileOrigin);
    }
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("church location map: reaching the page (#542)", () => {
  // A Content-Security-Policy belongs to the document. A client-side
  // navigation (<Link>, router.push) keeps the policy of the page it left,
  // so arriving at the location page that way blocks every map tile. Only a
  // full page load gets the page's own policy.
  it("links to the location page with a plain anchor, never a client-side Link or router call", () => {
    const root = path.resolve(__dirname, "..");
    const pageHref = /\/admin\/organizations\/\$\{[^}]+\}\/location(?![A-Za-z/])/g;
    const anchors: string[] = [];
    const offenders: string[] = [];

    for (const file of [...sourceFiles(path.join(root, "app")), ...sourceFiles(path.join(root, "components"))]) {
      const source = readFileSync(file, "utf8");
      const relative = path.relative(root, file);
      for (const match of source.matchAll(pageHref)) {
        const index = match.index ?? 0;
        if (source.slice(Math.max(0, index - 5), index).includes("api")) continue;
        const before = source.slice(0, index);
        const tag = /<([A-Za-z]+)[^<]*$/.exec(before)?.[1];
        const call = /(router\.(?:push|replace)|redirect|prefetch)\(\s*`?$/.exec(before);
        if (tag === "a") anchors.push(relative);
        else offenders.push(`${relative}: ${call?.[1] ?? tag ?? "unknown"}`);
      }
    }

    expect(offenders).toEqual([]);
    expect(anchors).toEqual(["components/organization-directory-workspace.tsx"]);
  });
});
