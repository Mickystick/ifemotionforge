import { useMemo } from "react";
import { useRememberedState } from "../../lib/viewMemory";

import { IconArchive, IconEdit, IconRestore } from "../../components/Icons";
import { formatAreaParts } from "../../lib/area";
import type { AreaUnit } from "../../lib/area";
import { getInitials } from "../../lib/initials";
import type { MoneyView } from "../../lib/money";
import { formatMoneyParts } from "../../lib/money";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import { buildProjectAccents } from "../../lib/projectAccent";
import type { Customer, Lot, LotStatus } from "../../types";
import { filterLots, hasActiveFilters, NO_FILTERS } from "./lotFilters";
import type { LotFilters } from "./lotFilters";
import { lotStatus } from "./lotStatus";
import { LotToolbar } from "./LotToolbar";
import { DEFAULT_SORT, sortLots } from "./lotSort";
import type { LotSort } from "./lotSort";

/**
 * How each status is shown to the user. Keeping this in one place means the
 * Spanish wording and the colour are defined once, not scattered through JSX.
 *
 * The colours carry the ownership line, not just five different hues: the three
 * warm ones are lots we still own — free, held, or being paid for — and grey is
 * a lot that has left us. So a glance down the column says how much land is
 * still the company's without reading a single word.
 */
const statusPresentation: Record<LotStatus, { label: string; stampClass: string }> = {
  available: { label: "Available", stampClass: "stamp success" },
  reserved: { label: "Reserved", stampClass: "stamp warning" },
  financed: { label: "Financed", stampClass: "stamp clay" },
  sold: { label: "Sold", stampClass: "stamp neutral" },
  donated: { label: "Donated", stampClass: "stamp neutral" },
};

interface LotsPageProps {
  lots: Lot[];
  customersById: Map<string, Customer>;
  /** Which currency to show money in, and the rate if that is dollars. */
  money: MoneyView;
  /** The area unit each project is shown in — see lib/area.ts. */
  unitByProject: Map<string, AreaUnit>;
  /** Opens the customer quick-look panel. Owned by App, since it covers the page. */
  onOpenCustomer: (customerId: string, lot: Lot) => void;
  user: User;
  onEditLot: (lot: Lot) => void;
  onArchiveLot: (lot: Lot) => void;
  onRestoreLot: (lot: Lot) => void;
}

export function LotsPage({
  lots,
  customersById,
  money,
  unitByProject,
  onOpenCustomer,
  user,
  onEditLot,
  onArchiveLot,
  onRestoreLot,
}: LotsPageProps) {
  // Which buttons to render. The server re-checks the same capabilities on
  // every write — hiding a button is convenience, not protection.
  const canEdit = can(user, "lot:edit");
  const canArchive = can(user, "lot:archive");
  const showActions = canEdit || canArchive;

  // The API sends archived lots too (see `fetchLots`), kept off the working
  // list here and shown only when the user asks — exactly like Proyectos.
  const activeLots = useMemo(() => lots.filter((lot) => lot.archivedAt === null), [lots]);
  const archivedLots = useMemo(() => lots.filter((lot) => lot.archivedAt !== null), [lots]);

  // `useState` gives a component memory. Calling the setter tells React to
  // re-render with the new value — you never touch the DOM yourself. The
  // remembered flavour also keeps it across a tab change; see `viewMemory`.
  const [filters, setFilters] = useRememberedState<LotFilters>("lots.filters", NO_FILTERS);
  const [sort, setSort] = useRememberedState<LotSort>("lots.sort", DEFAULT_SORT);
  const [showArchived, setShowArchived] = useRememberedState("lots.showArchived", false);

  // Derived from state, recalculated when something it depends on changes.
  // There is no second copy of the list to keep in sync, which is the whole
  // point of this approach: filter and sort are a VIEW of `activeLots`, not an
  // edit of it.
  const visibleLots = useMemo(
    () => sortLots(filterLots(activeLots, filters), sort, customersById),
    [activeLots, filters, sort, customersById],
  );

  // Offered in the filter panel, built from the inventory itself so a project
  // that has no lots never appears as an option that matches nothing.
  const projectNames = useMemo(
    () =>
      [...new Set(activeLots.map((lot) => lot.projectName))].sort((a, b) =>
        a.localeCompare(b, "es"),
      ),
    [activeLots],
  );

  // Built from the full list, not the filtered one, so a project keeps the same
  // colour when you switch filters. `useMemo` skips the work on renders where
  // the lots have not changed.
  const projectAccents = useMemo(
    () => buildProjectAccents(lots.map((lot) => lot.projectName)),
    [lots],
  );

  return (
    <section className="panel active">
      {canArchive && archivedLots.length > 0 && (
        <div className="toolbar">
          <button
            type="button"
            className={showArchived ? "chip" : "chip active"}
            onClick={() => setShowArchived(false)}
          >
            Active ({activeLots.length})
          </button>
          <button
            type="button"
            className={showArchived ? "chip active" : "chip"}
            onClick={() => setShowArchived(true)}
          >
            Archived ({archivedLots.length})
          </button>
        </div>
      )}

      {showArchived ? (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Lot</th>
                  <th>Project</th>
                  <th>Reason</th>
                  <th className="col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {archivedLots.map((lot) => (
                  <tr key={lot.id}>
                    <td>
                      <span className="code-badge">{lot.code}</span>
                    </td>
                    <td>
                      <span className={`cell-project ${projectAccents.get(lot.projectName) ?? ""}`}>
                        <span className="project-dot" />
                        {lot.projectName}
                      </span>
                    </td>
                    <td>
                      <span className="holder-empty">Archived</span>
                    </td>
                    <td>
                      <span className="row-actions">
                        <button
                          type="button"
                          className="row-action"
                          onClick={() => onRestoreLot(lot)}
                          title={`Restore lot ${lot.code}`}
                          aria-label={`Restore lot ${lot.code}`}
                        >
                          <IconRestore />
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <>
          <LotToolbar
            projectNames={projectNames}
            unitByProject={unitByProject}
            money={money}
            filters={filters}
            onFiltersChange={setFilters}
            sort={sort}
            onSortChange={setSort}
            shownCount={visibleLots.length}
            totalCount={activeLots.length}
          />

          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Lot</th>
                    <th>Project</th>
                    <th>Area</th>
                    <th className="col-money">Base price</th>
                    <th>Customer</th>
                    <th>Status</th>
                    <th className="col-actions">{showActions ? "Actions" : ""}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLots.map((lot) => {
                    const status = statusPresentation[lotStatus(lot)];
                    const price = formatMoneyParts(lot.basePrice, money);
                    const holder = lot.holding
                      ? customersById.get(lot.holding.customerId)
                      : undefined;
                    // Each row is written in ITS OWN project's unit: a project
                    // sold in manzanas reads in manzanas even next to one sold
                    // in metres.
                    const area = formatAreaParts(
                      lot.areaM2,
                      unitByProject.get(lot.projectName) ?? "m2",
                    );

                    return (
                      <tr key={lot.id}>
                        <td>
                          <span className="code-badge">{lot.code}</span>
                        </td>
                        <td>
                          <span
                            className={`cell-project ${projectAccents.get(lot.projectName) ?? ""}`}
                          >
                            <span className="project-dot" />
                            {lot.projectName}
                          </span>
                        </td>
                        <td className="cell-area">
                          {area.value}
                          <span className="unit">{area.symbol}</span>
                        </td>
                        <td className="col-money">
                          <span className="cell-money">
                            <span className="currency-symbol">{price.symbol}</span>
                            {price.value}
                          </span>
                        </td>
                        <td>
                          {lot.holding && holder ? (
                            <button
                              type="button"
                              className="holder-btn"
                              onClick={() => onOpenCustomer(holder.id, lot)}
                              title={`View ${holder.fullName}'s information`}
                            >
                              <span className="holder-avatar">{getInitials(holder.fullName)}</span>
                              <span className="holder-text">
                                <span className="holder-name">{holder.fullName}</span>
                                <span className="holder-contract">{lot.holding.contractCode}</span>
                              </span>
                            </button>
                          ) : (
                            <span className="holder-empty">No contract</span>
                          )}
                        </td>
                        <td>
                          <span className={status.stampClass}>{status.label}</span>
                        </td>
                        <td>
                          {showActions ? (
                            <span className="row-actions">
                              {canEdit && (
                                <button
                                  type="button"
                                  className="row-action"
                                  onClick={() => onEditLot(lot)}
                                  title={`Edit lot ${lot.code}`}
                                  aria-label={`Edit lot ${lot.code}`}
                                >
                                  <IconEdit />
                                </button>
                              )}
                              {canArchive && (
                                <button
                                  type="button"
                                  className="row-action danger"
                                  onClick={() => onArchiveLot(lot)}
                                  title={`Archive lot ${lot.code}`}
                                  aria-label={`Archive lot ${lot.code}`}
                                >
                                  <IconArchive />
                                </button>
                              )}
                            </span>
                          ) : (
                            <span
                              className="row-actions-locked"
                              title="Requires owner permission"
                            >
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {visibleLots.length === 0 && (
                    <tr>
                      <td colSpan={7} className="table-empty">
                        {activeLots.length === 0 ? (
                          "No lots have been added yet."
                        ) : (
                          <>
                            <p>No lots match your search.</p>
                            {/* An empty table is where a forgotten filter
                                finally shows itself, so the way out is offered
                                right here instead of leaving the user hunting
                                for it. */}
                            {hasActiveFilters(filters) && (
                              <button
                                type="button"
                                className="link-btn"
                                onClick={() => setFilters(NO_FILTERS)}
                              >
                                Clear filters
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
