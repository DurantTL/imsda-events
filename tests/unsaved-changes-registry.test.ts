import { describe, expect, it, vi } from "vitest";
import {
  guardedNavigate,
  hasRegisteredUnsavedChanges,
  registerUnsavedChanges,
  unsavedChangesMessage,
} from "@/components/unsaved-changes-registry";
import { eventSwitchHref, switchEvent } from "@/components/shell-event-selection";

describe("unsaved changes registry (#647)", () => {
  it("navigates without a prompt when no form is dirty", () => {
    const navigate = vi.fn();
    const confirm = vi.fn(() => false);
    expect(hasRegisteredUnsavedChanges()).toBe(false);
    expect(guardedNavigate(navigate, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("prompts with the dirty form's message and skips navigation on Cancel", () => {
    const unregister = registerUnsavedChanges("Unsaved settings");
    const navigate = vi.fn();
    const confirm = vi.fn(() => false);
    expect(guardedNavigate(navigate, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith("Unsaved settings");
    expect(navigate).not.toHaveBeenCalled();
    unregister();
  });

  it("navigates after the user confirms", () => {
    const unregister = registerUnsavedChanges("Unsaved builder");
    const navigate = vi.fn();
    expect(guardedNavigate(navigate, () => true)).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("prompts once however many forms are dirty, and clears on unregister", () => {
    const a = registerUnsavedChanges("A");
    const b = registerUnsavedChanges("B");
    const confirm = vi.fn(() => true);
    guardedNavigate(() => {}, confirm);
    expect(confirm).toHaveBeenCalledTimes(1);
    a();
    expect(unsavedChangesMessage()).toBe("B");
    b();
    expect(hasRegisteredUnsavedChanges()).toBe(false);
    expect(unsavedChangesMessage()).toBeNull();
  });
});

describe("event picker switch (#647)", () => {
  const base = { eventId: "evt_2", pathname: "/people", currentSearch: "event=evt_1&q=x&status=PAID&tab=a" };

  it("builds the href with the new event and drops resource params", () => {
    expect(eventSwitchHref("/people", base.currentSearch, "evt_2")).toBe("/people?event=evt_2&tab=a");
  });

  it("does not commit or push when the guard cancels", () => {
    const commit = vi.fn();
    const push = vi.fn();
    const ran = switchEvent({ ...base, guard: () => false, commit, push });
    expect(ran).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("blocks with a dirty form on Cancel and switches on OK", () => {
    const unregister = registerUnsavedChanges("dirty");
    const commit = vi.fn();
    const push = vi.fn();
    switchEvent({ ...base, guard: (nav) => guardedNavigate(nav, () => false), commit, push });
    expect(commit).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    switchEvent({ ...base, guard: (nav) => guardedNavigate(nav, () => true), commit, push });
    expect(commit).toHaveBeenCalledWith("evt_2");
    expect(push).toHaveBeenCalledWith("/people?event=evt_2&tab=a");
    unregister();
  });

  it("switches a clean form without prompting", () => {
    const confirm = vi.fn(() => false);
    const commit = vi.fn();
    const push = vi.fn();
    switchEvent({ ...base, guard: (nav) => guardedNavigate(nav, confirm), commit, push });
    expect(confirm).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
  });
});
