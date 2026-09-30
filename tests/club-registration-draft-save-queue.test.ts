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

  it("three overlapping flushes coalesce to the latest edit and all resolve", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const sent: string[] = [];
    const queue = createDraftSaveQueue<string>({ send: (draft) => { sent.push(draft); return gates[sent.length - 1]!.promise; } });
    queue.set("a");
    const one = queue.flush();
    queue.set("b");
    const two = queue.flush();
    queue.set("c");
    const three = queue.flush();
    for (const gate of gates) {
      await new Promise((r) => setTimeout(r, 0));
      gate.resolve(true);
    }
    expect(await Promise.all([one, two, three])).toEqual([true, true, true]);
    expect(sent).toEqual(["a", "c"]);
    expect(queue.hasPending()).toBe(false);
  });

  it("a newer edit queued during a failed save wins", async () => {
    const gate = deferred();
    const sent: string[] = [];
    const queue = createDraftSaveQueue<string>({ send: (draft) => { sent.push(draft); return sent.length === 1 ? gate.promise : Promise.resolve(true); } });
    queue.set("old");
    const failing = queue.flush();
    queue.set("new");
    gate.resolve(false);
    expect(await failing).toBe(false);
    expect(await queue.flush()).toBe(true);
    expect(sent).toEqual(["old", "new"]);
  });

  it("rapid edits never regress the saved draft, even with a server that refuses stale revisions (#659)", async () => {
    // A server with slow, varying latency that refuses a save based on an old revision.
    const server = { revision: 0, value: "" };
    let inFlight = 0;
    let maxInFlight = 0;
    let known = 0;
    const queue = createDraftSaveQueue<string>({
      send: async (draft) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const base = known;
        await new Promise((r) => setTimeout(r, draft === "a" ? 20 : 1));
        inFlight -= 1;
        if (base !== server.revision) return false;
        server.revision += 1;
        server.value = draft;
        known = server.revision;
        return true;
      },
    });
    queue.set("a");
    const first = queue.flush(false);
    queue.set("b");
    queue.set("c");
    const rest = queue.flush();
    expect(await Promise.all([first, rest])).toEqual([true, true]);
    expect(maxInFlight).toBe(1);
    expect(server.value).toBe("c");
    expect(queue.hasPending()).toBe(false);
  });

  it("a timer-style flush does not send edits queued during the save", async () => {
    const gate = deferred();
    const sent: string[] = [];
    const queue = createDraftSaveQueue<string>({ send: (draft) => { sent.push(draft); return sent.length === 1 ? gate.promise : Promise.resolve(true); } });
    queue.set("a");
    const timerFlush = queue.flush(false);
    queue.set("b");
    gate.resolve(true);
    expect(await timerFlush).toBe(true);
    expect(sent).toEqual(["a"]);
    expect(queue.hasPending()).toBe(true);
  });
});
