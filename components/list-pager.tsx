import type { PageSlice } from "@/lib/pagination";

/**
 * Previous/next controls with a "Showing a-b of N" line, for the long staff
 * lists (#702). Shows only the count line when everything fits on one page.
 */
export function ListPager({
  label,
  onPage,
  slice,
}: {
  label: string;
  onPage: (page: number) => void;
  slice: Pick<PageSlice<unknown>, "from" | "page" | "pageCount" | "to" | "total">;
}) {
  if (slice.total === 0) return null;
  return (
    <nav aria-label={label} className="list-pager">
      <span className="quiet-copy" role="status">
        Showing {slice.from}&ndash;{slice.to} of {slice.total}
      </span>
      {slice.pageCount > 1 && (
        <span className="list-pager-buttons">
          <button className="secondary-button" disabled={slice.page <= 1} onClick={() => onPage(slice.page - 1)} type="button">
            Previous
          </button>
          <span className="quiet-copy">Page {slice.page} of {slice.pageCount}</span>
          <button className="secondary-button" disabled={slice.page >= slice.pageCount} onClick={() => onPage(slice.page + 1)} type="button">
            Next
          </button>
        </span>
      )}
    </nav>
  );
}
