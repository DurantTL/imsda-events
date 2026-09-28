import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Authenticated and token pages stay out of search indexes (#108). Child pages
// inherit a layout's `robots` unless they set their own.
describe("authenticated pages are noindex (#108)", () => {
  it.each([
    ["the staff workspace layout", () => import("@/app/(workspace)/layout")],
    ["the club portal layout", () => import("@/app/(public)/account/(portal)/clubs/[organizationId]/layout")],
    ["staff sign-in", () => import("@/app/login/page")],
    ["no access", () => import("@/app/no-access/page")],
    ["event setup", () => import("@/app/event-setup/page")],
    ["forgot password", () => import("@/app/forgot-password/page")],
    ["reset password", () => import("@/app/reset-password/page")],
  ])("%s sets robots index: false", async (_name, load) => {
    const { metadata } = await load();
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });
});
