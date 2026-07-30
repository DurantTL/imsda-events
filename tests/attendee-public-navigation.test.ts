import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getServerEnv: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  getServerEnv: dependencies.getServerEnv,
}));

import { attendeePublicUrl } from "@/modules/attendee-accounts/public-navigation";

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getServerEnv.mockReturnValue({
    APP_BASE_URL: "https://events.imsda.org",
  });
});

describe("attendee public navigation", () => {
  it("uses the configured public application origin", () => {
    expect(attendeePublicUrl("/account").toString())
      .toBe("https://events.imsda.org/account");
  });

  it("preserves attendee sign-in query parameters", () => {
    expect(attendeePublicUrl("/account/sign-in?error=google-expired").toString())
      .toBe("https://events.imsda.org/account/sign-in?error=google-expired");
  });
});
