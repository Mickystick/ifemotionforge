import { useMemo, useState } from "react";

import { IconSearch } from "../../components/Icons";
import { formatArea } from "../../lib/area";
import type { AreaUnit } from "../../lib/area";
import { customerLine } from "../../lib/identification";
import { getInitials } from "../../lib/initials";
import type { MoneyView } from "../../lib/money";
import { formatMoney } from "../../lib/money";
import type { CustomerRecord, Lot } from "../../types";

/**
 * The two "which one?" controls of the Nuevo contrato form.
 *
 * A `<select>` was the obvious choice and the wrong one. Both of these lists
 * grow without limit — a project is hundreds of lots, and a business that has
 * been running a few years is hundreds of customers — and a native dropdown
 * gives you one line of text per option, no search worth the name on a phone,
 * and nowhere to show the identity number that tells two Josés apart or the
 * price that tells you whether you picked the right lot.
 *
 * So: type to narrow, and the rows carry what somebody actually needs to
 * recognise the right record. Once one is picked the list collapses to a single
 * confirmation row, because the rest of the form is long and this question is
 * settled.
 */

/**
 * How many rows to draw before asking the user to narrow the search.
 *
 * The container scrolls, so this is not about fitting — it is about not
 * rendering nine hundred rows nobody will scroll to on a phone.
 */
const MAX_RESULTS = 40;

/* -------------------------------------------------------------------------- */
/* Cliente                                                                     */
/* -------------------------------------------------------------------------- */

interface CustomerPickerProps {
  customers: CustomerRecord[];
  selected: CustomerRecord | null;
  /** `null` clears the choice and puts the list back. */
  onSelect: (customer: CustomerRecord | null) => void;
  /**
   * An id for whichever control is on screen — the search box, or "Cambiar"
   * once someone is chosen — so a form that validates by focusing a field by
   * id can bring the user straight back here. See receiptBlocker.ts.
   */
  inputId?: string;
  /** Marks the search box invalid, for a form that refused to save without it. */
  invalid?: boolean;
}

export function CustomerPicker({
  customers,
  selected,
  onSelect,
  inputId,
  invalid,
}: CustomerPickerProps) {
  // Kept when a choice is made rather than cleared, so pressing "Cambiar"
  // returns you to the list you were looking at instead of to the top of nine
  // hundred names.
  const [search, setSearch] = useState("");

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();

    // Identity number and phone are in the haystack because that is how staff
    // actually disambiguate: two people are called José Martínez, and only one
    // of them is 0801-1990-04412.
    const pool =
      needle === ""
        ? customers
        : customers.filter((customer) =>
            `${customer.fullName} ${customer.identification ?? ""} ${customer.phone ?? ""}`
              .toLowerCase()
              .includes(needle),
          );

    return [...pool].sort((a, b) => a.fullName.localeCompare(b.fullName, "en"));
  }, [customers, search]);

  if (selected) {
    return (
      <div className="picker-chosen">
        <span className="holder-avatar">{getInitials(selected.fullName)}</span>
        <span className="holder-text">
          <span className="holder-name">{selected.fullName}</span>
          <span className="holder-contract">{customerLine(selected)}</span>
        </span>
        <button id={inputId} type="button" className="link-btn" onClick={() => onSelect(null)}>
          Change
        </button>
      </div>
    );
  }

  if (customers.length === 0) {
    return (
      <p className="picker-empty">
        No customers yet. Add the person on the Customers screen first: a contract belongs to
        someone, and that person must exist before the contract can be created.
      </p>
    );
  }

  return (
    <div className="picker">
      <div className="picker-search">
        <IconSearch />
        <input
          id={inputId}
          type="search"
          aria-invalid={invalid}
          value={search}
          placeholder="Search by name, ID number, or phone…"
          aria-label="Search customers"
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="picker-list" role="listbox" aria-label="Customers">
        {matches.length === 0 && (
          <p className="picker-empty">No customers match “{search.trim()}”.</p>
        )}

        {matches.slice(0, MAX_RESULTS).map((customer) => (
          <button
            key={customer.id}
            type="button"
            role="option"
            aria-selected={false}
            className="picker-option"
            onClick={() => onSelect(customer)}
          >
            <span className="holder-avatar">{getInitials(customer.fullName)}</span>
            <span className="holder-text">
              <span className="holder-name">{customer.fullName}</span>
              <span className="holder-contract">{customerLine(customer)}</span>
            </span>
            {/* What they are already holding. A person with two live contracts
                is very often here to buy the lot next to them, and that is
                exactly the case where the purchase should be grouped. */}
            {customer.contracts.length > 0 && (
              <span className="picker-tag">
                {customer.contracts.length} active contract
                {customer.contracts.length === 1 ? "" : "s"}
              </span>
            )}
          </button>
        ))}

        {matches.length > MAX_RESULTS && (
          <p className="picker-more">
            {matches.length - MAX_RESULTS} more. Type a little more to find them.
          </p>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Lote                                                                        */
/* -------------------------------------------------------------------------- */

interface LotPickerProps {
  /** Every lot. The filtering to what is actually sellable happens here. */
  lots: Lot[];
  unitByProject: Map<string, AreaUnit>;
  money: MoneyView;
  selected: Lot | null;
  onSelect: (lot: Lot | null) => void;
}

export function LotPicker({ lots, unitByProject, money, selected, onSelect }: LotPickerProps) {
  const [search, setSearch] = useState("");

  // Only what can actually be sold. A lot that is archived is not inventory,
  // and a lot with an active contract against it belongs to somebody — the
  // server refuses either one, and offering them here would turn a rule into a
  // rejected save the user has to work backwards from.
  const available = useMemo(
    () => lots.filter((lot) => lot.archivedAt === null && lot.holding === null),
    [lots],
  );

  // Grouped by project, because a lot number only means something inside one:
  // "A-07" exists in every project, and a flat list of them is unreadable.
  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const pool =
      needle === ""
        ? available
        : available.filter((lot) =>
            `${lot.code} ${lot.projectName}`.toLowerCase().includes(needle),
          );

    const byProject = new Map<string, Lot[]>();

    for (const lot of pool) {
      const bucket = byProject.get(lot.projectName);
      if (bucket) {
        bucket.push(lot);
      } else {
        byProject.set(lot.projectName, [lot]);
      }
    }

    return [...byProject.entries()]
      .map(([projectName, projectLots]) => ({
        projectName,
        lots: [...projectLots].sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true })),
      }))
      .sort((a, b) => a.projectName.localeCompare(b.projectName, "en"));
  }, [available, search]);

  const shown = groups.reduce((total, group) => total + group.lots.length, 0);

  if (selected) {
    const unit = unitByProject.get(selected.projectName) ?? "m2";

    return (
      <div className="picker-chosen">
        <span className="code-badge">{selected.code}</span>
        <span className="holder-text">
          <span className="holder-name">{selected.projectName}</span>
          <span className="holder-contract">
            {formatArea(selected.areaM2, unit)} · list price {formatMoney(selected.basePrice, money)}
          </span>
        </span>
        <button type="button" className="link-btn" onClick={() => onSelect(null)}>
          Change
        </button>
      </div>
    );
  }

  if (available.length === 0) {
    return (
      <p className="picker-empty">
        No lots are available. All active lots already have a contract or reservation.
      </p>
    );
  }

  return (
    <div className="picker">
      <div className="picker-search">
        <IconSearch />
        <input
          type="search"
          value={search}
          placeholder="Search by lot number or project…"
          aria-label="Search lots"
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="picker-list" role="listbox" aria-label="Available lots">
        {shown === 0 && (
          <p className="picker-empty">No available lots match “{search.trim()}”.</p>
        )}

        {groups.map((group) => {
          const unit = unitByProject.get(group.projectName) ?? "m2";

          return (
            <div key={group.projectName} className="picker-group">
              <p className="picker-group-label">
                {group.projectName}
                <span>
                  {group.lots.length} available
                </span>
              </p>

              {group.lots.map((lot) => (
                <button
                  key={lot.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="picker-option"
                  onClick={() => onSelect(lot)}
                >
                  <span className="code-badge">{lot.code}</span>
                  <span className="holder-text">
                    <span className="holder-contract">{formatArea(lot.areaM2, unit)}</span>
                  </span>
                  {/* The list price, not the sale price. It is what the next
                      step starts the negotiation from, so seeing it here is
                      what makes picking the right lot possible. */}
                  <span className="picker-price">{formatMoney(lot.basePrice, money)}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
