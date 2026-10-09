import { useCallback, useEffect, useState } from "react";
import { useRememberedState } from "../../lib/viewMemory";

import { businessTimeZone } from "../../lib/businessTime";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney } from "../../lib/money";
import { ROLE_LABELS } from "../../lib/permissions";
import type { ContractStatus } from "../../types";
import { STATUS_PRESENTATION } from "../contracts/contractPresentation";
import { paymentTypeLabel } from "../receipts/paymentType";
import { METHOD_LABELS } from "../receipts/transactionFilters";
import type { AuditAction, AuditEvent, AuditPage as AuditPageData } from "./api";
import { fetchAudit } from "./api";
import { formatAuditList } from "./auditLines";

const PAGE_SIZE = 25;

const actionPresentation: Record<AuditAction, { label: string; stampClass: string }> = {
  create: { label: "Created", stampClass: "stamp success" },
  update: { label: "Edited", stampClass: "stamp neutral" },
  reprice: { label: "Price changed", stampClass: "stamp clay" },
  archive: { label: "Archived", stampClass: "stamp danger" },
  restore: { label: "Restored", stampClass: "stamp success" },
  delete: { label: "Deleted", stampClass: "stamp danger" },
  cancel: { label: "Canceled", stampClass: "stamp danger" },
  reassign_lot: { label: "Lot corrected", stampClass: "stamp clay" },
  replace: { label: "Replaced by amendment", stampClass: "stamp clay" },
  reverse: { label: "Reversed", stampClass: "stamp danger" },
  // No longer written — sign-ins are kept on the account, not here — but the
  // rows recorded before that are still on file and still have to read.
  login: { label: "Sign-in", stampClass: "stamp neutral" },
  logout: { label: "Sign-out", stampClass: "stamp neutral" },
};

/** Field names as staff would say them, rather than as the database spells them. */
const fieldLabels: Record<string, string> = {
  code: "Lot",
  // A contract's lot, corrected — see POST /contracts/:id/reassign-lot.
  lotCode: "Lot",
  lotId: "Lot ID",
  fullName: "Customer",
  identification: "ID number",
  phone: "Phone",
  email: "Email",
  address: "Address",
  customerSince: "Customer since",
  notes: "Notes",
  projectId: "Project",
  areaM2: "Area",
  basePriceCents: "Base price",
  archivedAt: "Archived",
  // Account changes, from the Usuarios screen.
  name: "Name",
  role: "Role",
  deactivatedAt: "Account deactivated",
  passwordResetAt: "Password changed",
  // A contract's terms — edits, reprices, and the two sides of an adenda.
  status: "Status",
  saleType: "Payment type",
  salePriceCents: "Sale price",
  downPaymentCents: "Down payment",
  termMonths: "Term (months)",
  monthlyPaymentCents: "Installment",
  dueDay: "Due day",
  signedOn: "Signed",
  firstDueOn: "First installment",
  paidToDateCents: "Paid to date",
  settlement: "Amount paid",
  replacedBy: "Replaced by",
  replaces: "Replaces",
  // A payment corrected, and a receipt voided — which restates the whole
  // receipt, since issuing one leaves no row of its own.
  amountCents: "Amount",
  paidOn: "Payment date",
  method: "Method",
  type: "Type",
  reference: "Reference",
  receiptNumber: "Receipt number",
  customerName: "Customer",
  issuedBy: "Issued by",
  totalCents: "Total",
  lines: "Lots",
  // A file taken off a contract or a receipt. Putting one there is not filed.
  removedDocument: "Document removed",
  removedFile: "Payment proof removed",
};

/** Money fields are stored in centavos and must not be printed raw. */
const moneyFields = new Set([
  "basePriceCents",
  "salePriceCents",
  "amountCents",
  "downPaymentCents",
  "monthlyPaymentCents",
  "paidToDateCents",
  "totalCents",
]);

function formatValue(field: string, value: unknown, money: MoneyView): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (moneyFields.has(field) && typeof value === "number") {
    return formatMoney(cents(value), money);
  }
  if (field === "areaM2") {
    return `${String(value)} m²`;
  }
  // The lines of a receipt are a list of objects, which `String()` would turn
  // into "[object Object]".
  if (Array.isArray(value)) {
    return formatAuditList(value, money);
  }
  if (field === "method" && typeof value === "string") {
    return METHOD_LABELS.find((option) => option.value === value)?.label ?? value;
  }
  if (field === "type" && typeof value === "string") {
    return paymentTypeLabel(value);
  }
  // "replaced" is how the database spells it; "Replaced" is how it is said.
  if (field === "status" && typeof value === "string" && value in STATUS_PRESENTATION) {
    return STATUS_PRESENTATION[value as ContractStatus].label;
  }
  return String(value);
}

/** Only the fields that actually differ, so the reader is not made to hunt. */
function changedFields(event: AuditEvent): string[] {
  const keys = new Set([...Object.keys(event.before ?? {}), ...Object.keys(event.after ?? {})]);

  return [...keys].filter(
    (key) => JSON.stringify(event.before?.[key]) !== JSON.stringify(event.after?.[key]),
  );
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  // In the OFFICE's clock, not the reader's. This is a log of when things were
  // done at the counter, so a laptop set to another zone must not restate the
  // history three hours out — see lib/businessTime.ts.
  return parsed.toLocaleString("en-US", {
    timeZone: businessTimeZone(),
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type State =
  | { status: "loading" }
  | { status: "ready"; data: AuditPageData }
  | { status: "error"; message: string };

interface AuditPageProps {
  money: MoneyView;
}

export function AuditPage({ money }: AuditPageProps) {
  // The page being read survives a tab change, so checking something elsewhere
  // does not send the reader back to page one of the history.
  const [offset, setOffset] = useRememberedState("audit.offset", 0);
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(async (nextOffset: number) => {
    setState({ status: "loading" });
    try {
      setState({
        status: "ready",
        data: await fetchAudit({ limit: PAGE_SIZE, offset: nextOffset }),
      });
    } catch (caught) {
      setState({
        status: "error",
        message: caught instanceof Error ? caught.message : "Unable to load the history.",
      });
    }
  }, []);

  useEffect(() => {
    void load(offset);
  }, [load, offset]);

  if (state.status === "loading") {
    return (
      <section className="panel active">
        <div className="card">
          <p className="state-message">Loading history…</p>
        </div>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="panel active">
        <div className="card">
          <p className="form-error">{state.message}</p>
        </div>
      </section>
    );
  }

  const { events, total } = state.data;
  const hasPrevious = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <section className="panel active">
      <div className="card">
        <div className="card-head">
          <h3>Change history</h3>
          <span className="tag">{total} records</span>
        </div>

        {events.length === 0 ? (
          <p className="state-message">No changes have been recorded yet.</p>
        ) : (
          <div className="audit-list">
            {events.map((event) => {
              /*
               * Falls back rather than trusting the map to be complete.
               *
               * The server can record an action this screen has never heard of
               * — it did, for a while, with `restore` — and reading a missing
               * key off the table would throw while rendering, taking the WHOLE
               * history down over one unrecognised row. The history is the last
               * thing that should break, so an unknown action is shown as
               * itself instead.
               */
              const action = actionPresentation[event.action] ?? {
                label: event.action,
                stampClass: "stamp neutral",
              };
              const fields = changedFields(event);

              return (
                <article key={event.id} className="audit-item">
                  <div className="audit-head">
                    <span className={action.stampClass}>{action.label}</span>
                    {event.entityLabel && <span className="code-badge">{event.entityLabel}</span>}
                    <span className="audit-actor">
                      {event.actorName}
                      <span className="audit-role">{ROLE_LABELS[event.actorRole]}</span>
                    </span>
                    <time className="audit-time">{formatTimestamp(event.createdAt)}</time>
                  </div>

                  {fields.length > 0 && (
                    <div className="audit-diff">
                      {fields.map((field) => (
                        <div key={field} className="audit-diff-row">
                          <span className="audit-field">{fieldLabels[field] ?? field}</span>
                          <span className="audit-before">
                            {formatValue(field, event.before?.[field], money)}
                          </span>
                          <span className="audit-arrow" aria-hidden="true">
                            →
                          </span>
                          <span className="audit-after">
                            {formatValue(field, event.after?.[field], money)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {event.reason && <p className="audit-reason">“{event.reason}”</p>}
                </article>
              );
            })}
          </div>
        )}

        {(hasPrevious || hasNext) && (
          <div className="audit-pager">
            <button
              type="button"
              className="btn-secondary"
              disabled={!hasPrevious}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </button>
            <span className="audit-range">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </span>
            <button
              type="button"
              className="btn-secondary"
              disabled={!hasNext}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
