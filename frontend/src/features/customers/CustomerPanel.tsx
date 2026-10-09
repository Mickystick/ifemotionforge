import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { hasIdentification, identificationLabel } from "../../lib/identification";
import { getInitials } from "../../lib/initials";
import { formatPhone } from "../../lib/phone";
import type { MoneyView } from "../../lib/money";
import { formatMoney, subtractMoney } from "../../lib/money";
import type { Customer, Lot } from "../../types";

interface CustomerPanelProps {
  customer: Customer;
  /** The lot the user clicked from, giving the panel its contract context. */
  lot: Lot;
  money: MoneyView;
  onClose: () => void;
  /** Jump to the full Clientes screen. */
  onViewFullRecord: () => void;
}

export function CustomerPanel({
  customer,
  lot,
  money,
  onClose,
  onViewFullRecord,
}: CustomerPanelProps) {
  const holding = lot.holding;
  const balance = holding ? subtractMoney(holding.salePrice, holding.paidToDate) : null;

  return (
    <Dialog ariaLabel={customer.fullName} onClose={onClose}>
        <div className="modal-header">
          <div className="cp-identity">
            <div className="cust-avatar cp-avatar">{getInitials(customer.fullName)}</div>
            <div>
              <p className="modal-eyebrow">Customer</p>
              <h2>{customer.fullName}</h2>
              <p className="modal-description">
                Customer since {customer.customerSince} · Lot {lot.code}
              </p>
            </div>
          </div>

          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <IconClose />
          </button>
        </div>

        <div className="cp-body">
          <section className="cp-section">
            <h3 className="cp-section-title">Contact</h3>
            <div className="cp-row">
              <span>ID number</span>
              <span className={hasIdentification(customer.identification) ? "mono" : "holder-empty"}>
                {identificationLabel(customer.identification)}
              </span>
            </div>
            <div className="cp-row">
              <span>Phone</span>
              {/* Stored with its country code; read back the local way. `null`
                  when it was never given — a paid-off lot may never have
                  needed one. */}
              <span className="mono">
                {customer.phone ? formatPhone(customer.phone) : "—"}
              </span>
            </div>
            <div className="cp-row">
              <span>Email</span>
              <span>{customer.email ?? "—"}</span>
            </div>
            <div className="cp-row">
              <span>Address</span>
              <span>{customer.address ?? "—"}</span>
            </div>
          </section>

          {holding && balance !== null && (
            <section className="cp-section">
              <h3 className="cp-section-title">
                {holding.kind === "reservation" ? "Reservation" : "Contract"}
              </h3>
              <div className="cp-row">
                <span>Number</span>
                <span className="mono">{holding.contractCode}</span>
              </div>
              <div className="cp-row">
                <span>Lot</span>
                <span>
                  <span className="code-badge">{lot.code}</span>
                </span>
              </div>
              <div className="cp-row">
                <span>Project</span>
                <span>{lot.projectName}</span>
              </div>
              <div className="cp-row">
                <span>Sale price</span>
                <span className="cell-money">{formatMoney(holding.salePrice, money)}</span>
              </div>
              <div className="cp-row">
                <span>Paid</span>
                <span className="cell-money">{formatMoney(holding.paidToDate, money)}</span>
              </div>
              <div className="cp-row cp-row-total">
                <span>Balance</span>
                <span className="cell-money">{formatMoney(balance, money)}</span>
              </div>
              <p className="cp-note">
                The balance is calculated from recorded payments. It can't be edited.
              </p>
            </section>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn-primary" onClick={onViewFullRecord}>
            <span>View full record</span>
          </button>
        </div>
    </Dialog>
  );
}