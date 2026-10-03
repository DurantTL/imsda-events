/**
 * Sorting for the system-admin attendee accounts list (#738). Pure and
 * client-safe: the server applies it across the whole result set before
 * limiting, and the workspace uses the same keys for its headers and URL.
 */

import { clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";

export const accountSortKeys = ["name", "role", "twostep", "signin", "status"] as const;
/** The keys that have a table column header; status is the chip in the Account cell. */
export const accountColumnSortKeys = ["name", "role", "twostep", "signin"] as const;
export type AccountSortKey = (typeof accountSortKeys)[number];
export type AccountSortDirection = "asc" | "desc";
export type AccountSort = { key: AccountSortKey; direction: AccountSortDirection } | null;

export const accountSortLabels: Record<AccountSortKey, string> = {
  name: "Account",
  role: "Club roles",
  twostep: "Two-step",
  signin: "Last sign-in",
  status: "Status (Active / Disabled)",
};

export function parseAccountSort(key: string | null | undefined, direction: string | null | undefined): AccountSort {
  if (!key || !(accountSortKeys as readonly string[]).includes(key)) return null;
  return { key: key as AccountSortKey, direction: direction === "desc" ? "desc" : "asc" };
}

/** Header click: a new column starts ascending, the same column flips. */
export function nextAccountSort(current: AccountSort, key: AccountSortKey): NonNullable<AccountSort> {
  if (current?.key === key) return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  return { key, direction: "asc" };
}

export function ariaSortFor(current: AccountSort, key: AccountSortKey): "ascending" | "descending" | "none" {
  if (current?.key !== key) return "none";
  return current.direction === "asc" ? "ascending" : "descending";
}

type SortableAccount = {
  id: string;
  email: string;
  displayName: string | null;
  disabled: boolean;
  lastSignedInAt: string | null;
  authenticatorOn: boolean;
  passkeyCount: number;
  areaCoordinator: boolean;
  clubRoles: Array<{ role: keyof typeof clubDirectorRoleLabels; clubName: string }>;
};

function text(value: string) {
  return value.trim().toLocaleLowerCase("en-US");
}

function roleText(account: SortableAccount) {
  const parts = [
    ...(account.areaCoordinator ? ["area coordinator"] : []),
    ...account.clubRoles.map((role) => `${clubDirectorRoleLabels[role.role]} ${role.clubName}`),
  ];
  return text(parts.join(" "));
}

/** Not set up (0), passkeys only (1), authenticator only (2), both (3). */
function twoStepRank(account: SortableAccount) {
  return (account.authenticatorOn ? 2 : 0) + (account.passkeyCount > 0 ? 1 : 0);
}

/**
 * Sorts a copy of `accounts`. Empty values (no role, never signed in) sort
 * last in either direction, and ties fall back to name then id so the order
 * is stable between requests.
 */
export function sortAccounts<T extends SortableAccount>(accounts: readonly T[], sort: NonNullable<AccountSort>): T[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  const byName = (a: T, b: T) => (
    text(a.displayName || a.email).localeCompare(text(b.displayName || b.email), "en-US")
    || a.email.localeCompare(b.email, "en-US")
    || a.id.localeCompare(b.id)
  );
  const compare = (a: T, b: T): number => {
    switch (sort.key) {
      case "name":
        return sign * byName(a, b);
      case "role": {
        const left = roleText(a);
        const right = roleText(b);
        if (!left !== !right) return left ? -1 : 1;
        return sign * left.localeCompare(right, "en-US") || byName(a, b);
      }
      case "status":
        // Active first when ascending.
        return sign * (Number(a.disabled) - Number(b.disabled)) || byName(a, b);
      case "twostep":
        return sign * (twoStepRank(a) - twoStepRank(b)) || byName(a, b);
      case "signin": {
        const left = a.lastSignedInAt ? Date.parse(a.lastSignedInAt) : null;
        const right = b.lastSignedInAt ? Date.parse(b.lastSignedInAt) : null;
        if (left === null || right === null) {
          if (left === right) return byName(a, b);
          return left === null ? 1 : -1;
        }
        return sign * (left - right) || byName(a, b);
      }
    }
  };
  return [...accounts].sort(compare);
}
