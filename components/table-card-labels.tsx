/**
 * Phone "stacked card" tables (#686). A table marked `table-cards` is turned
 * into cards under 600px by CSS display changes alone, so the server HTML is
 * already cards on the first frame. Display changes can drop native table
 * semantics in some browsers, so converted tables carry static ARIA roles
 * (table, rowgroup, row, columnheader, rowheader, cell) in their JSX, and each
 * cell carries `data-label` (the column header) via `cardCell()`; the CSS shows
 * it as "Header: value". Pure module: no client code, safe in server components.
 */

/** Labels longer than this do not fit the side-by-side gutter on a phone. */
export const LONG_CARD_LABEL_LENGTH = 15;

export function isLongCardLabel(label: string) {
  return label.length > LONG_CARD_LABEL_LENGTH;
}

/**
 * Props for a body cell: `<td {...cardCell("Club")}>`. A null label (an
 * sr-only action column) gets the role only, so the card shows no label for it.
 */
export function cardCell(label: string | null) {
  if (!label) return { role: "cell" } as const;
  return isLongCardLabel(label)
    ? ({ role: "cell", "data-label": label, "data-label-long": "" } as const)
    : ({ role: "cell", "data-label": label } as const);
}
