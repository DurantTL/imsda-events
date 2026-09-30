"use client";

import { useEffect } from "react";

/**
 * Phone "stacked card" tables (#686). Tables marked `table-cards` are turned
 * into cards under 600px by CSS display changes, which drops native table
 * semantics in some browsers. This component keeps the real <table> and adds:
 *  - `data-label` on every cell (from its column header), shown as "Header: value";
 *  - explicit ARIA roles so assistive tech still announces a table with headers.
 * The CSS only applies once a table has `data-table-cards-ready`, so a table is
 * never stacked without its labels.
 */

export type HeaderCell = { text: string; hiddenOnly: boolean };

/** One label per column; a column whose header is screen-reader-only gets none. */
export function cardLabelsFromHeaders(headers: HeaderCell[]): (string | null)[] {
  return headers.map((header) => {
    const text = header.text.replace(/\s+/g, " ").trim();
    return header.hiddenOnly || !text ? null : text;
  });
}

/** Labels longer than this do not fit the side-by-side gutter on a phone. */
export const LONG_CARD_LABEL_LENGTH = 15;
export function isLongCardLabel(label: string) {
  return label.length > LONG_CARD_LABEL_LENGTH;
}

function setAttr(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

export function enhanceCardTable(table: HTMLTableElement) {
  const headerRow = table.tHead?.rows[0];
  if (!headerRow) return;
  const headers: HeaderCell[] = Array.from(headerRow.cells).map((cell) => ({
    text: cell.textContent ?? "",
    hiddenOnly: cell.children.length > 0 && Array.from(cell.children).every((child) => child.classList.contains("sr-only")),
  }));
  const labels = cardLabelsFromHeaders(headers);

  setAttr(table, "role", "table");
  if (table.tHead) setAttr(table.tHead, "role", "rowgroup");
  Array.from(table.tBodies).forEach((body) => setAttr(body, "role", "rowgroup"));
  Array.from(table.rows).forEach((row) => {
    setAttr(row, "role", "row");
    Array.from(row.cells).forEach((cell, index) => {
      if (cell.tagName === "TH") {
        setAttr(cell, "role", cell.getAttribute("scope") === "row" ? "rowheader" : "columnheader");
        return;
      }
      setAttr(cell, "role", "cell");
      const label = labels[index];
      if (label) {
        setAttr(cell, "data-label", label);
        // Too long for the side-by-side gutter: CSS puts the label above the value.
        if (isLongCardLabel(label)) setAttr(cell, "data-label-long", "");
      }
    });
  });
  setAttr(table, "data-table-cards-ready", "");
}

export function TableCardLabels() {
  useEffect(() => {
    let frame = 0;
    const run = () => {
      frame = 0;
      document.querySelectorAll<HTMLTableElement>("table.table-cards").forEach(enhanceCardTable);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(run);
    };
    run();
    // Client workspaces re-render rows after load and on navigation.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);
  return null;
}
