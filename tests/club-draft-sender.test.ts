import { describe, expect, it } from "vitest";
import { createDraftSender, DRAFT_CONFLICT_MESSAGE, draftBlockedReason } from "@/modules/club-registrations/draft-sender";

type Snapshot = { value: string };
type Reply = { ok: boolean; status: number; body: unknown } | "throw";

function harness(replies: Reply[], initialRevision = 3) {
  const sent: Array<{ value: string; baseRevision: number; saveId: string }> = [];
  let conflicts = 0;
  let n = 0;
  const sender = createDraftSender<Snapshot>({
    url: "/draft",
    initialRevision,
    onConflict: () => { conflicts += 1; },
    newId: () => `save-${++n}`,
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(String(init.body)));
      const reply = replies.shift() ?? { ok: true, status: 200, body: {} };
      if (reply === "throw") throw new Error("offline");
      return { ok: reply.ok, status: reply.status, json: async () => reply.body };
    },
  });
  return { sender, sent, conflicts: () => conflicts };
}

const ok = (revision: number): Reply => ({ ok: true, status: 200, body: { revision } });
const conflict: Reply = { ok: false, status: 409, body: { error: "DRAFT_CONFLICT" } };

describe("draft sender (#659)", () => {
  it("bases each save on the revision the last one returned", async () => {
    const { sender, sent } = harness([ok(4), ok(5)]);
    await sender.send({ value: "a" });
    await sender.send({ value: "b" });
    expect(sent.map((s) => s.baseRevision)).toEqual([3, 4]);
  });

  it("reuses the save id when the same snapshot is retried, and a new one for a new snapshot", async () => {
    const { sender, sent } = harness(["throw", ok(4), ok(5)]);
    const a = { value: "a" };
    expect(await sender.send(a)).toBe(false);
    expect(await sender.send(a)).toBe(true);
    await sender.send({ value: "b" });
    expect(sent.map((s) => s.saveId)).toEqual(["save-1", "save-1", "save-2"]);
  });

  it("resends an unconfirmed snapshot before a newer one, so the newer one has the right base", async () => {
    // "a" landed on the server but its response was lost; "b" replaced it in the queue.
    const { sender, sent } = harness(["throw", ok(4), ok(5)]);
    expect(await sender.send({ value: "a" })).toBe(false);
    expect(await sender.send({ value: "b" })).toBe(true);
    expect(sent.map((s) => [s.value, s.baseRevision])).toEqual([["a", 3], ["a", 3], ["b", 4]]);
    expect(sent[0]!.saveId).toBe(sent[1]!.saveId);
  });

  it("stops sending after a conflict", async () => {
    const { sender, sent, conflicts } = harness([conflict]);
    expect(await sender.send({ value: "a" })).toBe(false);
    expect(sender.isConflicted()).toBe(true);
    expect(await sender.send({ value: "b" })).toBe(false);
    expect(sent).toHaveLength(1);
    expect(conflicts()).toBe(1);
  });

  it("does not treat other 409s or server errors as a conflict", async () => {
    const { sender } = harness([{ ok: false, status: 409, body: { error: "MEMBER_NOT_ON_ROSTER" } }, { ok: false, status: 503, body: {} }]);
    expect(await sender.send({ value: "a" })).toBe(false);
    expect(await sender.send({ value: "b" })).toBe(false);
    expect(sender.isConflicted()).toBe(false);
  });
});

describe("blocking submit while the draft is in conflict (#659)", () => {
  it("gives the conflict message first, then any class problem, else nothing", () => {
    expect(draftBlockedReason({ conflict: true, honorsProblem: "Pick a class." })).toBe(DRAFT_CONFLICT_MESSAGE);
    expect(draftBlockedReason({ conflict: true, honorsProblem: null })).toBe(DRAFT_CONFLICT_MESSAGE);
    expect(draftBlockedReason({ conflict: false, honorsProblem: "Pick a class." })).toBe("Pick a class.");
    expect(draftBlockedReason({ conflict: false, honorsProblem: null })).toBeNull();
  });
});
