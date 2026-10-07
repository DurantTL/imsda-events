import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void) => effect(),
}));

import { EventEmbedFullLoad } from "@/components/event-embed-full-load";

function setup(loadedPath: string, currentPath: string, store: Map<string, string>) {
  const reload = vi.fn();
  vi.stubGlobal("performance", { getEntriesByType: () => [{ name: `https://events.example.test${loadedPath}` }] });
  vi.stubGlobal("window", {
    location: { pathname: currentPath, reload },
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
  });
  return reload;
}

describe("embed reload after client-side navigation (#816)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-07T12:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("never reloads a normal page load", () => {
    const reload = setup("/events/x", "/events/x/", new Map());
    EventEmbedFullLoad();
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads once when the page was reached by client-side navigation", () => {
    const store = new Map<string, string>();
    const reload = setup("/", "/events/x", store);
    EventEmbedFullLoad();
    expect(reload).toHaveBeenCalledTimes(1);
    // A second run straight away (a loop) is refused.
    EventEmbedFullLoad();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads again for a later navigation to the same page in the same tab", () => {
    const store = new Map<string, string>();
    const reload = setup("/", "/events/x", store);
    EventEmbedFullLoad();
    // The reloaded document is a normal load, which clears the guard.
    setup("/events/x", "/events/x", store);
    EventEmbedFullLoad();
    expect(store.size).toBe(0);
    const again = setup("/", "/events/x", store);
    EventEmbedFullLoad();
    expect(again).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("expires the loop guard, so a stale one never blocks a new navigation", () => {
    const store = new Map<string, string>();
    const reload = setup("/", "/events/x", store);
    EventEmbedFullLoad();
    vi.setSystemTime(new Date("2026-10-07T12:01:00Z"));
    EventEmbedFullLoad();
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
