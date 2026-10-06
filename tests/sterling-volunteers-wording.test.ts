import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Naming (#443): every user-facing "background check" is "Sterling Volunteers",
 * which covers both the background check and the required training. Code
 * identifiers (`backgroundCheck…`, `background-checks` routes and modules,
 * `background_check_*` keys, enums and columns) keep their names; they never
 * contain the spaced words this test looks for.
 */
const root = process.cwd();
const scanned = ["app", "components", "modules", "lib", "docs", "README.md"];
const extensions = new Set([".ts", ".tsx", ".md", ".mdx", ".css"]);

/** Files that may keep the old words, with the reason. Empty on purpose. */
const allowlist: Record<string, string> = {};

function files(entry: string): string[] {
  const full = path.join(root, entry);
  const stat = statSync(full);
  if (stat.isFile()) return [entry];
  return readdirSync(full).flatMap((name) => {
    if (name === "node_modules" || name === ".next") return [];
    return files(path.join(entry, name));
  });
}

describe("Sterling Volunteers wording (#443)", () => {
  const sources = scanned.flatMap(files).filter((file) => extensions.has(path.extname(file)));

  it("scans a meaningful set of files", () => {
    expect(sources.length).toBeGreaterThan(200);
    expect(sources).toContain("components/background-check-flags.tsx");
    expect(sources).toContain("modules/background-checks/domain.ts");
  });

  it("leaves no user-facing \"background check\" wording in the app, components, modules (emails, CSVs, flags) or docs", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      if (allowlist[file]) continue;
      readFileSync(path.join(root, file), "utf8").split(/\r?\n/).forEach((line, index) => {
        if (/background[ \t]+checks?\b/i.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("uses Sterling Volunteers for the CSV headers, flags and download names", () => {
    const domain = readFileSync(path.join(root, "modules/background-checks/domain.ts"), "utf8");
    expect(domain).toContain('"Confirmation code", "Sterling Volunteers", "Expired on"');
    const flags = readFileSync(path.join(root, "components/background-check-flags.tsx"), "utf8");
    expect(flags).toContain("Not in compliance with Sterling Volunteers");
    const template = readFileSync(path.join(root, "app/api/admin/background-checks/template/route.ts"), "utf8");
    expect(template).toContain("sterling-volunteers-");
  });
});
