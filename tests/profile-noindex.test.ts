import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// #646: both profile pages hold account details, so neither may be indexed or cached.
describe("profile pages are noindex, nocache (#646)", () => {
  it.each([
    ["/profile", () => import("@/app/(workspace)/profile/page")],
    ["/account/profile", () => import("@/app/(public)/account/(portal)/profile/page")],
  ])("%s sets robots index: false, follow: false, nocache: true", async (_name, load) => {
    const { metadata } = await load();
    expect(metadata.robots).toMatchObject({ index: false, follow: false, nocache: true });
  });
});
