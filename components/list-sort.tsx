"use client";

import { ArrowDown, ArrowDownUp, ArrowUp, ArrowUpDown } from "lucide-react";
import { ariaSortValue, type SortDirection } from "@/lib/list-sort";

/** One line saying how a list is ordered (#743). Plain text, so it is read as well as seen. */
export function SortOrderNote({ children, id }: { children: string; id?: string }) {
  return (
    <p className="sort-order-note" id={id}>
      <ArrowDownUp aria-hidden="true" size={14} />
      <span>{children}</span>
    </p>
  );
}

/**
 * A sortable column header: the button flips the direction, the arrow shows it,
 * and `aria-sort` on the header carries it for assistive technology.
 */
export function SortableHeader({
  label,
  active,
  direction,
  onSort,
  disabled,
  className,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <th aria-sort={ariaSortValue(active, direction)} className={className} role="columnheader" scope="col">
      <button className="table-sort-button" disabled={disabled} onClick={onSort} type="button">
        {label}
        {active
          ? (direction === "asc" ? <ArrowUp aria-hidden="true" size={13} /> : <ArrowDown aria-hidden="true" size={13} />)
          : <ArrowUpDown aria-hidden="true" size={13} />}
      </button>
    </th>
  );
}
