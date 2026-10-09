import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Class tracking bulk actions act only on members that are selected AND shown
 * (#743 review). The component runs here against a tiny hook runtime (no DOM in
 * this suite): state is kept between renders, handlers are called like clicks.
 */
const runtime = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = runtime.index++;
      if (!(i in runtime.slots)) runtime.slots[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      const set = (next: unknown) => {
        runtime.slots[i] = typeof next === "function" ? (next as (v: unknown) => unknown)(runtime.slots[i]) : next;
      };
      return [runtime.slots[i], set];
    },
    useMemo: (factory: () => unknown) => factory(),
  };
});

import { ClubEarnedAwardsWorkspace, completionPayload, emptyEarnedAwardsData, recordPayload, selectShown, visibleSelectedIds } from "@/components/club-earned-awards-workspace";

type Props = Record<string, unknown> & { children?: ReactNode };
function walk(node: ReactNode, out: ReactElement<Props>[] = []) {
  if (Array.isArray(node)) { node.forEach((child) => walk(child, out)); return out; }
  if (!isValidElement<Props>(node)) return out;
  out.push(node);
  walk(node.props.children, out);
  return out;
}
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join("") : isValidElement<Props>(node) ? text(node.props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "";

const members = Array.from({ length: 12 }, (_, i) => ({ personId: `p${i}`, firstName: i < 4 ? "Ann" : "Bob", lastName: `Sample${i}`, classLabel: "Friend" }));
const initial = { ...emptyEarnedAwardsData, members, catalog: [{ itemId: "gc", section: "M", sectionLabel: "Misc", name: "Good Conduct Bar", catalogNumber: "1" }] };

function render() {
  runtime.index = 0;
  return ClubEarnedAwardsWorkspace({ organizationId: "club-1", ordersHref: "/o", initial }) as ReactElement<Props>;
}
const buttons = (tree: ReactNode, label: string) => walk(tree).filter((el) => el.type === "button" && text(el.props.children).includes(label));
const searchBoxes = (tree: ReactNode) => walk(tree).filter((el) => el.type === "input" && el.props.type === "search");

const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
beforeEach(() => {
  runtime.slots = [];
  posts.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    if (init?.body) posts.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ created: 1, marked: 0 }) };
  }));
});

describe("pure helpers", () => {
  it("acts on selected members that are shown, in roster order", () => {
    const selected = new Set(["p0", "p5", "p9"]);
    expect(visibleSelectedIds(members, selected, "")).toEqual(["p0", "p5", "p9"]);
    expect(visibleSelectedIds(members, selected, "ann")).toEqual(["p0"]);
    expect(selectShown(members, new Set(["p9"]), "ann")).toEqual(new Set(["p9", "p0", "p1", "p2", "p3"]));
    expect(completionPayload(members, selected, "ann", "FRIEND", "2027-01-01").personIds).toEqual(["p0"]);
    expect(recordPayload(members, selected, "bob", ["gc"], false).personIds).toEqual(["p5", "p9"]);
  });
});

describe("Mark a class completed", () => {
  it("selects all, searches, and posts only the selected members still shown", async () => {
    let tree = render();
    // Select all in the members table, then search for "ann".
    await (buttons(tree, "Select all")[0].props.onClick as () => void)();
    tree = render();
    expect(text(buttons(tree, "Mark Friend completed")[0])).toContain("(12)");
    (searchBoxes(tree)[0].props.onChange as (e: unknown) => void)({ target: { value: "ann" } });
    tree = render();
    const mark = buttons(tree, "Mark Friend completed")[0];
    expect(text(mark)).toContain("(4)");
    expect(text(mark)).not.toContain("(12)");
    expect(text(tree)).toContain("8 selected members are hidden by the filters and won't be included.");
    await (mark.props.onClick as () => Promise<void>)();
    const body = posts.find((post) => post.url.endsWith("/completions"))!.body;
    expect(body.personIds).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("disables the button when every selected member is hidden", () => {
    let tree = render();
    (buttons(tree, "Select all")[0].props.onClick as () => void)();
    tree = render();
    (searchBoxes(tree)[0].props.onChange as (e: unknown) => void)({ target: { value: "nobody" } });
    tree = render();
    expect(buttons(tree, "Mark Friend completed")[0].props.disabled).toBe(true);
  });
});

describe("Add by hand", () => {
  it("posts only the selected members still shown, and counts only them", async () => {
    let tree = render();
    // Choose an item: set the item select, then "Add item".
    const select = walk(tree).find((el) => el.type === "select" && el.props.id === "earned-item")!;
    (select.props.onChange as (e: unknown) => void)({ target: { value: "gc" } });
    tree = render();
    (buttons(tree, "Add item")[0].props.onClick as () => void)();
    tree = render();
    // The one members table feeds both actions: select all, then search "bob" there.
    (buttons(tree, "Select all")[0].props.onClick as () => void)();
    tree = render();
    (searchBoxes(tree)[0].props.onChange as (e: unknown) => void)({ target: { value: "bob" } });
    tree = render();
    const record = buttons(tree, "Record items")[0];
    expect(text(record)).toContain("(8)");
    expect(text(tree)).toContain("4 selected members are hidden by the filters and won't be included.");
    await (record.props.onClick as () => Promise<void>)();
    const body = posts.find((post) => post.url.endsWith("/awards"))!.body;
    // In the table's order: by last name ("Sample10" sorts before "Sample4").
    expect([...(body.personIds as string[])].sort()).toEqual(["p10", "p11", "p4", "p5", "p6", "p7", "p8", "p9"]);
    expect(body.itemIds).toEqual(["gc"]);
  });
});
