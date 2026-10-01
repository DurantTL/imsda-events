"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { ListPager } from "@/components/list-pager";
import { listSearchParams, ORGANIZATION_SEARCH_MAX_LENGTH } from "@/modules/organizations/search";

type Option = { value: string; label: string };

export type OrganizationListState = { q: string; kind: string; status: string };

/** Pause after the last keystroke before the list updates (#723). */
export const SEARCH_DEBOUNCE_MS = 350;

export function organizationListHref(basePath: string, state: OrganizationListState, page = 1) {
  const query = listSearchParams({ q: state.q, kind: state.kind, status: state.status, page }).toString();
  return query ? `${basePath}?${query}` : basePath;
}

/**
 * The shared filter bar of the Clubs and churches page and the organization
 * directory (#723): a search box, Kind and Status, and the Filter button. It is
 * a plain GET form, so it works before the script loads and Enter submits it.
 * With script, typing updates the list after a short pause and the query lives
 * in the URL, so Back and shared links keep it.
 */
export function OrganizationSearchControls({
  basePath,
  kindOptions,
  placeholder,
  searchLabel,
  state,
  statusOptions,
}: {
  basePath: string;
  kindOptions: Option[];
  placeholder: string;
  searchLabel: string;
  state: OrganizationListState;
  statusOptions: Option[];
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function apply() {
    if (timer.current) clearTimeout(timer.current);
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    const next = organizationListHref(basePath, {
      q: String(data.get("q") ?? ""),
      kind: String(data.get("kind") ?? ""),
      status: String(data.get("status") ?? "ALL"),
    });
    startTransition(() => router.replace(next, { scroll: false }));
  }

  return (
    <form
      action={basePath}
      aria-busy={pending}
      className="org-filter-bar"
      method="get"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
      ref={formRef}
      role="search"
    >
      <label className="org-filter-field org-filter-search">
        <span>{searchLabel}</span>
        <input
          autoComplete="off"
          defaultValue={state.q}
          maxLength={ORGANIZATION_SEARCH_MAX_LENGTH}
          name="q"
          onChange={() => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(apply, SEARCH_DEBOUNCE_MS);
          }}
          placeholder={placeholder}
          type="search"
        />
      </label>
      <label className="org-filter-field">
        <span>Kind</span>
        <select defaultValue={state.kind} name="kind" onChange={apply}>
          {kindOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label className="org-filter-field">
        <span>Status</span>
        <select defaultValue={state.status} name="status" onChange={apply}>
          {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <button className="secondary-button org-filter-submit" type="submit">Filter</button>
    </form>
  );
}

/** Previous/next paging that keeps the search and filters in the URL. */
export function OrganizationListPager({
  basePath,
  page,
  pageCount,
  pageSize,
  state,
  total,
}: {
  basePath: string;
  page: number;
  pageCount: number;
  pageSize: number;
  state: OrganizationListState;
  total: number;
}) {
  const router = useRouter();
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <ListPager
      label="Organization pages"
      onPage={(next) => router.push(organizationListHref(basePath, state, next))}
      slice={{ from, page, pageCount, to, total }}
    />
  );
}
