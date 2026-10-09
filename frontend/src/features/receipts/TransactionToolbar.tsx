import { useMemo, useRef, useState } from "react";

import { IconClose, IconFilter, IconSearch, IconSort } from "../../components/Icons";
import { MenuSurface } from "../../components/MenuSurface";
import { SortMenu } from "../../components/SortMenu";
import { useDismiss } from "../../lib/useDismiss";
import { useIsMobile } from "../../lib/viewport";
import type {
  MethodFilter,
  StatusFilter,
  TransactionFilters,
} from "./transactionFilters";
import {
  METHOD_LABELS,
  NO_TRANSACTION_FILTERS,
  STATUS_LABELS,
  countActiveFilters,
} from "./transactionFilters";
import { SORT_OPTIONS } from "./transactionSort";
import type { TransactionSort } from "./transactionSort";

/** Which of the two lists is on screen. */
export type TransactionView = "date" | "customer";

interface TransactionToolbarProps {
  view: TransactionView;
  onViewChange: (view: TransactionView) => void;
  /** Every project a transaction on this screen touches. */
  projectNames: string[];
  filters: TransactionFilters;
  onFiltersChange: (filters: TransactionFilters) => void;
  sort: TransactionSort;
  onSortChange: (sort: TransactionSort) => void;
  search: string;
  onSearchChange: (search: string) => void;
  shownCount: number;
  totalCount: number;
}

/**
 * The Recibos toolbar: a view switch, a search box, a sort menu, a filter panel.
 *
 * Deliberately the same object as `CustomerToolbar` and `LotToolbar`, down to
 * the removable chips underneath. A filter button that behaves differently on
 * the third screen is a filter button somebody has to learn twice.
 *
 * What is new here is the view switch, and it earns its place: "¿cuánto entró
 * esta semana?" and "¿qué ha pagado Ana?" are the two questions this screen is
 * opened for, and they want the same transactions arranged two different ways.
 * Neither is a filter — nothing is hidden by either one — so neither belongs in
 * the filter panel.
 */
export function TransactionToolbar({
  view,
  onViewChange,
  projectNames,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  search,
  onSearchChange,
  shownCount,
  totalCount,
}: TransactionToolbarProps) {
  const [openMenu, setOpenMenu] = useState<"sort" | "filter" | null>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // On a phone these open as sheets, which bring their own backdrop and Escape
  // handling; a second outside-click listener would only fight with them.
  useDismiss(!isMobile && openMenu === "sort", sortRef, () => setOpenMenu(null));
  useDismiss(!isMobile && openMenu === "filter", filterRef, () => setOpenMenu(null));

  const activeCount = countActiveFilters(filters);
  // The trigger button names the PRIMARY level; any levels after it show as
  // the "+N" badge next to it, same as the filter button's count.
  const primaryOption =
    SORT_OPTIONS.find((option) => option.field === sort[0]?.field) ?? SORT_OPTIONS[0]!;

  const toggleMethod = (value: MethodFilter) => {
    onFiltersChange({
      ...filters,
      methods: filters.methods.includes(value)
        ? filters.methods.filter((method) => method !== value)
        : [...filters.methods, value],
    });
  };

  const toggleStatus = (value: StatusFilter) => {
    onFiltersChange({
      ...filters,
      statuses: filters.statuses.includes(value)
        ? filters.statuses.filter((status) => status !== value)
        : [...filters.statuses, value],
    });
  };

  const toggleProject = (name: string) => {
    onFiltersChange({
      ...filters,
      projects: filters.projects.includes(name)
        ? filters.projects.filter((project) => project !== name)
        : [...filters.projects, name],
    });
  };

  const clearAll = () => onFiltersChange(NO_TRANSACTION_FILTERS);

  /** One removable chip per applied restriction. */
  const activeChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; clear: () => void }> = [];

    for (const method of filters.methods) {
      chips.push({
        key: `method:${method}`,
        label: METHOD_LABELS.find((option) => option.value === method)?.label ?? method,
        clear: () =>
          onFiltersChange({
            ...filters,
            methods: filters.methods.filter((value) => value !== method),
          }),
      });
    }

    for (const status of filters.statuses) {
      chips.push({
        key: `status:${status}`,
        label: STATUS_LABELS.find((option) => option.value === status)?.label ?? status,
        clear: () =>
          onFiltersChange({
            ...filters,
            statuses: filters.statuses.filter((value) => value !== status),
          }),
      });
    }

    for (const project of filters.projects) {
      chips.push({
        key: `project:${project}`,
        label: project,
        clear: () =>
          onFiltersChange({
            ...filters,
            projects: filters.projects.filter((value) => value !== project),
          }),
      });
    }

    if (filters.fromDate !== null || filters.toDate !== null) {
      chips.push({
        key: "dates",
        label:
          filters.fromDate && filters.toDate
            ? `${filters.fromDate} – ${filters.toDate}`
            : filters.fromDate
              ? `From ${filters.fromDate}`
              : `Through ${filters.toDate}`,
        clear: () => onFiltersChange({ ...filters, fromDate: null, toDate: null }),
      });
    }

    return chips;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const filterBody = (
    <>
      <div className="filter-section">
        <p className="menu-title">Status</p>
        {STATUS_LABELS.map((option) => (
          <label key={option.value} className="filter-check">
            <input
              type="checkbox"
              checked={filters.statuses.includes(option.value)}
              onChange={() => toggleStatus(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
        <span className="field-hint">
          “No receipt” means these payments were received but never printed. They still count in balances.
        </span>
      </div>

      <div className="filter-section">
        <p className="menu-title">Payment method</p>
        {METHOD_LABELS.map((option) => (
          <label key={option.value} className="filter-check">
            <input
              type="checkbox"
              checked={filters.methods.includes(option.value)}
              onChange={() => toggleMethod(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
        {filters.methods.length === 0 && (
          <p className="field-hint">Leave all unchecked to show every method.</p>
        )}
      </div>

      <div className="filter-section">
        <p className="menu-title">Project</p>
        {projectNames.length === 0 && <p className="field-hint">There are no transactions yet.</p>}
        {projectNames.map((name) => (
          <label key={name} className="filter-check">
            <input
              type="checkbox"
              checked={filters.projects.includes(name)}
              onChange={() => toggleProject(name)}
            />
            <span>{name}</span>
          </label>
        ))}
      </div>

      <div className="filter-section">
        <p className="menu-title">Payment date</p>
        {/* One field per row, each with its own label — a date input cannot be
            squeezed into half of this popover without the browser clipping the
            end of it, picker button included. See `.filter-range-dates`. */}
        <div className="filter-range filter-range-dates">
          <label>
            <span>From</span>
            <input
              type="date"
              value={filters.fromDate ?? ""}
              onChange={(event) =>
                onFiltersChange({ ...filters, fromDate: event.target.value || null })
              }
            />
          </label>
          <label>
            <span>Through</span>
            <input
              type="date"
              value={filters.toDate ?? ""}
              onChange={(event) =>
                onFiltersChange({ ...filters, toDate: event.target.value || null })
              }
            />
          </label>
        </div>
        <span className="field-hint">The day the money was received, not the day it was recorded.</span>
      </div>
    </>
  );

  return (
    <div className="lots-toolbar">
      <div className="toolbar">
        {/* Two arrangements of the same transactions. Neither hides anything,
            which is why this is a switch and not a filter. */}
        <div className="view-switch" role="tablist" aria-label="How to group transactions">
          <button
            type="button"
            role="tab"
            aria-selected={view === "date"}
            className={view === "date" ? "view-switch-option is-active" : "view-switch-option"}
            onClick={() => onViewChange("date")}
          >
            By date
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "customer"}
            className={view === "customer" ? "view-switch-option is-active" : "view-switch-option"}
            onClick={() => onViewChange("customer")}
          >
            By customer
          </button>
        </div>

        <span className="result-count">
          {shownCount} of {totalCount}
        </span>

        <div className="toolbar-spacer" />

        <div className="table-search">
          <IconSearch />
          <input
            type="search"
            value={search}
            placeholder="Search receipts or customers…"
            aria-label="Search transactions"
            title="Search by customer, ID, lot, contract, receipt, bank reference, or note"
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>

        <div className="menu-anchor" ref={sortRef}>
          <button
            type="button"
            className="chip menu-trigger"
            aria-expanded={openMenu === "sort"}
            onClick={() => setOpenMenu(openMenu === "sort" ? null : "sort")}
          >
            <IconSort />
            <span>
              {primaryOption.label}
              <span className="menu-trigger-detail">
                {sort[0]?.direction === "asc" ? primaryOption.ascLabel : primaryOption.descLabel}
              </span>
            </span>
            {sort.length > 1 && <span className="filter-count">+{sort.length - 1}</span>}
          </button>

          <MenuSurface
            isOpen={openMenu === "sort"}
            title="Sort by"
            onClose={() => setOpenMenu(null)}
            className="sort-popover"
          >
            <SortMenu
              options={SORT_OPTIONS}
              rules={sort}
              onChange={onSortChange}
              defaultDirection={(field) => (field === "date" || field === "amount" ? "desc" : "asc")}
              hint={
                view === "customer"
                  ? "Sort customers and the transactions within each customer."
                  : "Select the same field again to reverse the sort order."
              }
            />
          </MenuSurface>
        </div>

        <div className="menu-anchor" ref={filterRef}>
          <button
            type="button"
            className={activeCount > 0 ? "chip menu-trigger active" : "chip menu-trigger"}
            aria-expanded={openMenu === "filter"}
            onClick={() => setOpenMenu(openMenu === "filter" ? null : "filter")}
          >
            <IconFilter />
            <span>Filters</span>
            {activeCount > 0 && <span className="filter-count">{activeCount}</span>}
          </button>

          <MenuSurface
            isOpen={openMenu === "filter"}
            title="Filters"
            onClose={() => setOpenMenu(null)}
            className="filter-popover"
            footer={
              <>
                <button type="button" className="link-btn" onClick={clearAll}>
                  Clear filters
                </button>
                <button type="button" className="btn-primary" onClick={() => setOpenMenu(null)}>
                  Show {shownCount} transaction{shownCount === 1 ? "" : "s"}
                </button>
              </>
            }
          >
            {filterBody}
          </MenuSurface>
        </div>
      </div>

      {activeChips.length > 0 && (
        <div className="active-filters">
          {activeChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className="filter-chip"
              onClick={chip.clear}
              title={`Remove ${chip.label}`}
            >
              <span>{chip.label}</span>
              <IconClose />
            </button>
          ))}

          <button type="button" className="link-btn" onClick={clearAll}>
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
