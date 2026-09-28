import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A client component must never reach a Node-only module (#550). Under
 * `next dev --webpack`, `node:crypto` in a client bundle fails the build. This
 * walks static imports from every "use client" file in components/ and app/
 * and reports any path that reaches a `node:` import, a bare Node built-in
 * (`"crypto"`, `"fs"`), or `server-only`.
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

/** Runtime import specifiers in a file; fully type-only statements are skipped. */
export function runtimeSpecifiers(text: string) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const specifiers = new Set<string>();
  // import/export ... from "x". The clause is limited to identifier, brace,
  // comma and star characters so it cannot swallow code between statements.
  const fromStatement = /\b(?:import|export)(?![\w$])\s*(type\s+)?([\w$*\s,{}]*?)\bfrom\s*(["'])([^"']+)\3/g;
  for (const match of code.matchAll(fromStatement)) {
    const clause = match[2]!.trim();
    const named = /^\{([^}]*)\}$/.exec(clause);
    const names = named ? named[1]!.split(",").map((part) => part.trim()).filter(Boolean) : [];
    // `import type X`, `export type { X }` and `import { type A, type B }` are erased entirely by TypeScript.
    const typeOnly = Boolean(match[1]) || (names.length > 0 && names.every((name) => /^type\s/.test(name)));
    if (!typeOnly) specifiers.add(match[4]!);
  }
  const others = [
    /\bimport\s*(["'])([^"']+)\1/g,
    /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g,
    /\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/g,
  ];
  for (const pattern of others) for (const match of code.matchAll(pattern)) specifiers.add(match[2]!);
  return [...specifiers];
}

const NODE_BUILTINS = new Set(builtinModules);

/** Node-only specifiers: `node:` prefixed, bare built-ins such as "crypto", and `server-only`. */
export function isForbiddenSpecifier(specifier: string) {
  return specifier.startsWith("node:") || specifier === "server-only" || NODE_BUILTINS.has(specifier);
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
      if (isForbiddenSpecifier(specifier)) {
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

  it("skips fully type-only statements and flags node: imports", () => {
    expect(runtimeSpecifiers(`import { createHash } from "node:crypto";\nimport type { A } from "./a";\nimport { type B } from "./b";`)).toEqual(["node:crypto"]);
  });

  it("keeps a path when a type-only import and a runtime import share it", () => {
    expect(runtimeSpecifiers(`import { type A } from "./x";\nimport { b } from "./x";`)).toEqual(["./x"]);
    expect(runtimeSpecifiers(`import { b } from "./z";\nimport { type A } from "./z";`)).toEqual(["./z"]);
    expect(runtimeSpecifiers(`import { type A, b } from "./y";`)).toEqual(["./y"]);
    expect(runtimeSpecifiers(`export type { A } from "./t";`)).toEqual([]);
  });

  it("matches imports written without spaces", () => {
    expect(runtimeSpecifiers(`import{c}from"node:fs";`)).toEqual(["node:fs"]);
    expect(runtimeSpecifiers(`import*as p from"node:path";`)).toEqual(["node:path"]);
    expect(runtimeSpecifiers(`import"node:os";`)).toEqual(["node:os"]);
    expect(runtimeSpecifiers(`export{c}from"./c";`)).toEqual(["./c"]);
    expect(runtimeSpecifiers(`import{type A}from"./a";`)).toEqual([]);
  });

  it("flags bare Node built-ins as well as node: and server-only", () => {
    for (const specifier of ["crypto", "fs", "fs/promises", "node:crypto", "server-only"]) {
      expect(isForbiddenSpecifier(specifier)).toBe(true);
    }
    for (const specifier of ["react", "./crypto", "@/lib/fs", "next/link"]) {
      expect(isForbiddenSpecifier(specifier)).toBe(false);
    }
    expect(runtimeSpecifiers(`import { createHash } from "crypto";`).some(isForbiddenSpecifier)).toBe(true);
  });

  it.each(clientFiles.map((file) => [path.relative(root, file), file] as const))("%s reaches no node: or server-only module", (_name, file) => {
    expect(forbiddenChains(file)).toEqual([]);
  });
});
