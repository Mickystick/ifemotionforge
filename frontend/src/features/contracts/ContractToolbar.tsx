import { useMemo, useRef, useState } from "react";

import { IconChevronDown, IconClose, IconFilter, IconSearch, IconSort } from "../../components/Icons";
import { MenuSurface } from "../../components/MenuSurface";
import { SortMenu } from "../../components/SortMenu";
import { useDismiss } from "../../lib/useDismiss";
import { useIsMobile } from "../../lib/viewport";
import type { Contract, ContractStatus, PaymentHealth, SaleType } from "../../types";
import type { ContractFilters } from "./contractFilters";
import { NO_CONTRACT_FILTERS, countActiveFilters } from "./contractFilters";
import {
  HEALTH_PRESENTATION,
  KIND_LABELS,
  SALE_TYPE_LABELS,
  STATUS_PRESENTATION,
} from "./contractPresentation";
import { SORT_OPTIONS } from "./contractSort";
import type { ContractSort } from "./contractSort";

const HEALTH_ORDER: PaymentHealth[] = ["at_risk", "overdue", "due_soon", "current"];
const STATUS_ORDER: ContractStatus[] = [
  "active",
  "paid_off",
  "replaced",
  "cancelled",
  "defaulted",
  "draft",
];
const SALE_TYPE_ORDER: SaleType[] = ["financed", "cash", "donation"];
const KIND_ORDER: Array<Contract["kind"]> = ["contract", "reservation"];

interface ContractToolbarProps {
  projectNames: string[];
  filters: ContractFilters;
  onFiltersChange: (filters: ContractFilters) => void;
  sort: ContractSort;
  onSortChange: (sort: ContractSort) => void;
  search: string;
  onSearchChange: (search: string) => void;
  shownCount: number;
  totalCount: number;
  /** How many customers in the current view hold more than one contract. */
  multiGroupCount: number;
  /** Whether every one of those customers is currently folded open. */
  allGroupsExpanded: boolean;
  onToggleAllGroups: () => void;
}

/**
 * The Contratos toolbar: one search box, one sort menu, one filter panel.
 *
 * Deliberately the same object as `LotToolbar` and `CustomerToolbar`, down to
 * the removable chips underneath. These are the three tables people live in,
 * and a filter button that behaves differently on the third screen is a filter
 * button somebody has to learn three times.
 */
export function ContractToolbar({
  projectNames,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  search,
  onSearchChange,
  shownCount,
  totalCount,
  multiGroupCount,
  allGroupsExpanded,
  onToggleAllGroups,
}: ContractToolbarProps) {
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

  /** Add or remove one value from one of the list filters. */
  function toggle<K extends "statuses" | "health" | "saleTypes" | "kinds" | "projects">(
    key: K,
    value: ContractFilters[K][number],
  ) {
    const current = filters[key] as Array<typeof value>;
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];

    onFiltersChange({ ...filters, [key]: next });
  }

  const clearAll = () => onFiltersChange(NO_CONTRACT_FILTERS);

  /** One removable chip per applied restriction. */
  const activeChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; clear: () => void }> = [];

    const push = <K extends "statuses" | "health" | "saleTypes" | "kinds" | "projects">(
      key: K,
      value: ContractFilters[K][number],
      label: string,
    ) => {
      chips.push({
        key: `${key}:${String(value)}`,
        label,
        clear: () =>
          onFiltersChange({
            ...filters,
            [key]: (filters[key] as Array<typeof value>).filter((entry) => entry !== value),
          }),
      });
    };

    for (const status of filters.statuses) {
      push("statuses", status, STATUS_PRESENTATION[status].label);
    }
    for (const health of filters.health) {
      push("health", health, HEALTH_PRESENTATION[health].label);
    }
    for (const saleType of filters.saleTypes) {
      push("saleTypes", saleType, SALE_TYPE_LABELS[saleType]);
    }
    for (const kind of filters.kinds) {
      push("kinds", kind, KIND_LABELS[kind]);
    }
    for (const project of filters.projects) {
      push("projects", project, project);
    }

    if (filters.onlyWithBalance) {
      chips.push({
        key: "balance",
        label: "With outstanding balance",
        clear: () => onFiltersChange({ ...filters, onlyWithBalance: false }),
      });
    }

    return chips;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const filterBody = (
    <>
      <div className="filter-section">
        <p className="menu-title">Payment status</p>
        {HEALTH_ORDER.map((health) => (
          <label key={health} className="filter-check">
            <input
              type="checkbox"
              checked={filters.health.includes(health)}
              onChange={() => toggle("health", health)}
            />
            <span>{HEALTH_PRESENTATION[health].label}</span>
          </label>
        ))}
        <span className="field-hint">
          Based on recorded payments, a five-day grace period, and two months to flag a customer at risk.
        </span>
      </div>

      <div className="filter-section">
        <p className="menu-title">Contract status</p>
        {STATUS_ORDER.map((status) => (
          <label key={status} className="filter-check">
            <input
              type="checkbox"
              checked={filters.statuses.includes(status)}
              onChange={() => toggle("statuses", status)}
            />
            <span>{STATUS_PRESENTATION[status].label}</span>
          </label>
        ))}
        {/* The one filter that starts switched on, so it says why. */}
        <span className="field-hint">
          Nothing is deleted in Lindero: canceled contracts remain here. The list opens to active
          contracts so you can see the current portfolio.
        </span>
      </div>

      <div className="filter-section">
        <p className="menu-title">Type</p>
        {SALE_TYPE_ORDER.map((saleType) => (
          <label key={saleType} className="filter-check">
            <input
              type="checkbox"
              checked={filters.saleTypes.includes(saleType)}
              onChange={() => toggle("saleTypes", saleType)}
            />
            <span>{SALE_TYPE_LABELS[saleType]}</span>
          </label>
        ))}
        {KIND_ORDER.map((kind) => (
          <label key={kind} className="filter-check">
            <input
              type="checkbox"
              checked={filters.kinds.includes(kind)}
              onChange={() => toggle("kinds", kind)}
            />
            <span>{KIND_LABELS[kind]}</span>
          </label>
        ))}
      </div>

      <div className="filter-section">
        <p className="menu-title">Project</p>
        {projectNames.length === 0 && <p className="field-hint">No contracts yet.</p>}
        {projectNames.map((name) => (
          <label key={name} className="filter-check">
            <input
              type="checkbox"
              checked={filters.projects.includes(name)}
              onChange={() => toggle("projects", name)}
            />
            <span>{name}</span>
          </label>
        ))}
      </div>

      <div className="filter-section">
        <label className="filter-check">
          <input
            type="checkbox"
            checked={filters.onlyWithBalance}
            onChange={() =>
              onFiltersChange({ ...filters, onlyWithBalance: !filters.onlyWithBalance })
            }
          />
          <span>Only with an outstanding balance</span>
        </label>
        <span className="field-hint">Hides contracts with no outstanding balance.</span>
      </div>
    </>
  );

  return (
    <div className="lots-toolbar">
      <div className="toolbar">
        <span className="result-count">
          Showing {shownCount} of {totalCount} contract{totalCount === 1 ? "" : "s"}
        </span>

        <div className="toolbar-spacer" />

        {multiGroupCount > 0 && (
          <button
            type="button"
            className={
              allGroupsExpanded
                ? "chip menu-trigger toggle-groups open"
                : "chip menu-trigger toggle-groups"
            }
            onClick={onToggleAllGroups}
            aria-expanded={allGroupsExpanded}
            title={
              allGroupsExpanded
                ? "Collapse customers with multiple contracts"
                : "Expand customers with multiple contracts"
            }
          >
            <IconChevronDown />
            <span>{allGroupsExpanded ? "Collapse groups" : "Expand groups"}</span>
            <span className="filter-count">{multiGroupCount}</span>
          </button>
        )}

        <div className="table-search">
          <IconSearch />
          <input
            type="search"
            value={search}
            placeholder="Search contracts, customers, or lots…"
            aria-label="Search contracts"
            title="Search by contract number, customer, phone, lot, project, or notes"
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
              defaultDirection={(field) => (field === "health" ? "desc" : "asc")}
              hint="Select the same field again to reverse the order."
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
                  Show {shownCount} contract{shownCount === 1 ? "" : "s"}
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
