import { useEffect, useMemo } from "react";
import { useRememberedState } from "../../lib/viewMemory";

import { IconChevronDown, IconPaperclip } from "../../components/Icons";
import { getInitials } from "../../lib/initials";
import type { MoneyView } from "../../lib/money";
import { formatMoney, formatMoneyParts, subtractMoney } from "../../lib/money";
import type { Cents } from "../../lib/money";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import { buildProjectAccents } from "../../lib/projectAccent";
import type { Contract } from "../../types";
import { ContactButtons } from "./ContactButtons";
import { ContractToolbar } from "./ContractToolbar";
import type { ContractFilters } from "./contractFilters";
import type { ContractFilterPreset } from "./contractFilters";
import {
  DEFAULT_CONTRACT_FILTERS,
  NO_CONTRACT_FILTERS,
  filterContracts,
  hasActiveFilters,
  presetFilters,
  searchContracts,
} from "./contractFilters";
import {
  KIND_LABELS,
  SALE_TYPE_LABELS,
  formatDate,
  healthDetail,
  primaryStamp,
} from "./contractPresentation";
import type { ContractSort } from "./contractSort";
import { DEFAULT_SORT, groupByCustomer, sortContracts } from "./contractSort";

/**
 * "The signed copy is on file", at a glance down the list.
 *
 * Answers the question this whole feature exists for — which contracts have
 * their paperwork and which are still only a row in a database — without
 * opening four hundred of them one at a time. Marks presence rather than
 * absence: every contract predating the feature has none, so flagging the gaps
 * would put a warning on every row on day one.
 *
 * Not a button. The panel behind it is one click away on the same row, and a
 * second target the width of an icon, inside a row that is already a link, is
 * a way to open the wrong thing on a phone.
 */
function DocumentMark({ contract }: { contract: Contract }) {
  return (
    <span
      className="contract-doc-mark"
      title={
        contract.documentCount === 1
          ? "Signed contract saved"
          : `${contract.documentCount} documents saved`
      }
      aria-label={
        contract.documentCount === 1
          ? "Signed contract saved"
          : `${contract.documentCount} documents saved`
      }
    >
      <IconPaperclip />
      {contract.documentCount > 1 && <span>{contract.documentCount}</span>}
    </span>
  );
}

/** The empty state has to span every column. */
const COLUMN_COUNT = 8;

interface ContractsPageProps {
  contracts: Contract[];
  money: MoneyView;
  user: User;
  /** Opens the detail panel. Owned by App, since it covers the page. */
  onOpenContract: (contract: Contract) => void;
  /** Opens the split preview for a purchase of several lots. */
  onSplitPayment: (contracts: Contract[]) => void;
  /** Opens the adenda dialog for a purchase of several lots. */
  onAmendPurchase: (contracts: Contract[]) => void;
  /**
   * Filters handed over by another screen — the Panel General drilling into
   * the overdue contracts. `null` when this screen was opened normally.
   */
  filterPreset?: ContractFilterPreset | null;
  /** Says the preset has been taken, so it is not applied a second time. */
  onPresetApplied?: () => void;
}

export function ContractsPage({
  contracts,
  money,
  user,
  onOpenContract,
  onSplitPayment,
  onAmendPurchase,
  filterPreset = null,
  onPresetApplied,
}: ContractsPageProps) {
  const canRecordPayment = can(user, "payment:record");
  const canAmend = can(user, "contract:amend");

  const [search, setSearch] = useRememberedState("contracts.search", "");
  const [filters, setFilters] = useRememberedState<ContractFilters>(
    "contracts.filters",
    DEFAULT_CONTRACT_FILTERS,
  );
  const [sort, setSort] = useRememberedState<ContractSort>("contracts.sort", DEFAULT_SORT);
  // Which customers are folded shut. Everything starts open: a collapsed group
  // hides a balance, and this screen exists to show balances.
  const [collapsed, setCollapsed] = useRememberedState<ReadonlySet<string>>(
    "contracts.collapsed",
    new Set(),
  );

  /*
   * Adopt filters another screen arrived with, exactly once.
   *
   * Applied in an effect and then handed back, rather than read straight into
   * the initial state: the initial state is whatever the reader last left
   * Contratos at (see `viewMemory`), and the preset has to win over that — it
   * is also overwritten in place if Contratos is already open. Clearing it
   * afterwards is what lets the reader then change the filters freely — without
   * that, every render would reset them to the preset.
   */
  useEffect(() => {
    if (!filterPreset) {
      return;
    }

    setSearch("");
    setFilters(presetFilters(filterPreset));
    onPresetApplied?.();
  }, [filterPreset, onPresetApplied]);

  // Derived from state, recalculated when something it depends on changes.
  // Search, filter and sort are a VIEW of `contracts`, never a second copy.
  const visible = useMemo(
    () => sortContracts(filterContracts(searchContracts(contracts, search), filters), sort),
    [contracts, search, filters, sort],
  );

  // Grouped AFTER sorting, so a group sits wherever its first contract landed
  // and "atrasados primero" still puts the worst customer at the top.
  const groups = useMemo(() => groupByCustomer(visible), [visible]);

  // Only the customers actually worth folding — a lone contract has no group
  // row to toggle, so it takes no part in "expand/collapse all".
  const multiGroups = useMemo(() => groups.filter((group) => group.contracts.length > 1), [groups]);
  const allGroupsExpanded =
    multiGroups.length > 0 && multiGroups.every((group) => !collapsed.has(group.customerId));

  const projectNames = useMemo(
    () =>
      [...new Set(contracts.map((contract) => contract.lot.projectName))].sort((a, b) =>
        a.localeCompare(b, "es"),
      ),
    [contracts],
  );

  // Built from the full list so a project keeps the same colour as the filters
  // narrow, and the same colour it has on Lotes and Clientes.
  const projectAccents = useMemo(() => buildProjectAccents(projectNames), [projectNames]);

  const isNarrowed = search.trim() !== "" || hasActiveFilters(filters);

  const toggleGroup = (customerId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(customerId)) {
        next.add(customerId);
      }
      return next;
    });
  };

  // One press folds every multi-contract customer shut, or opens them all back
  // up — the fast way to scan just the group headers for who holds more than
  // one lot, without clicking each one in turn.
  const toggleAllGroups = () => {
    setCollapsed((current) => {
      const next = new Set(current);

      for (const group of multiGroups) {
        if (allGroupsExpanded) {
          next.add(group.customerId);
        } else {
          next.delete(group.customerId);
        }
      }

      return next;
    });
  };

  const clearEverything = () => {
    setSearch("");
    setFilters(NO_CONTRACT_FILTERS);
  };

  /** The money cell used all down the table: tinted symbol, full-strength digits. */
  const moneyCell = (amount: Cents, className = "") => {
    const parts = formatMoneyParts(amount, money);

    return (
      <span className={`cell-money ${className}`}>
        <span className="currency-symbol">{parts.symbol}</span>
        {parts.value}
      </span>
    );
  };

  return (
    <section className="panel active">
      <ContractToolbar
        projectNames={projectNames}
        filters={filters}
        onFiltersChange={setFilters}
        sort={sort}
        onSortChange={setSort}
        search={search}
        onSearchChange={setSearch}
        shownCount={visible.length}
        totalCount={contracts.length}
        multiGroupCount={multiGroups.length}
        allGroupsExpanded={allGroupsExpanded}
        onToggleAllGroups={toggleAllGroups}
      />

      <div className="card">
        <div className="table-wrap contracts-desktop">
          <table className="contracts-table">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Customer</th>
                <th>Lot</th>
                {/* Price and prima share a column: the prima is a PART of the
                    price, not a peer of it, and giving it a column of its own
                    pushed the payment health off a 1440px screen. */}
                <th className="col-money">Price · down payment</th>
                <th className="col-money">Balance</th>
                <th className="col-money">Monthly</th>
                <th>Status</th>
                {/* No visible heading: three 28px icons under the word
                    "Contacto" would be a column captioned wider than itself.
                    The name is given to screen readers instead. */}
                <th className="col-contact">
                  <span className="sr-only">Contact</span>
                </th>
              </tr>
            </thead>

            {/* One <tbody> per customer rather than one for the whole table.
                A table may hold several row groups, and that is exactly what a
                customer with three lots is — which also gives the group header
                and its rows a single element to be styled and folded by. */}
            {groups.map((group) => {
                const isGrouped = group.contracts.length > 1;
                const isCollapsed = collapsed.has(group.customerId);
                const stamp = primaryStamp(group.worst);

                return (
                  <tbody key={group.customerId} className="contract-group">
                    {isGrouped && (
                      <tr className="group-row">
                        <td colSpan={3}>
                          <button
                            type="button"
                            className={isCollapsed ? "group-toggle" : "group-toggle open"}
                            onClick={() => toggleGroup(group.customerId)}
                            aria-expanded={!isCollapsed}
                          >
                            <IconChevronDown />
                            <span className="holder-avatar">
                              {getInitials(group.customerName)}
                            </span>
                            <span className="holder-text">
                              <span className="holder-name">{group.customerName}</span>
                              <span className="holder-contract">
                                {group.contracts.length} contracts
                                {/* One signature and one receipt, versus lots
                                    bought years apart by the same person. The
                                    split only makes sense for the first. */}
                                {group.isOnePurchase ? " · single purchase" : ""}
                              </span>
                            </span>
                          </button>

                          {group.isOnePurchase && canRecordPayment && (
                            <button
                              type="button"
                              className="link-btn group-split"
                              onClick={(event) => {
                                event.stopPropagation();
                                onSplitPayment(group.contracts);
                              }}
                            >
                              Split payment
                            </button>
                          )}

                          {/* The new total and plazo for the whole purchase at
                              once. Only over signed sales still running — a
                              reservation is converted, not amended. */}
                          {group.isOnePurchase &&
                            canAmend &&
                            group.contracts.every(
                              (contract) =>
                                contract.status === "active" && contract.kind === "contract",
                            ) && (
                              <button
                                type="button"
                                className="link-btn group-split"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onAmendPurchase(group.contracts);
                                }}
                              >
                                Amend purchase
                              </button>
                            )}
                        </td>
                        <td className="col-money">
                          {moneyCell(group.totalPrice, "is-total")}
                          {/* Only when there is one. The rows underneath have
                              always hidden a prima of zero; the header saying
                              "prima L 0.00" over a purchase paid de contado was
                              the one place the number still showed. */}
                          {group.totalDownPayment > 0 && (
                            <span className="cell-sub">
                              down payment {formatMoney(group.totalDownPayment, money)}
                            </span>
                          )}
                        </td>
                        <td className="col-money">{moneyCell(group.totalBalance, "is-total")}</td>
                        <td className="col-money">{moneyCell(group.totalMonthly, "is-total")}</td>
                        <td>
                          <span className={stamp.stampClass}>{stamp.label}</span>
                        </td>
                        <td className="col-contact">
                          {/*
                            One message for the whole purchase rather than one
                            per lot. `group.contracts[0]` is not an arbitrary
                            pick: a group is one customer, and for the common
                            case — several lots bought together — every contract
                            in it shares the customer, the project and the
                            purchase. The message names that first lot and
                            contract, which is the reference the customer can
                            actually be asked about; chasing one specific lot of
                            three is what the rows underneath are for.
                          */}
                          <ContactButtons contract={group.contracts[0]!} money={money} />
                        </td>
                      </tr>
                    )}

                    {(!isGrouped || !isCollapsed) &&
                      group.contracts.map((contract) => {
                        const rowStamp = primaryStamp(contract);
                        const detail = healthDetail(contract);
                        const accent = projectAccents.get(contract.lot.projectName) ?? "";

                        return (
                          <tr
                            key={contract.id}
                            className={isGrouped ? "contract-row is-grouped" : "contract-row"}
                            onClick={() => onOpenContract(contract)}
                          >
                            <td>
                              {/* The row is clickable for the mouse, but a
                                  <tr> is not reachable by keyboard. This button
                                  is the real control, so tabbing through the
                                  table still opens each contract. */}
                              <button
                                type="button"
                                className="contract-open"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onOpenContract(contract);
                                }}
                                title={`View contract ${contract.code}`}
                              >
                                <span className="code-badge">{contract.code}</span>
                                {contract.documentCount > 0 && <DocumentMark contract={contract} />}
                                <span className="contract-kind">
                                  {KIND_LABELS[contract.kind]} ·{" "}
                                  {SALE_TYPE_LABELS[contract.saleType]}
                                </span>
                              </button>
                            </td>
                            <td>
                              {/* Repeating the name inside a group would be
                                  noise: the header above already says it — so
                                  a grouped row spends the cell on its note
                                  instead, beside the arrow. The note belongs to
                                  the CONTRACT, not the person, so three lots
                                  bought together can each carry their own. */}
                              {isGrouped ? (
                                <span className="holder-btn is-static">
                                  <span className="holder-empty">↳</span>
                                  {contract.notes && (
                                    <span className="contract-note">{contract.notes}</span>
                                  )}
                                </span>
                              ) : (
                                <span className="holder-btn is-static">
                                  <span className="holder-avatar">
                                    {getInitials(contract.customer.fullName)}
                                  </span>
                                  <span className="holder-text">
                                    <span className="holder-name">
                                      {contract.customer.fullName}
                                    </span>
                                    {/* Under the name rather than in a column
                                        of its own: notes run to a sentence, and
                                        a seventh column would push the payment
                                        health — the reason this screen exists —
                                        off a 1440px screen. It wraps onto as
                                        many lines as it needs rather than
                                        ending in a silent "…", so the row is
                                        allowed to grow with a long note. */}
                                    {contract.notes && (
                                      <span className="contract-note">{contract.notes}</span>
                                    )}
                                  </span>
                                </span>
                              )}
                            </td>
                            <td>
                              {/* Stacked rather than "A-07 · Proyecto Santiago
                                  Etapa 1" on one line: a project name that long
                                  in a nine-column table pushed the payment
                                  health — the column this screen exists for —
                                  off the right edge of a 1440px screen. */}
                              <span className="contract-lot">
                                <span className="code-badge">{contract.lot.code}</span>
                                <span className={`cell-project cell-sub ${accent}`}>
                                  <span className="project-dot" />
                                  {contract.lot.projectName}
                                </span>
                              </span>
                            </td>
                            <td className="col-money">
                              {moneyCell(contract.terms.salePrice)}
                              {/* The prima that was AGREED and the prima that
                                  arrived are different facts. The sub-line says
                                  which, so a customer who signed and never came
                                  back cannot hide behind a figure that only
                                  describes the paperwork. */}
                              {contract.terms.downPayment > 0 && (
                                <span
                                  className={
                                    contract.downPaymentPaid < contract.terms.downPayment
                                      ? "cell-sub warn"
                                      : "cell-sub"
                                  }
                                >
                                  down payment {formatMoney(contract.terms.downPayment, money)}
                                  {contract.downPaymentPaid < contract.terms.downPayment &&
                                    (contract.downPaymentPaid === 0
                                      ? " · unpaid"
                                      : ` · remaining ${formatMoney(
                                          subtractMoney(
                                            contract.terms.downPayment,
                                            contract.downPaymentPaid,
                                          ),
                                          money,
                                        )}`)}
                                </span>
                              )}
                            </td>
                            <td className="col-money">
                              {moneyCell(contract.balance, "is-balance")}
                            </td>
                            <td className="col-money">
                              {contract.terms.monthlyPayment === null ? (
                                <span className="holder-empty">—</span>
                              ) : (
                                <>
                                  {moneyCell(contract.terms.monthlyPayment)}
                                  <span className="cell-sub">day {contract.terms.dueDay}</span>
                                </>
                              )}
                            </td>
                            <td>
                              <span className={rowStamp.stampClass}>{rowStamp.label}</span>
                              {detail !== "" && <span className="cell-sub">{detail}</span>}
                              {contract.health.nextDueOn && detail === "" && (
                                <span className="cell-sub">
                                  due {formatDate(contract.health.nextDueOn)}
                                </span>
                              )}
                            </td>
                            <td className="col-contact">
                              <ContactButtons contract={contract} money={money} />
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                );
            })}

            {visible.length === 0 && (
              <tbody>
                <tr>
                  <td colSpan={COLUMN_COUNT} className="table-empty">
                    {contracts.length === 0 ? (
                      "No contracts have been recorded yet."
                    ) : (
                      <>
                        <p>
                          {search.trim() === ""
                            ? "No contracts match the filters."
                            : `No contracts match “${search.trim()}”.`}
                        </p>
                        {/* An empty table is where a forgotten filter finally
                            shows itself — and this screen opens with one on, so
                            the way out has to be offered right here. */}
                      {isNarrowed && (
                        <button type="button" className="link-btn" onClick={clearEverything}>
                          Clear search and filters
                        </button>
                      )}
                    </>
                  )}
                  </td>
                </tr>
              </tbody>
            )}
          </table>
        </div>

        {/*
          The phone view. A nine-column table on a 360px screen is a table
          nobody reads, so the same rows are rebuilt as cards that lead with the
          two things being looked for: who, and how much do they owe.
        */}
        <div className="contracts-cards">
          {groups.map((group) => (
            <div key={group.customerId} className="contract-card-group">
              {group.contracts.length > 1 && (
                <div className="contract-card-head">
                  <span className="holder-avatar">{getInitials(group.customerName)}</span>
                  <div className="holder-text">
                    <span className="holder-name">{group.customerName}</span>
                    <span className="holder-contract">
                      {group.contracts.length} contracts · balance{" "}
                      {formatMoney(group.totalBalance, money)}
                    </span>
                  </div>
                </div>
              )}

              {group.contracts.map((contract) => {
                const stamp = primaryStamp(contract);
                const detail = healthDetail(contract);
                const isGrouped = group.contracts.length > 1;

                return (
                  /*
                    The card and its contact row are siblings inside this
                    wrapper rather than the row sitting inside the card. The
                    card is a <button>, and a link inside a button is invalid
                    HTML that browsers resolve by guessing — in practice the
                    tap opens the contract instead of the message, which is
                    exactly the failure a phone user would hit first.
                  */
                  <div key={contract.id} className="contract-card-shell">
                  <button
                    type="button"
                    className="contract-card"
                    onClick={() => onOpenContract(contract)}
                  >
                    <div className="contract-card-top">
                      <span className="code-badge">{contract.code}</span>
                      {contract.documentCount > 0 && <DocumentMark contract={contract} />}
                      <span className={stamp.stampClass}>{stamp.label}</span>
                    </div>

                    {/* Inside a group the header above already names the
                        person, so the card leads with the lot instead of
                        repeating them three times down the screen. */}
                    {isGrouped ? (
                      <p className="contract-card-name">{contract.lot.code}</p>
                    ) : (
                      <>
                        <p className="contract-card-name">{contract.customer.fullName}</p>
                        <p className="contract-card-lot">
                          {contract.lot.code} · {contract.lot.projectName}
                        </p>
                      </>
                    )}
                    {isGrouped && <p className="contract-card-lot">{contract.lot.projectName}</p>}

                    <div className="contract-card-balance">
                      <span>Balance</span>
                      <strong>{formatMoney(contract.balance, money)}</strong>
                    </div>

                    <p className="contract-card-foot">
                      {contract.terms.monthlyPayment === null
                        ? SALE_TYPE_LABELS[contract.saleType]
                        : `${formatMoney(contract.terms.monthlyPayment, money)} · day ${
                            contract.terms.dueDay
                          }`}
                      {detail !== "" ? ` · ${detail}` : ""}
                    </p>

                    {/* Not clamped here. A card has the width the table cell
                        does not, and a phone is exactly where somebody is
                        reading the note before making the call. */}
                    {contract.notes && (
                      <p className="contract-card-note">{contract.notes}</p>
                    )}
                  </button>

                  {/* The reason to open this list on a phone in the first
                      place: the customer is on the other end of one of these
                      three. Full-width targets rather than the 25px icons the
                      table uses, because this is a thumb. */}
                  <div className="contract-card-contact">
                    <ContactButtons contract={contract} money={money} />
                  </div>
                  </div>
                );
              })}
            </div>
          ))}

          {visible.length === 0 && (
            <p className="state-message">
              {contracts.length === 0
                ? "No contracts have been recorded yet."
                : "No contracts match the filters."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
