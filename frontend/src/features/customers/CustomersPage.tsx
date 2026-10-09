import { useMemo } from "react";
import { useRememberedState } from "../../lib/viewMemory";

import { IconEdit, IconTrash } from "../../components/Icons";
import { hasIdentification } from "../../lib/identification";
import { getInitials } from "../../lib/initials";
import { formatPhone } from "../../lib/phone";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import { buildProjectAccents } from "../../lib/projectAccent";
import type { CustomerRecord } from "../../types";
import { filterCustomers, hasActiveFilters, NO_CUSTOMER_FILTERS } from "./customerFilters";
import type { CustomerFilters } from "./customerFilters";
import { DEFAULT_SORT, sortCustomers } from "./customerSort";
import type { CustomerSort } from "./customerSort";
import { CustomerToolbar } from "./CustomerToolbar";

interface CustomersPageProps {
  customers: CustomerRecord[];
  user: User;
  onEditCustomer: (customer: CustomerRecord) => void;
  onDeleteCustomer: (customer: CustomerRecord) => void;
}

/**
 * Everything about one customer that somebody might type into the search box.
 *
 * Contract and lot numbers are in here deliberately: "who is CT-2026-014?" is
 * asked as often as "what does José have?", and both should land on the same
 * row rather than sending the user to a different screen to translate first.
 */
function haystack(customer: CustomerRecord): string {
  return [
    customer.fullName,
    customer.identification ?? "",
    customer.phone ?? "",
    customer.phone ? formatPhone(customer.phone) : "",
    customer.email ?? "",
    customer.address ?? "",
    customer.notes ?? "",
    ...customer.contracts.flatMap((contract) => [
      contract.contractCode,
      contract.lotCode,
      contract.projectName,
    ]),
  ]
    .join(" ")
    .toLowerCase();
}

/** The rows left after the search box, before the filter panel has its say. */
function searchCustomers(customers: CustomerRecord[], search: string): CustomerRecord[] {
  const query = search.trim().toLowerCase();

  if (query === "") {
    return customers;
  }

  // Every word has to match something, so "jose valle" narrows rather than
  // widening — which is how people expect a search box to behave.
  const words = query.split(/\s+/);

  return customers.filter((customer) => {
    const text = haystack(customer);
    return words.every((word) => text.includes(word));
  });
}

export function CustomersPage({
  customers,
  user,
  onEditCustomer,
  onDeleteCustomer,
}: CustomersPageProps) {
  // Which buttons to render. The server re-checks the same capabilities on
  // every write — hiding a button is convenience, not protection.
  const canEdit = can(user, "customer:edit");
  const canDelete = can(user, "customer:delete");
  const showActions = canEdit || canDelete;

  const [search, setSearch] = useRememberedState("customers.search", "");
  const [filters, setFilters] = useRememberedState<CustomerFilters>(
    "customers.filters",
    NO_CUSTOMER_FILTERS,
  );
  const [sort, setSort] = useRememberedState<CustomerSort>("customers.sort", DEFAULT_SORT);

  // Derived from state, recalculated when something it depends on changes.
  // There is no second copy of the list to keep in sync: search, filter and
  // sort are a VIEW of `customers`, exactly as on the Lotes screen.
  const visible = useMemo(
    () => sortCustomers(filterCustomers(searchCustomers(customers, search), filters), sort),
    [customers, search, filters, sort],
  );

  // Offered in the filter panel, built from the contracts people actually hold
  // so a project nobody has bought into never appears as an option that matches
  // nothing.
  const projectNames = useMemo(
    () =>
      [
        ...new Set(
          customers.flatMap((customer) =>
            customer.contracts.map((contract) => contract.projectName),
          ),
        ),
      ].sort((a, b) => a.localeCompare(b, "en")),
    [customers],
  );

  // Projects keep the same colour they have on the Lotes screen, built from the
  // full list so it does not shift as the search narrows.
  const projectAccents = useMemo(() => buildProjectAccents(projectNames), [projectNames]);

  const isNarrowed = search.trim() !== "" || hasActiveFilters(filters);

  return (
    <section className="panel active">
      <CustomerToolbar
        projectNames={projectNames}
        filters={filters}
        onFiltersChange={setFilters}
        sort={sort}
        onSortChange={setSort}
        search={search}
        onSearchChange={setSearch}
        shownCount={visible.length}
        totalCount={customers.length}
      />

      <div className="card">
        <div className="table-wrap">
          <table className="customers-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Phone</th>
                <th>ID number</th>
                <th>Contracts</th>
                <th className="col-notes">Notes</th>
                <th className="col-actions">{showActions ? "Actions" : ""}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((customer) => (
                <tr key={customer.id}>
                  <td>
                    <span className="holder-btn is-static">
                      <span className="holder-avatar">{getInitials(customer.fullName)}</span>
                      <span className="holder-text">
                        <span className="holder-name">{customer.fullName}</span>
                        <span className="holder-contract">
                          Customer since {customer.customerSince}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td className="mono">
                    {customer.phone ? (
                      formatPhone(customer.phone)
                    ) : (
                      /* Not blank. An empty cell in a column of numbers reads
                         as data that failed to load rather than a customer who
                         never gave one. */
                      <span className="holder-empty">No phone</span>
                    )}
                  </td>
                  <td className="mono">
                    {hasIdentification(customer.identification) ? (
                      customer.identification
                    ) : (
                      /* Not blank. An empty cell in a column of numbers reads
                         as data that failed to load rather than a customer who
                         never gave one. */
                      <span className="holder-empty">No ID number</span>
                    )}
                  </td>
                  <td>
                    {/* Read from the contracts themselves on every load. There
                        is no "número de contratos" stored on a customer. */}
                    {customer.contracts.length === 0 ? (
                      <span className="holder-empty">No active contract</span>
                    ) : (
                      <span className="contract-list">
                        {customer.contracts.map((contract) => (
                          <span key={contract.contractId} className="contract-line">
                            <span className="code-badge">{contract.contractCode}</span>
                            <span
                              className={`cell-project ${
                                projectAccents.get(contract.projectName) ?? ""
                              }`}
                            >
                              <span className="project-dot" />
                              {contract.lotCode} · {contract.projectName}
                            </span>
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="col-notes">
                    {customer.notes ? (
                      // Nothing is hidden here any more: the note wraps onto as
                      // many lines as it needs, so the column reads the way the
                      // edit form does. The row is allowed to grow with it —
                      // this is the column somebody opens the screen for.
                      <span className="cell-notes">{customer.notes}</span>
                    ) : (
                      <span className="holder-empty">—</span>
                    )}
                  </td>
                  <td>
                    {showActions ? (
                      <span className="row-actions">
                        {canEdit && (
                          <button
                            type="button"
                            className="row-action"
                            onClick={() => onEditCustomer(customer)}
                            title={`Edit ${customer.fullName}`}
                            aria-label={`Edit ${customer.fullName}`}
                          >
                            <IconEdit />
                          </button>
                        )}
                        {canDelete && (
                          // Shown even for somebody holding a contract: the
                          // dialog is where the refusal is explained, and a
                          // button that quietly vanishes teaches nobody why.
                          <button
                            type="button"
                            className="row-action danger"
                            onClick={() => onDeleteCustomer(customer)}
                            title={`Delete ${customer.fullName}`}
                            aria-label={`Delete ${customer.fullName}`}
                          >
                            <IconTrash />
                          </button>
                        )}
                      </span>
                    ) : (
                      <span className="row-actions-locked" title="Requires permission">
                        —
                      </span>
                    )}
                  </td>
                </tr>
              ))}

              {visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="table-empty">
                    {customers.length === 0 ? (
                      "No customers have been added yet."
                    ) : (
                      <>
                        <p>
                          {search.trim() === ""
                            ? "No customers match your search."
                            : `No customers match “${search.trim()}”.`}
                        </p>
                        {/* An empty table is where a forgotten filter finally
                            shows itself, so the way out is offered right here
                            instead of leaving the user hunting for it. */}
                        {isNarrowed && (
                          <button
                            type="button"
                            className="link-btn"
                            onClick={() => {
                              setSearch("");
                              setFilters(NO_CUSTOMER_FILTERS);
                            }}
                          >
                            {search.trim() === ""
                              ? "Clear filters"
                              : hasActiveFilters(filters)
                                ? "Clear search and filters"
                                : "Clear search"}
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
    </section>
  );
}
