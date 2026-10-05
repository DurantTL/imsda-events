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
