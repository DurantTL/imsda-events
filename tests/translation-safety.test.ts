import { describe, expect, it } from "vitest";
import { installTranslationSafeDom } from "@/lib/translation-safety";

/** Just enough of a DOM node to model what a browser translator does to React's tree. */
class FakeNode {
  parentNode: FakeNode | null = null;
  children: FakeNode[] = [];
  constructor(readonly name: string) {}

  removeChild<T>(child: T): T {
    const node = child as unknown as FakeNode;
    const index = this.children.indexOf(node);
    if (index === -1) throw new Error("NotFoundError: not a child of this node");
    this.children.splice(index, 1);
    node.parentNode = null;
    return child;
  }

  insertBefore<T>(newNode: T, referenceNode: unknown): T {
    const node = newNode as unknown as FakeNode;
    if (referenceNode === null) return this.appendChild(newNode);
    const index = this.children.indexOf(referenceNode as FakeNode);
    if (index === -1) throw new Error("NotFoundError: reference is not a child of this node");
    node.parentNode?.removeChild(node);
    this.children.splice(index, 0, node);
    node.parentNode = this;
    return newNode;
  }

  appendChild<T>(newNode: T): T {
    const node = newNode as unknown as FakeNode;
    node.parentNode?.removeChild(node);
    this.children.push(node);
    node.parentNode = this;
    return newNode;
  }
}

/** What a translator does: swap a text node for a <font> wrapper holding it. */
function translatorWraps(parent: FakeNode, text: FakeNode) {
  const font = new FakeNode("font");
  parent.insertBefore(font, text);
  parent.removeChild(text);
  font.appendChild(text);
  return font;
}

describe("translation-safe DOM", () => {
  it("installs once", () => {
    class Proto extends FakeNode {}
    expect(installTranslationSafeDom(Proto.prototype)).toBe(true);
    expect(installTranslationSafeDom(Proto.prototype)).toBe(false);
  });

  it("ignores removing a node the translator already moved, instead of throwing", () => {
    class Proto extends FakeNode {}
    const parent = new Proto("p");
    const text = new Proto("text");
    parent.appendChild(text);
    translatorWraps(parent, text);

    expect(() => parent.removeChild(text)).toThrow();
    installTranslationSafeDom(Proto.prototype);
    expect(() => parent.removeChild(text)).not.toThrow();
    expect(parent.children.map((child) => child.name)).toEqual(["font"]);
  });

  it("inserts before the translator's wrapper so order is kept", () => {
    class Proto extends FakeNode {}
    installTranslationSafeDom(Proto.prototype);
    const parent = new Proto("p");
    const first = new Proto("first");
    const text = new Proto("text");
    parent.appendChild(first);
    parent.appendChild(text);
    translatorWraps(parent, text);

    const added = new Proto("added");
    parent.insertBefore(added, text);
    expect(parent.children.map((child) => child.name)).toEqual(["first", "added", "font"]);
  });

  it("appends when the reference has left the parent entirely", () => {
    class Proto extends FakeNode {}
    installTranslationSafeDom(Proto.prototype);
    const parent = new Proto("p");
    const orphan = new Proto("orphan");
    const added = new Proto("added");
    parent.appendChild(new Proto("existing"));

    parent.insertBefore(added, orphan);
    expect(parent.children.map((child) => child.name)).toEqual(["existing", "added"]);
  });

  it("leaves ordinary DOM operations unchanged", () => {
    class Proto extends FakeNode {}
    installTranslationSafeDom(Proto.prototype);
    const parent = new Proto("p");
    const a = new Proto("a");
    const b = new Proto("b");
    parent.appendChild(b);
    parent.insertBefore(a, b);
    expect(parent.children.map((child) => child.name)).toEqual(["a", "b"]);
    parent.removeChild(a);
    expect(parent.children.map((child) => child.name)).toEqual(["b"]);
  });
});
