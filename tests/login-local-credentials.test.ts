import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The seeded local sign-in (#688, audit F19): the "Local test account" box and
 * the prefilled credentials must never render in production, and the strings
 * must not live in the client module. Everything is synthetic.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: async () => ({ user: null }) }));
vi.mock("@/modules/access/passkeys", () => ({ passkeysConfigured: async () => false }));
vi.mock("@/modules/access/post-login-destination", () => ({ resolvePostLoginDestination: vi.fn() }));

import LoginPage from "@/app/login/page";
import * as loginFormModule from "@/components/login-form";
import { LOCAL_DEMO_EMAIL, LOCAL_DEMO_PASSWORD } from "@/modules/access/local-demo-credentials";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function renderLogin() {
  const page = await LoginPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(page);
}

describe("staff sign-in page", () => {
  it("never renders the local test account or its credentials in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const markup = await renderLogin();
    expect(markup).not.toContain("Local test account");
    expect(markup).not.toContain(LOCAL_DEMO_EMAIL);
    expect(markup).not.toContain(LOCAL_DEMO_PASSWORD);
    expect(markup).toContain("Staff sign in");
  });

  it("shows the local test account outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const markup = await renderLogin();
    expect(markup).toContain("Local test account");
    expect(markup).toContain(LOCAL_DEMO_EMAIL);
  });

  it("keeps the credentials out of the client module", () => {
    expect(loginFormModule).not.toHaveProperty("LOCAL_DEMO_EMAIL");
    expect(loginFormModule).not.toHaveProperty("LOCAL_DEMO_PASSWORD");
    const source = readFileSync("components/login-form.tsx", "utf8");
    expect(source).not.toContain(LOCAL_DEMO_EMAIL);
    expect(source).not.toContain(LOCAL_DEMO_PASSWORD);
  });
});
