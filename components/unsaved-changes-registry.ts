/**
 * Shared unsaved-changes registry (#647). Forms register a message while they
 * hold unsaved edits; any programmatic navigation (event picker, in-page
 * `router.replace`) runs through `guardedNavigate`, which asks once for
 * confirmation when at least one form is dirty. Kept free of React so it can
 * be unit tested in the node environment.
 */

const entries = new Map<symbol, string>();

/** Registers a dirty form; the returned function unregisters it. */
export function registerUnsavedChanges(message: string): () => void {
  const key = Symbol("unsaved-changes");
  entries.set(key, message);
  return () => {
    entries.delete(key);
  };
}

export function hasRegisteredUnsavedChanges(): boolean {
  return entries.size > 0;
}

/** The message of the most recently registered dirty form, or null when clean. */
export function unsavedChangesMessage(): string | null {
  let latest: string | null = null;
  for (const message of entries.values()) latest = message;
  return latest;
}

/**
 * Runs `navigate` immediately when nothing is dirty; otherwise only after
 * `confirm(message)` returns true. Returns whether navigation ran. Cancel
 * leaves everything untouched: `navigate` is not called at all.
 */
export function guardedNavigate(
  navigate: () => void,
  confirm: (message: string) => boolean = (message) => window.confirm(message),
): boolean {
  const message = unsavedChangesMessage();
  if (message !== null && !confirm(message)) return false;
  navigate();
  return true;
}
