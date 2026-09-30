import { describe, expect, it } from "vitest";
import { createDraftSaveQueue } from "@/modules/club-registrations/draft-save-queue";

function deferred() {
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("draft save queue (#643)", () => {
  it("resolves true with nothing pending", async () => {
    expect(await createDraftSaveQueue<string>({ send: async () => true }).flush()).toBe(true);
  });

  it("flush waits for chained in-flight saves", async () => {
    const gates = [deferred(), deferred()];
    const sent: string[] = [];
    const queue = createDraftSaveQueue<string>({ send: (draft) => { sent.push(draft); return gates[sent.length - 1]!.promise; } });
    queue.set("a");
    const first = queue.flush();
    queue.set("b");
    const second = queue.flush();
    let done = false;
    void second.then(() => { done = true; });
    gates[0]!.resolve(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(false);
    gates[1]!.resolve(true);
    expect(await second).toBe(true);
    expect(await first).toBe(true);
    expect(sent).toEqual(["a", "b"]);
  });

  it("keeps a failed draft pending so retry resends it", async () => {
    let ok = false;
    const sent: string[] = [];
    const queue = createDraftSaveQueue<string>({ send: async (draft) => { sent.push(draft); return ok; } });
    queue.set("a");
    expect(await queue.flush()).toBe(false);
    expect(queue.hasPending()).toBe(true);
    ok = true;
    expect(await queue.flush()).toBe(true);
    expect(sent).toEqual(["a", "a"]);
  });

  it("does not restore a stale draft when a save fails after submit", async () => {
    const gate = deferred();
    const queue = createDraftSaveQueue<string>({ send: () => gate.promise });
    queue.set("a");
    const flushing = queue.flush();
    queue.submitted();
    gate.resolve(false);
    await flushing;
    expect(queue.hasPending()).toBe(false);
  });
});
