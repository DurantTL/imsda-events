/**
 * Pure paging helpers shared by the long staff lists (#702): the delivery log,
 * the check-in roster, the unmatched Sterling Volunteers rows and the Square
 * payment-match candidates. Kept free of React so the page maths is
 * unit-testable without a DOM.
 */

export type PageSlice<T> = {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
  /** 1-based position of the first item on the page; 0 when the list is empty. */
  from: number;
  /** 1-based position of the last item on the page; 0 when the list is empty. */
  to: number;
};

/** Clamp a requested 1-based page into the valid range for the list size. */
export function clampPage(page: number, total: number, pageSize: number): number {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.floor(page)), pageCount);
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number): PageSlice<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = clampPage(page, total, pageSize);
  const start = (current - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return {
    items: slice,
    page: current,
    pageCount,
    total,
    from: slice.length ? start + 1 : 0,
    to: slice.length ? start + slice.length : 0,
  };
}

/** Newest first by an ISO timestamp, without mutating the input. */
export function newestFirst<T>(items: readonly T[], timestamp: (item: T) => string): T[] {
  return [...items].sort((a, b) => timestamp(b).localeCompare(timestamp(a)));
}

/**
 * The "Showing N of M" line for a list that is cut off. Returns an empty string
 * when everything is shown, so callers can render it conditionally.
 */
export function cappedNotice(shown: number, total: number): string {
  return shown < total ? `Showing ${shown} of ${total} — refine the search` : "";
}
