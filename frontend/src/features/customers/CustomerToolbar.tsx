import { useMemo, useRef, useState } from "react";

import { IconClose, IconFilter, IconSearch, IconSort } from "../../components/Icons";
import { MenuSurface } from "../../components/MenuSurface";
import { SortMenu } from "../../components/SortMenu";
import { useDismiss } from "../../lib/useDismiss";
import { useIsMobile } from "../../lib/viewport";
import type { CustomerFilters, HoldingFilter } from "./customerFilters";
import { NO_CUSTOMER_FILTERS, countActiveFilters } from "./customerFilters";
import { SORT_OPTIONS } from "./customerSort";
import type { CustomerSort } from "./customerSort";

/** The wording used everywhere else for what a person is holding. */
const HOLDING_LABELS: Array<{ value: HoldingFilter; label: string }> = [
  { value: "contract", label: "With contract" },
  { value: "reservation", label: "With reservation" },
  { value: "none", label: "No active contract" },
];

interface CustomerToolbarProps {
  /** Every project a customer currently holds something in. */
  projectNames: string[];
  filters: CustomerFilters;
  onFiltersChange: (filters: CustomerFilters) => void;
  sort: CustomerSort;
  onSortChange: (sort: CustomerSort) => void;
  search: string;
  onSearchChange: (search: string) => void;
  /** For the "Mostrando X de Y" count. */
  shownCount: number;
  totalCount: number;
}

/**
 * The Clientes toolbar: one search box, one sort menu, one filter panel.
 *
 * Deliberately the same object as `LotToolbar`, down to the chips underneath —
 * the two tables are the two lists people spend their day in, and a filter
 * button that behaves differently on the second screen is a filter button
 * somebody has to learn twice.
 *
 * The search box stays outside the panel because it is not a saved restriction:
 * its text is on screen, so it can never be the invisible filter that makes the
 * list look wrong. Everything that CAN hide is repeated as a removable chip.
 */
export function CustomerToolbar({
  projectNames,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  search,
  onSearchChange,
  shownCount,
  totalCount,
}: CustomerToolbarProps) {
  const [openMenu, setOpenMenu] = useState<"sort" | "filter" | null>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // On a phone these open as sheets, which bring their own backdrop and Escape
  // handling; a second outside-click listener would only fight with them.
  useDismiss(!isMobile && openMenu === "sort", sortRef, () => setOpenMenu(null));
  useDismiss(!isMobile && openMenu === "filter", filterRef, () => setOpenMenu(null));

  // Years are edited as text and committed on change, so the fields keep what
  // the user typed rather than snapping under their cursor.
  const [sinceFromText, setSinceFromText] = useState(() =>
    filters.sinceFrom === null ? "" : String(filters.sinceFrom),
  );
  const [sinceToText, setSinceToText] = useState(() =>
    filters.sinceTo === null ? "" : String(filters.sinceTo),
  );

  const activeCount = countActiveFilters(filters);
  // The trigger button names the PRIMARY level; any levels after it show as
  // the "+N" badge next to it, same as the filter button's count.
  const primaryOption =
    SORT_OPTIONS.find((option) => option.field === sort[0]?.field) ?? SORT_OPTIONS[0]!;

  const toggleHolding = (value: HoldingFilter) => {
    const next = filters.holdings.includes(value)
      ? filters.holdings.filter((holding) => holding !== value)
      : [...filters.holdings, value];

    onFiltersChange({ ...filters, holdings: next });
  };

  const toggleProject = (name: string) => {
    const next = filters.projects.includes(name)
      ? filters.projects.filter((project) => project !== name)
      : [...filters.projects, name];

    onFiltersChange({ ...filters, projects: next });
  };

  const commitSince = (which: "from" | "to", text: string) => {
    const value = Number(text);
    // A half-typed "20" is not a year anybody means, so nothing is applied
    // until there are four digits to apply.
    const year =
      /^\d{4}$/.test(text.trim()) && Number.isFinite(value) && value >= 1900 && value <= 2200
        ? value
        : null;

    onFiltersChange({ ...filters, [which === "from" ? "sinceFrom" : "sinceTo"]: year });
  };

  const clearAll = () => {
    setSinceFromText("");
    setSinceToText("");
    onFiltersChange(NO_CUSTOMER_FILTERS);
  };

  /** One removable chip per applied restriction. */
  const activeChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; clear: () => void }> = [];

    for (const holding of filters.holdings) {
      chips.push({
        key: `holding:${holding}`,
        label: HOLDING_LABELS.find((option) => option.value === holding)?.label ?? holding,
        clear: () =>
          onFiltersChange({
            ...filters,
            holdings: filters.holdings.filter((value) => value !== holding),
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

    if (filters.sinceFrom !== null || filters.sinceTo !== null) {
      const from = filters.sinceFrom;
      const to = filters.sinceTo;

      chips.push({
        key: "since",
        label:
          from && to
            ? `Customer since ${from} – ${to}`
            : from
              ? `Customer since ${from}`
              : `Customer through ${to}`,
        clear: () => {
          setSinceFromText("");
          setSinceToText("");
          onFiltersChange({ ...filters, sinceFrom: null, sinceTo: null });
        },
      });
    }

    return chips;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const filterBody = (
    <>
      <div className="filter-section">
        <p className="menu-title">Contracts</p>
        {HOLDING_LABELS.map((option) => (
          <label key={option.value} className="filter-check">
            <input
              type="checkbox"
              checked={filters.holdings.includes(option.value)}
              onChange={() => toggleHolding(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
        {filters.holdings.length === 0 && (
          <p className="field-hint">Leave all unchecked to show everyone.</p>
        )}
      </div>

      <div className="filter-section">
        <p className="menu-title">Project</p>
        {projectNames.length === 0 && (
          <p className="field-hint">No one has an active contract yet.</p>
        )}
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
        {projectNames.length > 0 && (
          <span className="field-hint">
            Based on each customer's active contracts.
          </span>
        )}
      </div>

      <div className="filter-section">
        <p className="menu-title">Customer since</p>
        <div className="filter-range">
          <input
            type="number"
            inputMode="numeric"
            min="1900"
            max="2200"
            step="1"
            placeholder="From"
            value={sinceFromText}
            onChange={(event) => {
              setSinceFromText(event.target.value);
              commitSince("from", event.target.value);
            }}
          />
          <input
            type="number"
            inputMode="numeric"
            min="1900"
            max="2200"
            step="1"
            placeholder="To"
            value={sinceToText}
            onChange={(event) => {
              setSinceToText(event.target.value);
              commitSince("to", event.target.value);
            }}
          />
        </div>
        <span className="field-hint">The year the person became a customer.</span>
      </div>
    </>
  );

  return (
    <div className="lots-toolbar">
      <div className="toolbar">
        <span className="result-count">
          Showing {shownCount} of {totalCount} customer{totalCount === 1 ? "" : "s"}
        </span>

        <div className="toolbar-spacer" />

        {/* The placeholder names the two things people actually type. What else
            it searches — teléfono, identidad, dirección, notas — is on the
            tooltip: a box wide enough to list all six would not fit beside the
            chips, and nobody reads a placeholder that long anyway. */}
        <div className="table-search">
          <IconSearch />
          <input
            type="search"
            value={search}
            placeholder="Search customers or lots…"
            aria-label="Search customers"
            title="Search by name, phone, ID number, address, notes, lot, or contract"
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
                  Show {shownCount} customer{shownCount === 1 ? "" : "s"}
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
