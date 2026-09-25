import { afterEach, describe, expect, it, vi } from "vitest";

const squareWebOrigins = [
  "https://web.squarecdn.com",
  "https://sandbox.web.squarecdn.com",
];
const squarePciOrigins = [
  "https://pci-connect.squareup.com",
  "https://pci-connect.squareupsandbox.com",
];
const originalSquareEnvironment = process.env.SQUARE_ENVIRONMENT;
const originalSquareProductionEnabled = process.env.SQUARE_ENABLE_PRODUCTION;

function setBuildEnvironment(
  squareEnvironment: string | undefined,
  squareProductionEnabled: string | undefined,
) {
  if (squareEnvironment === undefined) {
    delete process.env.SQUARE_ENVIRONMENT;
  } else {
    process.env.SQUARE_ENVIRONMENT = squareEnvironment;
  }

  if (squareProductionEnabled === undefined) {
    delete process.env.SQUARE_ENABLE_PRODUCTION;
  } else {
    process.env.SQUARE_ENABLE_PRODUCTION = squareProductionEnabled;
  }
}

function directiveSources(policy: string, directive: string) {
  const value = policy
    .split("; ")
    .find((entry) => entry.startsWith(`${directive} `));

  if (!value) {
    throw new Error(`Missing ${directive} directive`);
  }

  return value.split(" ").slice(1);
}

async function compiledContentSecurityPolicies() {
  vi.resetModules();
  const nextConfig = (await import("../next.config")).default;
  const headerRules = await nextConfig.headers?.();

  if (!headerRules) {
    throw new Error("Next.js headers configuration is missing");
  }

  return headerRules
    .flatMap((rule) => rule.headers)
    .filter((header) => header.key === "Content-Security-Policy")
    .map((header) => header.value);
}

afterEach(() => {
  setBuildEnvironment(
    originalSquareEnvironment,
    originalSquareProductionEnabled,
  );
});

describe("compiled Content Security Policy", () => {
  it.each([
    {
      name: "build variables are absent",
      squareEnvironment: undefined,
      squareProductionEnabled: undefined,
    },
    {
      name: "Sandbox is selected",
      squareEnvironment: "sandbox",
      squareProductionEnabled: "false",
    },
    {
      name: "Production is selected",
      squareEnvironment: "production",
      squareProductionEnabled: "true",
    },
  ])("permits both Square environments when $name", async ({
    squareEnvironment,
    squareProductionEnabled,
  }) => {
    setBuildEnvironment(squareEnvironment, squareProductionEnabled);

    const policies = await compiledContentSecurityPolicies();

    expect(policies).toHaveLength(3);
    for (const policy of policies) {
      for (const directive of [
        "script-src",
        "style-src",
        "connect-src",
        "frame-src",
      ]) {
        expect(directiveSources(policy, directive)).toEqual(
          expect.arrayContaining(squareWebOrigins),
        );
      }

      expect(directiveSources(policy, "connect-src")).toEqual(
        expect.arrayContaining(squarePciOrigins),
      );
      for (const directive of ["script-src", "style-src", "frame-src"]) {
        for (const origin of squarePciOrigins) {
          expect(directiveSources(policy, directive)).not.toContain(origin);
        }
      }

      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("base-uri 'self'");
      expect(policy).toContain("form-action 'self'");
    }
  });

  it("admits OpenStreetMap tiles on /clubs only, as that page's single policy (#437)", async () => {
    vi.resetModules();
    const nextConfig = (await import("../next.config")).default;
    const rules = (await nextConfig.headers?.()) ?? [];
    const cspRules = rules
      .map((rule, index) => ({
        index,
        source: rule.source,
        policy: rule.headers.find((header) => header.key === "Content-Security-Policy")?.value,
      }))
      .filter((rule): rule is { index: number; source: string; policy: string } => rule.policy !== undefined);

    const tileOrigin = "https://tile.openstreetmap.org";
    const siteWide = cspRules.find((rule) => rule.source === "/:path*");
    const clubs = cspRules.find((rule) => rule.source === "/clubs");
    if (!siteWide || !clubs) throw new Error("Missing site-wide or /clubs policy");

    for (const rule of cspRules.filter((candidate) => candidate.source !== "/clubs")) {
      expect(rule.policy).not.toContain(tileOrigin);
    }
    expect(directiveSources(clubs.policy, "img-src")).toContain(tileOrigin);

    // Same policy otherwise: only img-src differs.
    expect(clubs.policy.replace(` ${tileOrigin}`, "")).toBe(siteWide.policy);

    // Both rules match /clubs and set the same key; Next.js sends the last
    // one, so the /clubs rule must come after the site-wide rule.
    expect(clubs.index).toBeGreaterThan(siteWide.index);
    expect(cspRules.filter((rule) => rule.source === "/clubs")).toHaveLength(1);
  });
});
