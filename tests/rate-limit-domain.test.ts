import { describe, expect, it } from "vitest";
import {
  getRateLimitConfiguration,
  hashRateLimitIdentifier,
  mergeRateLimitOutcomes,
  rateLimitClientIdentityHash,
  rateLimitHeaders,
  RateLimitConfigurationError,
  type RateLimitConfiguration,
} from "@/modules/rate-limit/domain";

const productionConfiguration: RateLimitConfiguration = {
  environment: "production",
  hashSecret: "a-production-test-secret-that-is-long-enough",
  trustedProxyHops: 1,
  clientIpHeader: "x-forwarded-for",
};

describe("rate-limit identity and header domain", () => {
  it("requires a dedicated strong secret in production but supplies a local-only default", () => {
    expect(() => getRateLimitConfiguration({
      NODE_ENV: "production",
      RATE_LIMIT_HASH_SECRET: "too-short",
    })).toThrow(RateLimitConfigurationError);

    expect(getRateLimitConfiguration({
      NODE_ENV: "development",
    })).toMatchObject({
      environment: "development",
      trustedProxyHops: 0,
      clientIpHeader: "x-forwarded-for",
    });
  });

  it("hashes identifiers with namespace separation and never returns the raw value", () => {
    const value = "person@example.test";
    const emailHash = hashRateLimitIdentifier(
      "email",
      value,
      productionConfiguration,
    );
    const tokenHash = hashRateLimitIdentifier(
      "token",
      value,
      productionConfiguration,
    );

    expect(emailHash).toMatch(/^[a-f0-9]{64}$/);
    expect(emailHash).not.toContain(value);
    expect(tokenHash).not.toBe(emailHash);
  });

  it("selects the address immediately before the explicitly trusted proxy chain", () => {
    const oneProxyRequest = new Request("https://events.imsda.test/login", {
      headers: {
        "x-forwarded-for": "192.0.2.44, 203.0.113.10",
      },
    });
    expect(rateLimitClientIdentityHash(
      oneProxyRequest,
      productionConfiguration,
    )).toBe(hashRateLimitIdentifier(
      "client-ip",
      "203.0.113.10",
      productionConfiguration,
    ));

    const twoProxyConfiguration = {
      ...productionConfiguration,
      trustedProxyHops: 2,
    };
    const twoProxyRequest = new Request("https://events.imsda.test/login", {
      headers: {
        "x-forwarded-for": "192.0.2.44, 198.51.100.7, 10.0.0.2",
      },
    });
    expect(rateLimitClientIdentityHash(
      twoProxyRequest,
      twoProxyConfiguration,
    )).toBe(hashRateLimitIdentifier(
      "client-ip",
      "198.51.100.7",
      twoProxyConfiguration,
    ));
  });

  it("ignores spoofable forwarding headers unless proxy trust is configured", () => {
    const noProxyConfiguration = {
      ...productionConfiguration,
      trustedProxyHops: 0,
    };
    const first = rateLimitClientIdentityHash(
      new Request("https://events.imsda.test", {
        headers: { "x-forwarded-for": "192.0.2.1" },
      }),
      noProxyConfiguration,
    );
    const second = rateLimitClientIdentityHash(
      new Request("https://events.imsda.test", {
        headers: { "x-forwarded-for": "203.0.113.99" },
      }),
      noProxyConfiguration,
    );
    expect(first).toBe(second);
  });

  it("keeps local requests usable without trusting network headers", () => {
    const localConfiguration = getRateLimitConfiguration({
      NODE_ENV: "test",
      RATE_LIMIT_TRUSTED_PROXY_HOPS: "0",
    });
    const first = rateLimitClientIdentityHash(
      new Request("http://localhost:3000", {
        headers: { "user-agent": "local-browser-a" },
      }),
      localConfiguration,
    );
    const second = rateLimitClientIdentityHash(
      new Request("http://localhost:3000", {
        headers: { "user-agent": "local-browser-b" },
      }),
      localConfiguration,
    );
    expect(first).not.toBe(second);
  });

  it("reports the binding quota and the longest denied retry window truthfully", () => {
    const outcome = mergeRateLimitOutcomes(
      {
        allowed: false,
        decisions: [{
          policy: "short",
          allowed: false,
          limit: 5,
          remaining: 0,
          count: 6,
          windowSeconds: 60,
          resetAfterSeconds: 17,
        }],
      },
      {
        allowed: false,
        decisions: [{
          policy: "long",
          allowed: false,
          limit: 10,
          remaining: 0,
          count: 11,
          windowSeconds: 900,
          resetAfterSeconds: 411,
        }],
      },
    );

    expect(rateLimitHeaders(outcome)).toEqual({
      "RateLimit-Limit": "10",
      "RateLimit-Remaining": "0",
      "RateLimit-Reset": "411",
      "RateLimit-Policy": "5;w=60, 10;w=900",
      "Retry-After": "411",
    });
  });
});
