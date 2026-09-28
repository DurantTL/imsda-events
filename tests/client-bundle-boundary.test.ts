import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A client component must never reach a Node-only module (#550). Under
 * `next dev --webpack`, `node:crypto` in a client bundle fails the build. This
 * walks static imports from every "use client" file in components/ and app/
 * and reports any path that reaches a `node:` import or `server-only`.
 * Type-only imports are erased at build time and are not followed.
 */

const root = path.resolve(__dirname, "..");
const SOURCE = /\.(ts|tsx)$/;

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" || name.startsWith(".") ? [] : listSources(full);
    return SOURCE.test(name) && !name.endsWith(".d.ts") ? [full] : [];
  });
}

function isClientFile(text: string) {
  return /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*(["'])use client\1/.test(text);
}

/** Runtime import specifiers in a file; `import type` and `export type` are skipped. */
function runtimeSpecifiers(text: string) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const specifiers = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?!type\b)[^"';]*?\sfrom\s*(["'])([^"']+)\1/g,
    /\bimport\s*(["'])([^"']+)\1/g,
    /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g,
    /\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) specifiers.add(match[2]!);
  // `import { type A, type B } from "x"` is erased entirely by TypeScript.
  for (const match of code.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2/g)) {
    const names = match[1]!.split(",").map((part) => part.trim()).filter(Boolean);
    if (names.length > 0 && names.every((name) => name.startsWith("type "))) specifiers.delete(match[3]!);
  }
  return [...specifiers];
}

function resolveLocal(specifier: string, from: string) {
  const base = specifier.startsWith("@/") ? path.join(root, specifier.slice(2)) : path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every chain from `start` that ends at a forbidden import. */
function forbiddenChains(start: string): string[] {
  const rel = (file: string) => path.relative(root, file);
  const seen = new Set<string>();
  const found: string[] = [];
  const visit = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith("node:") || specifier === "server-only") {
        found.push([...chain, rel(file), specifier].join(" -> "));
      } else if (specifier.startsWith("@/") || specifier.startsWith(".")) {
        const next = resolveLocal(specifier, file);
        if (next) visit(next, [...chain, rel(file)]);
      }
    }
  };
  visit(start, []);
  return found;
}

const clientFiles = ["components", "app"]
  .flatMap((dir) => listSources(path.join(root, dir)))
  .filter((file) => isClientFile(readFileSync(file, "utf8")));

describe("client bundle boundary (#550)", () => {
  it("finds the client components", () => {
    expect(clientFiles.length).toBeGreaterThan(10);
    expect(clientFiles.map((file) => path.relative(root, file))).toContain("components/club-roster-workspace.tsx");
  });

  it("skips type-only imports and flags node: imports", () => {
    expect(runtimeSpecifiers(`import { createHash } from "node:crypto";\nimport type { A } from "./a";\nimport { type B } from "./b";`)).toEqual(["node:crypto"]);
  });

  it.each(clientFiles.map((file) => [path.relative(root, file), file] as const))("%s reaches no node: or server-only module", (_name, file) => {
    expect(forbiddenChains(file)).toEqual([]);
  });
});
