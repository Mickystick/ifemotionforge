import type { ReactNode } from "react";
import { useRememberedState } from "../../lib/viewMemory";
import { Fragment, useEffect, useMemo, useState } from "react";

import { IconChevronDown, IconDrag, IconEye, IconEyeOff } from "../../components/Icons";
import { getInitials } from "../../lib/initials";
import type { Cents, MoneyView } from "../../lib/money";
import { formatMoney, formatMoneyParts } from "../../lib/money";
import { buildProjectAccents } from "../../lib/projectAccent";
import { HEALTH_PRESENTATION } from "../contracts/contractPresentation";
import { BEHIND_HEALTH } from "../contracts/contractFilters";
import type { ContractFilterPreset } from "../contracts/contractFilters";
import type { Dashboard, Debtor, MonthPayment, SignedContract } from "./api";
import { resetDashboardLayout, saveDashboardLayout } from "./api";
import { MonthlyBars } from "./MonthlyBars";
import type { DashboardLayout, SectionId } from "./dashboardSections";
import {
  SECTION_LABELS,
  dropSection,
  isDefaultLayout,
  moveSection,
  resolveLayout,
} from "./dashboardSections";
import {
  PAYMENT_METHOD_LABELS,
  collectionRate,
  compareToPrevious,
  describeComparison,
  describeExpiry,
  formatDate,
  formatMonth,
  formatMonthName,
  groupPayers,
  pluralise,
  shortDay,
} from "./dashboardPresentation";

/**
 * The DOM id a band is reachable at, for the tiles that scroll to one.
 *
 * A band only has one while it is actually on the page: hidden bands render
 * nothing, and the editor wraps each band in a frame of its own. Both cases are
 * handled by `revealBand` below rather than by hoping the element is there.
 */
function bandDomId(id: SectionId): string {
  return `dash-band-${id}`;
}

/**
 * Bring a band into view and mark it, or report that it could not be.
 *
 * The mark matters more than the scroll. Landing somewhere new mid-page with no
 * indication of why is disorienting — the reader clicked a figure and the page
 * moved — so the band it lands on flashes to say "this is the one you asked
 * for". `false` means the band is hidden or being rearranged, which is a real
 * answer the caller has to handle: it falls back to leaving for Contratos.
 */
function revealBand(id: SectionId): boolean {
  const element = document.getElementById(bandDomId(id));

  if (!element) {
    return false;
  }

  // `smooth` here and nowhere else in the app, because this is the one movement
  // the reader did not ask for by scrolling: the animation is what tells them
  // the page moved rather than jumped to a different screen.
  element.scrollIntoView({ behavior: "smooth", block: "start" });

  element.classList.remove("is-revealed");
  // Forcing a reflow between the two lines restarts the animation when the same
  // band is asked for twice; without it the second click does nothing visible.
  void element.offsetWidth;
  element.classList.add("is-revealed");

  window.setTimeout(() => element.classList.remove("is-revealed"), 1600);

  return true;
}

interface DashboardPageProps {
  data: Dashboard;
  money: MoneyView;
  /** Reports a different month. `undefined` means "whatever month it is now". */
  onSelectMonth: (month: string | undefined) => void;
  /**
   * Opens one contract's detail panel, by id.
   *
   * By id rather than by object because this screen never holds a `Contract` —
   * it holds the dashboard's own summary rows. App owns the contracts list and
   * does the lookup, which also means a row for a contract that has since been
   * archived opens nothing instead of opening something stale.
   */
  onOpenContract: (contractId: string) => void;
  /**
   * Leaves for Contratos with the filters already applied.
   *
   * The only drill-down that leaves this screen. It is used where the complete
   * answer is a list too long to belong on a summary — every overdue contract —
   * and never where the answer fits in a panel, because a redirect costs the
   * reader the month they had selected here.
   */
  onShowContracts: (preset: ContractFilterPreset) => void;
}

/**
 * The Panel General.
 *
 * Every other screen in Lindero answers a question about one ROW — this
 * contract, this customer, this lot. This one exists for the questions that
 * need every row at once, or the same row at two points in time, and it is
 * deliberately limited to those. A contract's progress is on the Contratos tab
 * and is not repeated here; what is here instead is what that tab cannot say:
 * whether September beat August, who stopped paying since last month, and what
 * falls due in February.
 *
 * Almost every figure is a link into the screen that can act on it. A number
 * nobody can follow anywhere is decoration.
 */
export function DashboardPage({
  data,
  money,
  onSelectMonth,
  onOpenContract,
  onShowContracts,
}: DashboardPageProps) {
  const { income, collections, upcoming } = data;
  const rate = collectionRate(income.collectedCents, income.expectedCents);
  const collectedDelta = compareToPrevious(income.collectedCents, income.previousToDateCents);
  const payersDelta = compareToPrevious(income.payingCustomers, income.previousPayingCustomers);
  // Both deltas above compare the same span of both months, so this one
  // sentence describes either of them.
  const comparison = describeComparison(data.previousMonth, income.comparisonDays);

  // Projects keep the colour they have on Lotes, Clientes and Contratos.
  const accents = buildProjectAccents(data.projects.map((project) => project.projectName));

  /*
   * How many contracts are actually behind — the real total the worklist shows
   * the top twelve of.
   *
   * Summed from the buckets rather than from `worklist.length`, which is capped
   * and would report "12 de 12" on a book with fifty overdue contracts. The
   * buckets are the counters the server states in full, exactly so this figure
   * has somewhere honest to come from.
   */
  const behindTotal = collections.buckets
    .filter((bucket) => BEHIND_HEALTH.includes(bucket.status))
    .reduce((total, bucket) => total + bucket.contracts, 0);

  /* ---------------------------------------------------------------------- */
  /* Arranging the screen                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * The arrangement being rendered, and — while the editor is open — the one
   * being worked on.
   *
   * Kept apart on purpose. The draft is what the reader is dragging around, so
   * Cancelar has something to throw away and a background refresh has something
   * it is not allowed to touch.
   */
  /**
   * Which of the two headline figures is currently opened up, if either.
   *
   * One at a time: both panels list the same month from different angles, and
   * two long tables stacked above the rest of the screen pushes everything
   * below them off the page on a phone.
   *
   * Reset when the month changes, further down — a panel left open across a
   * month change would silently be showing a different month's rows under a
   * tile the reader is no longer looking at.
   */
  const [openTile, setOpenTile] = useRememberedState<"payers" | "signed" | null>(
    "dashboard.openTile",
    null,
  );

  /** Which project's payments are open, by id. `null` for none. */
  const [openProject, setOpenProject] = useRememberedState<string | null>(
    "dashboard.openProject",
    null,
  );

  const [layout, setLayout] = useState<DashboardLayout>(() => resolveLayout(data.layout));
  const [draft, setDraft] = useState<DashboardLayout | null>(null);
  const [dragging, setDragging] = useState<SectionId | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Adopt an arrangement saved somewhere else — another tab, or this account
   * signing in on a second machine.
   *
   * Keyed on the CONTENT rather than on `data.layout` itself, which is a fresh
   * object out of JSON.parse on every poll: depending on its identity would
   * reset the arrangement every few seconds, and the state below would fight
   * the live-update refresh forever. The draft is deliberately not touched — a
   * refresh landing mid-edit must not throw away what somebody is doing.
   */
  const storedLayout = JSON.stringify(data.layout);

  useEffect(() => {
    setLayout(resolveLayout(JSON.parse(storedLayout) as DashboardLayout | null));
  }, [storedLayout]);

  /*
   * A different month is a different set of rows, so nothing that was opened
   * against the old one stays open. Keyed on the month rather than on the data
   * object, which is replaced on every live refresh — closing these panels
   * every few seconds would make them unusable.
   *
   * Only on an actual CHANGE of month, not on arrival: the panels are
   * remembered across a tab change (see `viewMemory`), and an effect that also
   * ran on mount would close them every time somebody came back. The month is
   * remembered with them, so one changed while this screen was away still
   * counts as a change.
   */
  const [panelsMonth, setPanelsMonth] = useRememberedState("dashboard.panelsMonth", data.month);

  useEffect(() => {
    if (data.month === panelsMonth) {
      return;
    }

    setOpenTile(null);
    setOpenProject(null);
    setPanelsMonth(data.month);
  }, [data.month, panelsMonth, setOpenTile, setOpenProject, setPanelsMonth]);

  const visible = draft ?? layout;
  const hiddenIds = useMemo(() => new Set(visible.hidden), [visible.hidden]);

  const save = async () => {
    if (!draft) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await saveDashboardLayout(draft);
      setLayout(draft);
      setDraft(null);
    } catch (caught) {
      // The arrangement stays on screen and the editor stays open, so nothing
      // somebody just spent a minute on is lost to a dropped connection.
      setError(caught instanceof Error ? caught.message : "Could not save the layout.");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setError(null);

    try {
      await resetDashboardLayout();
      setLayout(resolveLayout(null));
      setDraft(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not restore the layout.");
    } finally {
      setSaving(false);
    }
  };

  /** The money cell used down the tables: tinted symbol, full-strength digits. */
  const moneyCell = (amount: Cents, className = "") => {
    const parts = formatMoneyParts(amount, money);

    return (
      <span className={`cell-money ${className}`}>
        <span className="currency-symbol">{parts.symbol}</span>
        {parts.value}
      </span>
    );
  };

  const sections: Record<SectionId, ReactNode> = {
    income: (
        <div className="dash-headline">
          <div className="card dash-hero">
            <p className="dash-hero-label">Collected in {formatMonthName(data.month)}</p>
            <p className="dash-hero-value">{formatMoney(income.collectedCents, money)}</p>

            <p className="dash-hero-meta">
              <span className={`dash-delta is-${collectedDelta.tone}`}>{collectedDelta.label}</span>
              <span>{comparison}</span>
            </p>

            {/*
              The figure that turns the number above into a judgement. A month
              that collected less than the last one may simply have had fewer
              cuotas falling due; only the rate can tell the two apart.
            */}
            {rate === null ? (
              <p className="dash-hero-rate is-quiet">
                No installments were scheduled for {formatMonthName(data.month)}.
              </p>
            ) : (
              <div className="dash-hero-rate">
                <div className="dash-meter" role="presentation">
                  <span className={meterClass(rate)} style={{ width: `${Math.min(100, rate)}%` }} />
                </div>
                <p>
                  <strong>{rate}%</strong> of the {formatMoney(income.expectedCents, money)}{" "}
                  scheduled for the month
                </p>
              </div>
            )}
          </div>

          <div className="dash-tiles">
            <StatTile
              label={data.isCurrentMonth ? "Due this month" : "Still due"}
              value={formatMoney(income.stillDueCents, money)}
              detail={
                income.stillDueContracts === 0
                  ? "All up to date"
                  : `${pluralise(
                      income.stillDueContracts,
                      "contract",
                      "contracts",
                    )} with a balance due this month`
              }
              tone={income.stillDueCents > 0 ? "warn" : "good"}
              action={
                income.stillDueContracts === 0
                  ? undefined
                  : {
                      /*
                       * To the Cobranza band, NOT to the overdue list.
                       *
                       * This figure counts every live contract whose scheduled
                       * total for the month has not fully arrived — which
                       * includes the ones inside the five-day grace, and those
                       * are deliberately not "atrasados". Sending the reader
                       * straight to a filtered Contratos would answer with a
                       * smaller number than the tile they just pressed and look
                       * like rows had gone missing. The Cobranza band is where
                       * that population is split into its buckets, so it is the
                       * honest destination; the complete overdue list is one
                       * more click from there, correctly labelled.
                       */
                      onClick: () => {
                        if (!revealBand("collections")) {
                          onShowContracts({ health: BEHIND_HEALTH });
                        }
                      },
                      hint: "View collection breakdown",
                    }
              }
            />

            <StatTile
              label="Customers who paid"
              value={String(income.payingCustomers)}
              detail={`${payersDelta.label} ${comparison}`}
              action={
                income.payingCustomers === 0
                  ? undefined
                  : {
                      onClick: () => setOpenTile((current) => (current === "payers" ? null : "payers")),
                      hint: "View customers who paid",
                      isOpen: openTile === "payers",
                    }
              }
            />

            <StatTile
              label="New contracts"
              value={String(income.signedCount)}
              detail={
                income.signedCount === 0
                  ? "None signed"
                  : `${formatMoney(income.signedValueCents, money)} in sales`
              }
              action={
                income.signedCount === 0
                  ? undefined
                  : {
                      onClick: () => setOpenTile((current) => (current === "signed" ? null : "signed")),
                      hint: "View signed contracts",
                      isOpen: openTile === "signed",
                    }
              }
            />
          </div>

          {openTile === "payers" && (
            <PayersPanel
              payments={income.payments}
              money={money}
              monthName={formatMonthName(data.month)}
              onOpenContract={onOpenContract}
              onClose={() => setOpenTile(null)}
            />
          )}

          {openTile === "signed" && (
            <SignedPanel
              signed={income.signed}
              money={money}
              monthName={formatMonthName(data.month)}
              onOpenContract={onOpenContract}
              onClose={() => setOpenTile(null)}
            />
          )}
        </div>
    ),

    history: (
        <div className="card dash-card">
          <div className="card-head">
            <h3>Monthly collections</h3>
            <span className="tag">last 12 months</span>
          </div>

          <div className="dash-card-body">
            <MonthlyBars
              columns={data.history.map((row) => ({
                month: row.month,
                valueCents: row.collectedCents,
                targetCents: row.expectedCents,
              }))}
              money={money}
              valueLabel="Collected"
              targetLabel="Scheduled"
              selectedMonth={data.month}
              onSelectMonth={onSelectMonth}
              tableCaption="Collected and scheduled by month, last 12 months."
            />
            <p className="dash-note">
              Select a month to view the full dashboard for that period. A payment's month is when
              the money was received, not when it was recorded.
            </p>
          </div>
        </div>
    ),

    composition: (
        <div className="card dash-card">
          <div className="card-head">
            <h3>Where the money came from</h3>
            <span className="tag">{formatMonthName(data.month)}</span>
          </div>

          <div className="dash-card-body dash-splits">
            {/*
              A month carried by one large prima is not a month that repeats, and
              the headline figure cannot say so. This is the split that separates
              income that comes back next month from income that does not.
            */}
            <Split
              title="By type"
              money={money}
              total={income.collectedCents}
              rows={[
                { label: "Installments", amount: income.byType.installment },
                { label: "Down payments", amount: income.byType.downPayment },
                { label: "Full payments", amount: income.byType.fullPayment },
                { label: "Adjustments", amount: income.byType.adjustment },
              ]}
            />
            <Split
              title="By payment method"
              money={money}
              total={income.collectedCents}
              rows={[
                { label: "Cash", amount: income.byMethod.cash },
                { label: "Bank transfer", amount: income.byMethod.transfer },
                { label: "Card", amount: income.byMethod.card },
              ]}
            />
          </div>
        </div>
    ),

    collections: (
        <div className="card dash-card">
          <div className="card-head">
            <h3>Collections</h3>
            <span className="tag">
              al {formatDate(data.asOf)}
              {collections.settledContracts > 0 &&
                ` · ${pluralise(
                  collections.settledContracts,
                  "contract paid",
                  "contracts paid",
                )}`}
            </span>
          </div>

          <div className="dash-card-body">
            <div className="dash-buckets">
              {collections.buckets.map((bucket) => {
                const presentation = HEALTH_PRESENTATION[bucket.status];

                return (
                  <div key={bucket.status} className="dash-bucket" title={presentation.hint}>
                    {/* The label is always present, so these four are never told
                        apart by their colour alone. */}
                    <span className={presentation.stampClass}>{presentation.label}</span>
                    <p className="dash-bucket-count">{bucket.contracts}</p>
                    <p className="dash-bucket-detail">
                      {pluralise(bucket.customers, "customer", "customers")}
                    </p>
                    <p className="dash-bucket-money">
                      {bucket.arrearsCents > 0
                        ? `${formatMoney(bucket.arrearsCents, money)} overdue`
                        : `${formatMoney(bucket.balanceCents, money)} due`}
                    </p>
                  </div>
                );
              })}
            </div>

            <ChangeLists collections={collections} month={data.month} />
          </div>
        </div>
    ),

    worklist: (
        <div className="card dash-card">
          <div className="card-head">
            <h3>Who to call first</h3>
            {/*
              The count says out loud that this is a RANKING and not a census.
              The list is capped at twelve by the server; a heading that read
              "Morosos" over twelve rows of a book with forty-seven overdue
              contracts would be a false statement about the business, and the
              reader has no way to tell from the card that anything is missing.
              Saying "12 de 47" makes the cap visible, and the link in the
              footer is where the other thirty-five live.
            */}
            <span className="tag">
              {behindTotal > collections.worklist.length
                ? `${collections.worklist.length} of ${behindTotal} · by overdue amount`
                : "by overdue amount"}
            </span>
          </div>

          {collections.worklist.length === 0 ? (
            <p className="state-message">No one is overdue. All accounts are up to date.</p>
          ) : (
            <div className="table-wrap">
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Lot</th>
                    <th className="col-money">Overdue</th>
                    <th className="col-money">Balance</th>
                    <th>Last payment</th>
                  </tr>
                </thead>
                <tbody>
                  {collections.worklist.map((debtor) => (
                    <tr
                      key={debtor.contractId}
                      className="is-clickable"
                      onClick={() => onOpenContract(debtor.contractId)}
                    >
                      <td>
                        <DebtorName debtor={debtor} onOpen={() => onOpenContract(debtor.contractId)} />
                      </td>
                      <td>
                        <span className="contract-lot">
                          <span className="code-badge">{debtor.lotCode}</span>
                          <span
                            className={`cell-project cell-sub ${
                              accents.get(debtor.projectName) ?? ""
                            }`}
                          >
                            <span className="project-dot" />
                            {debtor.projectName}
                          </span>
                        </span>
                      </td>
                      <td className="col-money">
                        {moneyCell(debtor.arrearsCents, "is-balance")}
                        <span className="cell-sub">
                          {pluralise(debtor.monthsBehind, "month", "months")}
                        </span>
                      </td>
                      <td className="col-money">{moneyCell(debtor.balanceCents)}</td>
                      <td>
                        {/* The most useful column on a list of debtors: somebody
                            who paid last week forgot, somebody last seen in March
                            has stopped. */}
                        <span className="cell-sub">{formatDate(debtor.lastPaymentOn)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/*
                The complete list, on the screen that can act on it. This is the
                one drill-down that leaves the Panel General, and it does so
                because the answer is genuinely a working list of every overdue
                contract — sortable, filterable, with the contact buttons beside
                each row — which is what the Contratos tab already is.
              */}
              <button
                type="button"
                className="dash-drill-link"
                onClick={() => onShowContracts({ health: BEHIND_HEALTH })}
              >
                View {behindTotal === 1 ? "the overdue contract" : `all ${behindTotal} overdue contracts`} in
                Contracts
              </button>
            </div>
          )}
        </div>
    ),

    projects: (
        <div className="card dash-card">
          <div className="card-head">
            <h3>By project</h3>
            <span className="tag">{formatMonthName(data.month)}</span>
          </div>

          {data.projects.length === 0 ? (
            <p className="state-message">There are no contracts in any project yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th className="col-money">Collected</th>
                    <th className="col-money">Due</th>
                    <th>Portfolio</th>
                    <th>Inventory</th>
                  </tr>
                </thead>
                <tbody>
                  {data.projects.map((project) => {
                    const delta = compareToPrevious(
                      project.collectedCents,
                      project.previousToDateCents,
                    );

                    const isOpen = openProject === project.projectId;
                    const projectPayments = isOpen
                      ? income.payments.filter((row) => row.projectId === project.projectId)
                      : [];

                    return (
                      <Fragment key={project.projectId}>
                      <tr
                        className={`is-clickable${isOpen ? " is-open" : ""}`}
                        onClick={() =>
                          setOpenProject((current) =>
                            current === project.projectId ? null : project.projectId,
                          )
                        }
                        aria-expanded={isOpen}
                      >
                        <td>
                          <span className={`cell-project ${accents.get(project.projectName) ?? ""}`}>
                            <span className={`dash-row-caret${isOpen ? " is-open" : ""}`}>
                              <IconChevronDown />
                            </span>
                            <span className="project-dot" />
                            {project.projectName}
                          </span>
                        </td>
                        <td className="col-money">
                          {moneyCell(project.collectedCents)}
                          <span className={`cell-sub dash-delta is-${delta.tone}`}>
                            {delta.label}
                          </span>
                        </td>
                        <td className="col-money">
                          {moneyCell(project.outstandingCents, "is-balance")}
                          {project.arrearsCents > 0 && (
                            <span className="cell-sub warn">
                              {formatMoney(project.arrearsCents, money)} overdue
                            </span>
                          )}
                        </td>
                        <td>
                          {pluralise(project.activeContracts, "contract", "contracts")}
                          {project.behindContracts > 0 && (
                            <span className="cell-sub warn">
                              {project.behindContracts} overdue
                            </span>
                          )}
                        </td>
                        <td>
                          {project.lotsAvailable} of {project.lotsTotal} available
                          {/*
                            The one thing the Proyectos tab deliberately does not
                            show: not what is left, but how long it lasts at the
                            rate this project has actually been selling.
                          */}
                          <span className="cell-sub">
                            {project.monthsOfStock === null
                              ? project.lotsAvailable === 0
                                ? "no lots available"
                                : "no recent sales"
                              : `~${pluralise(project.monthsOfStock, "month", "months")} of inventory`}
                          </span>
                        </td>
                      </tr>

                      {/*
                        Where the "Cobrado" figure beside it came from, and from
                        whom. Filtered out of the same `income.payments` array
                        the project totals were summed from, so the rows below
                        add up to the row above by construction rather than by
                        two queries happening to agree.
                      */}
                      {isOpen && (
                        <tr className="dash-subrow">
                          <td colSpan={5}>
                            {projectPayments.length === 0 ? (
                              <p className="state-message">
                                No payments recorded in {formatMonthName(data.month)} for{" "}
                                {project.projectName}.
                              </p>
                            ) : (
                              <table className="dash-table is-nested">
                                <thead>
                                  <tr>
                                    <th>Customer</th>
                                    <th>Lot</th>
                                    <th>Date</th>
                                    <th>Method</th>
                                    <th className="col-money">Amount</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {projectPayments.map((row) => (
                                    <tr
                                      key={row.id}
                                      className="is-clickable"
                                      onClick={() => onOpenContract(row.contractId)}
                                    >
                                      <td>
                                        <span className="holder-text">
                                          <span className="holder-name">{row.customerName}</span>
                                          <span className="holder-contract">
                                            {row.contractCode}
                                          </span>
                                        </span>
                                      </td>
                                      <td>
                                        <span className="code-badge">{row.lotCode}</span>
                                      </td>
                                      <td>
                                        <span className="cell-sub">{shortDay(row.paidOn)}</span>
                                      </td>
                                      <td>
                                        <span className="cell-sub">
                                          {PAYMENT_METHOD_LABELS[row.method] ?? row.method}
                                        </span>
                                      </td>
                                      <td className="col-money">
                                        <span className="cell-money">
                                          {formatMoney(row.amountCents, money)}
                                        </span>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                                <tfoot>
                                  <tr>
                                    <th scope="row" colSpan={4}>
                                      {pluralise(projectPayments.length, "payment", "payments")}
                                    </th>
                                    <td className="col-money">
                                      <span className="cell-money">
                                        {formatMoney(project.collectedCents, money)}
                                      </span>
                                    </td>
                                  </tr>
                                </tfoot>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
    ),

    projection: (
        <div className="card dash-card">
          <div className="card-head">
            <h3>Coming up</h3>
            <span className="tag">next 6 months</span>
          </div>

          <div className="dash-card-body">
            <MonthlyBars
              columns={upcoming.projection.map((row) => ({
                month: row.month,
                valueCents: row.expectedCents,
              }))}
              money={money}
              valueLabel="Scheduled"
              tableCaption="Installments scheduled per month for the next six months."
            />
            <p className="dash-note">
              What the signed installment schedules would bring in if everyone paid. A downward
              step means a group of contracts ends: less money comes in that month even if no one
              falls behind.
            </p>
          </div>
        </div>
    ),

    attention: (
        <div className="dash-attention">
          <AttentionCard
            title="Reservations expiring soon"
            tag="next 30 days"
            empty="No reservations are expiring soon."
            items={upcoming.expiringReservations.map((row) => ({
              key: row.contractId,
              code: row.contractCode,
              title: row.customerName,
              detail: `${row.lotCode} · ${row.projectName}`,
              note: describeExpiry(row.expiresOn, data.asOf),
              isUrgent: row.expiresOn <= data.asOf,
            }))}
          />

          <AttentionCard
            title="Contracts nearing completion"
            tag="3 installments or fewer"
            empty="No contracts are nearing completion."
            items={upcoming.finishingSoon.map((row) => ({
              key: row.contractId,
              code: row.contractCode,
              title: row.customerName,
              detail: `${row.lotCode} · ${row.projectName}`,
              note: `${pluralise(row.installmentsLeft, "installment", "installments")} · ${formatMoney(
                row.balanceCents,
                money,
              )}`,
              isUrgent: false,
            }))}
          />

          <div className="card dash-card">
            <div className="card-head">
              <h3>Unpaid down payments</h3>
              <span className="tag">active contracts</span>
            </div>
            <div className="dash-card-body">
              {upcoming.unpaidPrimas.contracts === 0 ? (
                <p className="state-message">All agreed down payments have been paid in full.</p>
              ) : (
                <>
                  <p className="dash-figure">
                    {formatMoney(upcoming.unpaidPrimas.amountCents, money)}
                  </p>
                  <p className="dash-figure-label">
                    agreed and not received across{" "}
                    {pluralise(upcoming.unpaidPrimas.contracts, "contract", "contracts")}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
    ),

    control: data.control && (
          <div className="card dash-card dash-control">
            <div className="card-head">
              <h3>Oversight</h3>
              <span className="tag">{formatMonthName(data.month)}</span>
            </div>

            <div className="dash-card-body">
              {data.control.byUser.length === 0 ? (
                <p className="state-message">No payments were recorded this month.</p>
              ) : (
                <div className="table-wrap">
                  <table className="dash-table">
                    <thead>
                      <tr>
                        <th>Recorded by</th>
                        <th className="col-money">Total</th>
                        <th className="col-money">Cash</th>
                        <th>Transactions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.control.byUser.map((row) => (
                        <tr key={row.userId}>
                          <td>
                            <span className="holder-btn is-static">
                              <span className="holder-avatar">{getInitials(row.userName)}</span>
                              <span className="holder-name">{row.userName}</span>
                            </span>
                          </td>
                          <td className="col-money">{moneyCell(row.collectedCents)}</td>
                          <td className="col-money">
                            {/* Singled out because it is the only figure here that
                                passed through somebody's hands, not a bank's. */}
                            {moneyCell(row.cashCents, row.cashCents > 0 ? "is-balance" : "")}
                          </td>
                          <td className="mono">{row.payments}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="dash-flags">
                <div className="dash-flag">
                  <p className="dash-flag-label">Transfers without proof</p>
                  <p className="dash-flag-value">
                    {data.control.unprovenTransfers.count === 0
                      ? "None"
                      : `${data.control.unprovenTransfers.count} · ${formatMoney(
                          data.control.unprovenTransfers.amountCents,
                          money,
                        )}`}
                  </p>
                  <p className="dash-flag-note">
                    No confirmation number or deposit photo to compare against the bank statement.
                  </p>
                </div>

                <div className="dash-flag">
                  <p className="dash-flag-label">Voided receipts</p>
                  <p className="dash-flag-value">
                    {data.control.voidedReceipts.length === 0
                      ? "None"
                      : String(data.control.voidedReceipts.length)}
                  </p>
                  {data.control.voidedReceipts.length > 0 && (
                    <ul className="dash-flag-list">
                      {data.control.voidedReceipts.map((receipt) => (
                        <li key={receipt.id}>
                          <span className="code-badge">{receipt.code}</span>
                          <span className="dash-flag-list-name">{receipt.customerName}</span>
                          <span className="cell-sub">
                            {/* Always "anulado". It used to read "corregido"
                                when the receipt had been replaced by another,
                                but nothing ever recorded a replacement — a
                                correction rewrites the receipt in place — so
                                that branch never ran. See 0014. */}
                            voided{receipt.voidReason ? ` · ${receipt.voidReason}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </div>
    ),
  };

  /*
   * The first and last bands this account can actually see.
   *
   * Not `order[0]` and `order.at(-1)`: an associate has no Control band, so if
   * it happened to sit last, the band above it would show an enabled "move
   * down" that moved it past something invisible and appeared to do nothing.
   *
   * Below `sections` rather than beside the other state, and it has to stay
   * there: the callback runs immediately, so reading `sections` from above its
   * own declaration is a dead-zone error at runtime — one TypeScript cannot see
   * through a callback, and only the browser reports.
   */
  const movable = visible.order.filter((id) => sections[id] !== null);
  const firstMovable = movable[0];
  const lastMovable = movable.at(-1);

  return (
    <section className="panel active">
      <MonthPicker data={data} onSelectMonth={onSelectMonth} />

      <LayoutBar
        isEditing={draft !== null}
        isDefault={isDefaultLayout(visible)}
        isSaving={isSaving}
        error={error}
        onEdit={() => setDraft(visible)}
        onCancel={() => {
          setDraft(null);
          setError(null);
        }}
        onSave={() => void save()}
        onReset={() => void reset()}
      />

      {/*
        The bands, in this reader's order.

        Each one lays ITSELF out exactly as it always did — the running order is
        the only thing a preference decides, which is what makes every possible
        arrangement a valid page. See dashboardSections.ts.
      */}
      {visible.order.map((id) => {
        const content = sections[id];

        // A band this account cannot see — Control, for an associate — is
        // absent rather than empty, and is not offered in the editor either.
        if (!content) {
          return null;
        }

        if (draft === null) {
          return hiddenIds.has(id) ? null : (
            <div key={id} id={bandDomId(id)}>
              {content}
            </div>
          );
        }

        return (
          <SectionFrame
            key={id}
            id={id}
            isHidden={hiddenIds.has(id)}
            isFirst={id === firstMovable}
            isLast={id === lastMovable}
            isDragging={dragging === id}
            onMove={(direction) => setDraft({ ...draft, order: moveSection(draft.order, id, direction) })}
            onToggleHidden={() =>
              setDraft({
                ...draft,
                hidden: hiddenIds.has(id)
                  ? draft.hidden.filter((other) => other !== id)
                  : [...draft.hidden, id],
              })
            }
            onDragStart={() => setDragging(id)}
            onDragEnd={() => setDragging(null)}
            onDropBefore={() => {
              if (dragging) {
                setDraft({ ...draft, order: dropSection(draft.order, dragging, id) });
              }
              setDragging(null);
            }}
          >
            {content}
          </SectionFrame>
        );
      })}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Arranging the screen                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The bar that turns the editor on, and the controls it becomes.
 *
 * An explicit mode, rather than making the bands draggable all the time. A page
 * whose cards move when you brush past them is a page nobody trusts to read —
 * and it is a page you cannot select text on. While this is off, the screen is
 * exactly what it always was.
 */
function LayoutBar({
  isEditing,
  isDefault,
  isSaving,
  error,
  onEdit,
  onCancel,
  onSave,
  onReset,
}: {
  isEditing: boolean;
  isDefault: boolean;
  isSaving: boolean;
  error: string | null;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onReset: () => void;
}) {
  if (!isEditing) {
    return (
      <div className="dash-layout-bar">
        <button type="button" className="chip" onClick={onEdit}>
          Customize
        </button>
        {!isDefault && <span className="result-count">Custom order</span>}
      </div>
    );
  }

  return (
    <div className="dash-layout-bar is-editing">
      <p className="dash-layout-hint">
        Drag a section or use the arrows to move it. The eye hides it without removing it.
      </p>

      <div className="toolbar-spacer" />

      {error && <span className="dash-layout-error">{error}</span>}

      <button type="button" className="chip" onClick={onReset} disabled={isSaving || isDefault}>
        Restore default order
      </button>
      <button type="button" className="chip" onClick={onCancel} disabled={isSaving}>
        Cancel
      </button>
      <button type="button" className="btn-primary" onClick={onSave} disabled={isSaving}>
        {isSaving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

/**
 * One band while the screen is being arranged.
 *
 * The band's own content is rendered untouched inside it — the frame only adds
 * a header to grab and to press. That is the whole reason any arrangement is a
 * valid page: nothing in here can affect how a band lays itself out.
 *
 * Both ways of moving a band are real controls, and the buttons came first. A
 * drag handle is unusable with a keyboard, awkward with a screen reader, and
 * genuinely hard on a phone, where this app is often read; up and down arrows
 * work everywhere. Dragging is the shortcut for a mouse, not the mechanism.
 */
function SectionFrame({
  id,
  isHidden,
  isFirst,
  isLast,
  isDragging,
  onMove,
  onToggleHidden,
  onDragStart,
  onDragEnd,
  onDropBefore,
  children,
}: {
  id: SectionId;
  isHidden: boolean;
  isFirst: boolean;
  isLast: boolean;
  isDragging: boolean;
  onMove: (direction: -1 | 1) => void;
  onToggleHidden: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropBefore: () => void;
  children: ReactNode;
}) {
  const label = SECTION_LABELS[id];

  return (
    <section
      className={[
        "dash-section",
        isHidden ? "is-hidden" : "",
        isDragging ? "is-dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
      // The whole band is the drop target, not a thin line between bands: a
      // 4px gap is a target nobody hits, and the result of missing it is a card
      // that springs back to where it started.
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onDropBefore();
      }}
    >
      <header className="dash-section-bar" draggable onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <span className="dash-section-grip" aria-hidden="true">
          <IconDrag />
        </span>
        <span className="dash-section-name">{label}</span>

        <button
          type="button"
          className="row-action"
          onClick={onToggleHidden}
          title={isHidden ? `Show ${label}` : `Hide ${label}`}
          aria-label={isHidden ? `Show ${label}` : `Hide ${label}`}
          aria-pressed={isHidden}
        >
          {isHidden ? <IconEyeOff /> : <IconEye />}
        </button>

        <button
          type="button"
          className="row-action dash-section-up"
          onClick={() => onMove(-1)}
          disabled={isFirst}
          title={`Move ${label} up`}
          aria-label={`Move ${label} up`}
        >
          <IconChevronDown />
        </button>

        <button
          type="button"
          className="row-action"
          onClick={() => onMove(1)}
          disabled={isLast}
          title={`Move ${label} down`}
          aria-label={`Move ${label} down`}
        >
          <IconChevronDown />
        </button>
      </header>

      {/* Kept on screen while hidden, dimmed, so nothing can be folded away and
          then be impossible to find again. */}
      <div className="dash-section-body">{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Which month the whole screen is reporting.
 *
 * "Este mes" is a separate button from the arrows rather than a special case of
 * them: it returns the screen to asking the SERVER what month it is, which is
 * the only reading that stays right in a browser left open past midnight.
 */
function MonthPicker({
  data,
  onSelectMonth,
}: {
  data: Dashboard;
  onSelectMonth: (month: string | undefined) => void;
}) {
  const step = (delta: number) => {
    const year = Number(data.month.slice(0, 4));
    const index = Number(data.month.slice(5, 7)) - 1;

    return new Date(Date.UTC(year, index + delta, 1)).toISOString().slice(0, 7);
  };

  return (
    <div className="toolbar dash-toolbar">
      <div className="dash-month">
        <button
          type="button"
          className="chip dash-step"
          onClick={() => onSelectMonth(step(-1))}
          aria-label="Previous month"
        >
          <IconChevronDown />
        </button>

        <span className="dash-month-name">{formatMonth(data.month)}</span>

        <button
          type="button"
          className="chip dash-step is-next"
          onClick={() => onSelectMonth(step(1))}
          // There is nothing to report from a month that has not happened, and
          // the server refuses it — so the button is not offered either.
          disabled={data.isCurrentMonth}
          aria-label="Next month"
        >
          <IconChevronDown />
        </button>
      </div>

      {!data.isCurrentMonth && (
        <button type="button" className="chip" onClick={() => onSelectMonth(undefined)}>
          Back to this month
        </button>
      )}

      <div className="toolbar-spacer" />

      <span className="result-count">
        {data.isCurrentMonth
          ? `As of ${formatDate(data.asOf)}`
          : `As of the end of ${formatMonthName(data.month)}`}
      </span>
    </div>
  );
}

/** Label, value, and one line saying what the value is measured against. */
function StatTile({
  label,
  value,
  detail,
  tone,
  action,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "good" | "warn";
  /**
   * What following this figure does, if anything can be done with it.
   *
   * A tile with no action stays a plain `div` rather than becoming a button
   * that does nothing — a figure that looks pressable and is not teaches the
   * reader to stop trying the ones that are.
   */
  action?: {
    onClick: () => void;
    /** Spoken by a screen reader in place of the bare number. */
    hint: string;
    /** Set when the tile opens a panel underneath, so the caret can turn. */
    isOpen?: boolean;
  };
}) {
  const body = (
    <>
      <p className="dash-tile-label">
        {label}
        {action && (
          <span className="dash-tile-caret">
            <IconChevronDown />
          </span>
        )}
      </p>
      <p className={tone ? `dash-tile-value is-${tone}` : "dash-tile-value"}>{value}</p>
      <p className="dash-tile-detail">{detail}</p>
    </>
  );

  if (!action) {
    return <div className="card dash-tile">{body}</div>;
  }

  return (
    <button
      type="button"
      className={`card dash-tile is-actionable${action.isOpen ? " is-open" : ""}`}
      onClick={action.onClick}
      aria-expanded={action.isOpen}
      aria-label={`${label}: ${value}. ${action.hint}`}
    >
      {body}
    </button>
  );
}

/** Who paid this month, and what each of them paid. */
function PayersPanel({
  payments,
  money,
  monthName,
  onOpenContract,
  onClose,
}: {
  payments: MonthPayment[];
  money: MoneyView;
  monthName: string;
  onOpenContract: (contractId: string) => void;
  onClose: () => void;
}) {
  const payers = useMemo(() => groupPayers(payments), [payments]);
  const total = payments.reduce((sum, row) => sum + row.amountCents, 0) as Cents;

  return (
    <div className="card dash-drilldown">
      <div className="card-head">
        <h3>Customers who paid in {monthName}</h3>
        <button type="button" className="btn-ghost btn-small" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="table-wrap">
        <table className="dash-table is-payers">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Payments</th>
              <th className="col-money">Total</th>
            </tr>
          </thead>
          <tbody>
            {payers.map((payer) => (
              <tr key={payer.customerId}>
                <td>
                  {payer.customerName}
                  {/* The total again, under the name, for the width where the
                      column it normally lives in has been dropped. One number,
                      one source — see the `.dash-payer-total` rule. */}
                  <span className="cell-sub dash-payer-total">
                    {formatMoney(payer.totalCents, money)}
                  </span>
                </td>
                <td>
                  {/*
                    Every payment spelled out rather than counted. The count is
                    the thing a reader can already work out; what they came here
                    for is which lot the money went against and on what day.
                  */}
                  <div className="dash-payment-rows">
                    {payer.rows.map((row) => (
                      <button
                        key={row.id}
                        type="button"
                        className="dash-payment-row"
                        onClick={() => onOpenContract(row.contractId)}
                        title={`Open ${row.contractCode}`}
                      >
                        <span className="code-badge">{row.lotCode}</span>
                        <span className="cell-sub">{shortDay(row.paidOn)}</span>
                        <span className="cell-sub">
                          {PAYMENT_METHOD_LABELS[row.method] ?? row.method}
                        </span>
                        <span className="dash-payment-amount">
                          {formatMoney(row.amountCents, money)}
                        </span>
                      </button>
                    ))}
                  </div>
                </td>
                <td className="col-money">
                  <span className="cell-money">{formatMoney(payer.totalCents, money)}</span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">
                {pluralise(payers.length, "customer", "customers")}
              </th>
              <td>{pluralise(payments.length, "payment", "payments")}</td>
              <td className="col-money">
                <span className="cell-money">{formatMoney(total, money)}</span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/** The contracts signed this month, newest first. */
function SignedPanel({
  signed,
  money,
  monthName,
  onOpenContract,
  onClose,
}: {
  signed: SignedContract[];
  money: MoneyView;
  monthName: string;
  onOpenContract: (contractId: string) => void;
  onClose: () => void;
}) {
  const total = signed.reduce((sum, row) => sum + row.salePriceCents, 0) as Cents;

  return (
    <div className="card dash-drilldown">
      <div className="card-head">
        <h3>Contracts signed in {monthName}</h3>
        <button type="button" className="btn-ghost btn-small" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="table-wrap">
        <table className="dash-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Lot</th>
              <th>Signed</th>
              <th className="col-money">Value</th>
            </tr>
          </thead>
          <tbody>
            {signed.map((row) => (
              <tr
                key={row.contractId}
                className="is-clickable"
                onClick={() => onOpenContract(row.contractId)}
              >
                <td>
                  <span className="holder-text">
                    <span className="holder-name">{row.customerName}</span>
                    <span className="holder-contract">{row.contractCode}</span>
                  </span>
                </td>
                <td>
                  <span className="contract-lot">
                    <span className="code-badge">{row.lotCode}</span>
                    <span className="cell-sub">{row.projectName}</span>
                  </span>
                </td>
                <td>
                  <span className="cell-sub">{shortDay(row.signedOn)}</span>
                </td>
                <td className="col-money">
                  <span className="cell-money">{formatMoney(row.salePriceCents, money)}</span>
                  {row.downPaymentCents > 0 && (
                    <span className="cell-sub">
                      down payment {formatMoney(row.downPaymentCents, money)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={3}>
                {pluralise(signed.length, "contract", "contracts")}
              </th>
              <td className="col-money">
                <span className="cell-money">{formatMoney(total, money)}</span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/** One breakdown of the month's money, as bars that sum to the whole. */
function Split({
  title,
  rows,
  total,
  money,
}: {
  title: string;
  rows: Array<{ label: string; amount: Cents }>;
  total: Cents;
  money: MoneyView;
}) {
  // Rows worth nothing are dropped rather than drawn as empty tracks: a list of
  // zeroes is noise, and "Tarjeta L. 0" says nothing a missing row does not.
  const shown = rows.filter((row) => row.amount > 0);

  return (
    <div className="dash-split">
      <p className="dash-split-title">{title}</p>

      {shown.length === 0 ? (
        <p className="state-message">No activity.</p>
      ) : (
        <ul className="dash-split-list">
          {shown.map((row) => (
            <li key={row.label}>
              <span className="dash-split-label">{row.label}</span>
              <span className="dash-split-track">
                <span
                  className="dash-split-fill"
                  style={{ width: `${total > 0 ? (row.amount / total) * 100 : 0}%` }}
                />
              </span>
              <span className="dash-split-value mono">{formatMoney(row.amount, money)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Who crossed the line this month, in both directions.
 *
 * The lists are short by construction — only somebody who changed state inside
 * one month can appear — so they are shown in full rather than capped. An empty
 * one is normal early in a month and says so, instead of leaving a blank box to
 * be read as something broken.
 */
function ChangeLists({
  collections,
  month,
}: {
  collections: Dashboard["collections"];
  month: string;
}) {
  return (
    <div className="dash-changes">
      <div className="dash-change">
        <p className="dash-change-title">
          <span className="stamp clay">Fell behind</span>
          in {formatMonthName(month)}
        </p>
        {collections.slipped.length === 0 ? (
          <p className="dash-change-empty">No one else fell behind.</p>
        ) : (
          <ul className="dash-change-list">
            {collections.slipped.map((debtor) => (
              <li key={debtor.contractId}>
                <DebtorName debtor={debtor} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="dash-change">
        <p className="dash-change-title">
          <span className="stamp success">Caught up</span>
          in {formatMonthName(month)}
        </p>
        {collections.recovered.length === 0 ? (
          <p className="dash-change-empty">No one caught up.</p>
        ) : (
          <ul className="dash-change-list">
            {collections.recovered.map((debtor) => (
              <li key={debtor.contractId}>
                <DebtorName debtor={debtor} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A person with the lot they are behind on, and the number to call them at. */
function DebtorName({ debtor, onOpen }: { debtor: Debtor; onOpen?: () => void }) {
  if (onOpen) {
    return (
      <button
        type="button"
        className="holder-btn"
        onClick={(event) => {
          // The row is clickable too; without this the contract would be asked
          // for twice on one press.
          event.stopPropagation();
          onOpen();
        }}
        title={`Open ${debtor.contractCode}`}
      >
        <span className="holder-avatar">{getInitials(debtor.customerName)}</span>
        <span className="holder-text">
          <span className="holder-name">{debtor.customerName}</span>
          <span className="holder-contract">{debtor.contractCode}</span>
        </span>
      </button>
    );
  }

  return (
    <span className="holder-btn is-static">
      <span className="holder-avatar">{getInitials(debtor.customerName)}</span>
      <span className="holder-text">
        <span className="holder-name">{debtor.customerName}</span>
        <span className="holder-contract">{debtor.contractCode}</span>
      </span>
    </span>
  );
}

/** A short list of things that need attention before they become a problem. */
function AttentionCard({
  title,
  tag,
  empty,
  items,
}: {
  title: string;
  tag: string;
  empty: string;
  items: Array<{
    key: string;
    code: string;
    title: string;
    detail: string;
    note: string;
    isUrgent: boolean;
  }>;
}) {
  return (
    <div className="card dash-card">
      <div className="card-head">
        <h3>{title}</h3>
        <span className="tag">{tag}</span>
      </div>

      {items.length === 0 ? (
        <p className="state-message">{empty}</p>
      ) : (
        <ul className="dash-list">
          {items.map((item) => (
            <li key={item.key}>
              <span className="code-badge">{item.code}</span>
              <span className="dash-list-text">
                <span className="dash-list-title">{item.title}</span>
                <span className="cell-sub">{item.detail}</span>
              </span>
              <span className={item.isUrgent ? "dash-list-note is-urgent" : "dash-list-note"}>
                {item.note}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * How the collection meter is coloured.
 *
 * Three steps rather than a continuous ramp, because the reader is making a
 * decision, not reading a value: is this month fine, worth watching, or a
 * problem. The exact percentage is written beside it either way.
 */
function meterClass(rate: number): string {
  if (rate >= 90) {
    return "dash-meter-fill is-good";
  }

  return rate >= 70 ? "dash-meter-fill is-warn" : "dash-meter-fill is-bad";
}
