/**
 * The query string without `registration`, every other parameter kept in order.
 * Closing a registration opened from a "Filter by answer" result (#783) uses it
 * so the active filter, event and location survive and the same result can be
 * opened again.
 */
export function withoutRegistrationParam(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("registration");
  return params.toString();
}

/** How the detail was opened from ?registration= (#783): `hardLoad` means the page loaded with the parameter already present. */
export type ParamOpened = { id: string; hardLoad: boolean } | null;

/**
 * What the URL asks of the detail. A parameter opens that registration; the
 * parameter vanishing (back/forward) closes a detail that was opened from it,
 * touching state only. A detail opened by clicking a card is left alone.
 */
export function followRegistrationParam(param: string | undefined, opened: ParamOpened): "open" | "close-state" | "none" {
  if (param) return "open";
  return opened ? "close-state" : "none";
}

/**
 * How closing the detail should change the URL. A client navigation pushed an
 * entry, so go back (no duplicate [A, A] entry); a hard load has nothing to go
 * back to inside the app, so replace the URL without the parameter. A detail
 * opened by a card click never touched the URL.
 */
export function closeRegistrationUrlAction(param: string | undefined, opened: ParamOpened): "back" | "replace" | "none" {
  if (!param || !opened) return "none";
  return opened.hardLoad ? "replace" : "back";
}
