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

    expect(policies).toHaveLength(2);
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
});
