import { useMemo, useRef, useState } from "react";

import { IconClose, IconFilter, IconSort } from "../../components/Icons";
import { MenuSurface } from "../../components/MenuSurface";
import { MoneyInput } from "../../components/MoneyInput";
import { SortMenu } from "../../components/SortMenu";
import { AREA_UNIT_INFO, fromSquareMetres, toSquareMetres } from "../../lib/area";
import type { AreaUnit } from "../../lib/area";
import { formatMoney, fromCurrencyUnits, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { MoneyView } from "../../lib/money";
import { useDismiss } from "../../lib/useDismiss";
import { useIsMobile } from "../../lib/viewport";
import type { LotStatus } from "../../types";
import type { LotFilters } from "./lotFilters";
import { NO_FILTERS, countActiveFilters } from "./lotFilters";
import { SORT_OPTIONS } from "./lotSort";
import type { LotSort } from "./lotSort";

/** The wording used everywhere else for each status, in inventory order. */
const STATUS_LABELS: Array<{ value: LotStatus; label: string }> = [
  { value: "available", label: "Available" },
  { value: "reserved", label: "Reserved" },
  { value: "financed", label: "Financed" },
  { value: "sold", label: "Sold" },
  { value: "donated", label: "Donated" },
];

interface LotToolbarProps {
  /** Every project present in the inventory, for the project checkboxes. */
  projectNames: string[];
  /** Used to label the area range in a unit the user actually works in. */
  unitByProject: Map<string, AreaUnit>;
  money: MoneyView;
  filters: LotFilters;
  onFiltersChange: (filters: LotFilters) => void;
  sort: LotSort;
  onSortChange: (sort: LotSort) => void;
  /** For the "Mostrando X de Y" count. */
  shownCount: number;
  totalCount: number;
}

/**
 * The Lotes toolbar: one sort menu, one filter panel.
 *
 * Status used to sit outside as its own row of chips, which meant it could not
 * be combined with anything — picking a project threw away the status, and the
 * two controls quietly competed. Inside the panel it is just another
 * restriction, so "los disponibles de Valle Verde" is one question.
 *
 * Everything applied is repeated underneath as a removable chip. A filter you
 * cannot see is a filter you forget you set, and then the list looks wrong for
 * reasons nobody can find.
 */
export function LotToolbar({
  projectNames,
  unitByProject,
  money,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  shownCount,
  totalCount,
}: LotToolbarProps) {
  const [openMenu, setOpenMenu] = useState<"sort" | "filter" | null>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // On a phone these open as sheets, which bring their own backdrop and Escape
  // handling; a second outside-click listener would only fight with them.
  useDismiss(!isMobile && openMenu === "sort", sortRef, () => setOpenMenu(null));
  useDismiss(!isMobile && openMenu === "filter", filterRef, () => setOpenMenu(null));

  /**
   * The unit the area range is typed in.
   *
   * With exactly one project selected, that project's unit — someone filtering
   * Monte Real thinks in varas, not metres. Otherwise square metres, because a
   * range spanning projects written in different units has no other honest
   * unit to be in.
   */
  const areaUnit: AreaUnit =
    filters.projects.length === 1 ? (unitByProject.get(filters.projects[0]!) ?? "m2") : "m2";
  const areaUnitInfo = AREA_UNIT_INFO[areaUnit];

  // Money and area are edited as text and converted on change, so the fields
  // keep whatever the user typed rather than snapping under their cursor.
  const [minPriceText, setMinPriceText] = useState(() =>
    filters.minPrice === null ? "" : toMoneyInput(filters.minPrice),
  );
  const [maxPriceText, setMaxPriceText] = useState(() =>
    filters.maxPrice === null ? "" : toMoneyInput(filters.maxPrice),
  );
  const [minAreaText, setMinAreaText] = useState("");
  const [maxAreaText, setMaxAreaText] = useState("");

  const activeCount = countActiveFilters(filters);
  // The trigger button names the PRIMARY level; any levels after it show as
  // the "+N" badge next to it, same as the filter button's count.
  const primaryOption =
    SORT_OPTIONS.find((option) => option.field === sort[0]?.field) ?? SORT_OPTIONS[0]!;

  const toggleStatus = (value: LotStatus) => {
    const next = filters.statuses.includes(value)
      ? filters.statuses.filter((status) => status !== value)
      : [...filters.statuses, value];

    onFiltersChange({ ...filters, statuses: next });
  };

  const toggleProject = (name: string) => {
    const next = filters.projects.includes(name)
      ? filters.projects.filter((project) => project !== name)
      : [...filters.projects, name];

    onFiltersChange({ ...filters, projects: next });
  };

  const commitPrice = (which: "min" | "max", text: string) => {
    const value = parseMoneyInput(text);
    const amount = Number.isFinite(value) && value >= 0 ? fromCurrencyUnits(value) : null;

    onFiltersChange({ ...filters, [which === "min" ? "minPrice" : "maxPrice"]: amount });
  };

  const commitArea = (which: "min" | "max", text: string) => {
    const value = Number(text);
    const areaM2 =
      text.trim() !== "" && Number.isFinite(value) && value >= 0
        ? toSquareMetres(value, areaUnit)
        : null;

    onFiltersChange({ ...filters, [which === "min" ? "minAreaM2" : "maxAreaM2"]: areaM2 });
  };

  const clearAll = () => {
    setMinPriceText("");
    setMaxPriceText("");
    setMinAreaText("");
    setMaxAreaText("");
    onFiltersChange(NO_FILTERS);
  };

  /** One removable chip per applied restriction. */
  const activeChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; clear: () => void }> = [];

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

    if (filters.minPrice !== null || filters.maxPrice !== null) {
      const from = filters.minPrice === null ? null : formatMoney(filters.minPrice, money);
      const to = filters.maxPrice === null ? null : formatMoney(filters.maxPrice, money);

      chips.push({
        key: "price",
        label: from && to ? `${from} – ${to}` : from ? `From ${from}` : `Up to ${to}`,
        clear: () => {
          setMinPriceText("");
          setMaxPriceText("");
          onFiltersChange({ ...filters, minPrice: null, maxPrice: null });
        },
      });
    }

    if (filters.minAreaM2 !== null || filters.maxAreaM2 !== null) {
      const show = (value: number) =>
        `${Number(fromSquareMetres(value, areaUnit).toFixed(areaUnitInfo.decimals))} ${areaUnitInfo.symbol}`;
      const from = filters.minAreaM2 === null ? null : show(filters.minAreaM2);
      const to = filters.maxAreaM2 === null ? null : show(filters.maxAreaM2);

      chips.push({
        key: "area",
        label: from && to ? `${from} – ${to}` : from ? `From ${from}` : `Up to ${to}`,
        clear: () => {
          setMinAreaText("");
          setMaxAreaText("");
          onFiltersChange({ ...filters, minAreaM2: null, maxAreaM2: null });
        },
      });
    }

    return chips;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, money, areaUnit, areaUnitInfo]);

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
        {filters.statuses.length === 0 && (
          <p className="field-hint">Leave all unchecked to show all statuses.</p>
        )}
      </div>

      <div className="filter-section">
        <p className="menu-title">Project</p>
        {projectNames.length === 0 && <p className="field-hint">No projects.</p>}
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
        <p className="menu-title">Base price</p>
        <div className="filter-range">
          <MoneyInput
            id="filter-min-price"
            value={minPriceText}
            placeholder="From"
            onChange={(next) => {
              setMinPriceText(next);
              commitPrice("min", next);
            }}
          />
          <MoneyInput
            id="filter-max-price"
            value={maxPriceText}
            placeholder="To"
            onChange={(next) => {
              setMaxPriceText(next);
              commitPrice("max", next);
            }}
          />
        </div>
        <span className="field-hint">Always in lempiras, as entered.</span>
      </div>

      <div className="filter-section">
        <p className="menu-title">Area</p>
        <div className="filter-range">
          <div className="input-with-suffix">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              placeholder="From"
              value={minAreaText}
              onChange={(event) => {
                setMinAreaText(event.target.value);
                commitArea("min", event.target.value);
              }}
            />
            <span className="unit-suffix">{areaUnitInfo.symbol}</span>
          </div>
          <div className="input-with-suffix">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              placeholder="To"
              value={maxAreaText}
              onChange={(event) => {
                setMaxAreaText(event.target.value);
                commitArea("max", event.target.value);
              }}
            />
            <span className="unit-suffix">{areaUnitInfo.symbol}</span>
          </div>
        </div>
        <span className="field-hint">
          {filters.projects.length === 1
            ? `In ${areaUnitInfo.label.toLowerCase()}, the unit used by ${filters.projects[0]}.`
            : "In square meters, the unit used to store all areas."}
        </span>
      </div>
    </>
  );

  return (
    <div className="lots-toolbar">
      <div className="toolbar">
        <span className="result-count">
          Showing {shownCount} of {totalCount} lot{totalCount === 1 ? "" : "s"}
        </span>

        <div className="toolbar-spacer" />

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
                  Show {shownCount} lot{shownCount === 1 ? "" : "s"}
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
