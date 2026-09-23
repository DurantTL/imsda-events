/**
 * Keeps React working while a browser translator (Chrome's "Translate this
 * page", Edge, Safari, gTranslate) is rewriting the page.
 *
 * Translators replace each text node with their own `<font>` wrappers. React
 * still holds the original node, so its next `removeChild` or `insertBefore`
 * names a node that is no longer where React left it, and the DOM throws
 * ("The node to be removed is not a child of this node"). React treats that as
 * a fatal render error: the form blanks out and whatever the person typed is
 * lost. This is a long-standing React/translator interaction
 * (facebook/react#11538), and the fix here is the widely used one: make those
 * two DOM methods tolerate a node the translator moved.
 *
 * - `removeChild` of a node that is no longer a child is a no-op. The node is
 *   already gone from the visible page, which is what React wanted.
 * - `insertBefore` with a reference node the translator wrapped inserts before
 *   the wrapper, the ancestor that *is* our child, so order is kept. Only when
 *   the reference has left this parent entirely does it append instead.
 *
 * Both only change behaviour in the exact case that would otherwise throw, so
 * a page nobody translates behaves identically. Values that change while the
 * page is open (names, codes, money) are also marked `translate="no"`, so
 * React keeps updating them instead of a translator's stale copy.
 */

type PatchableNode = {
  parentNode: PatchableNode | null;
  removeChild<T>(child: T): T;
  insertBefore<T>(newNode: T, referenceNode: unknown): T;
  appendChild<T>(newNode: T): T;
};

const PATCHED = Symbol.for("imsda.translationSafeDom");

function childAncestorOf(parent: PatchableNode, node: PatchableNode | null) {
  let current = node;
  while (current && current.parentNode !== parent) current = current.parentNode;
  return current;
}

export function installTranslationSafeDom(prototype: PatchableNode = Node.prototype as unknown as PatchableNode) {
  const target = prototype as PatchableNode & { [PATCHED]?: true };
  if (target[PATCHED]) return false;

  const originalRemoveChild = prototype.removeChild;
  const originalInsertBefore = prototype.insertBefore;
  const originalAppendChild = prototype.appendChild;

  prototype.removeChild = function removeChild<T>(this: PatchableNode, child: T): T {
    if ((child as PatchableNode | null)?.parentNode !== this) return child;
    return originalRemoveChild.call(this, child) as T;
  };

  prototype.insertBefore = function insertBefore<T>(this: PatchableNode, newNode: T, referenceNode: unknown): T {
    const reference = referenceNode as PatchableNode | null;
    if (reference && reference.parentNode !== this) {
      const wrapper = childAncestorOf(this, reference.parentNode);
      return wrapper
        ? (originalInsertBefore.call(this, newNode, wrapper) as T)
        : (originalAppendChild.call(this, newNode) as T);
    }
    return originalInsertBefore.call(this, newNode, referenceNode) as T;
  };

  target[PATCHED] = true;
  return true;
}
