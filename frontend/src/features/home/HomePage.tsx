import type { Dashboard } from "../dashboard/api";
import { formatMoney, type MoneyView } from "../../lib/money";
import type { TabId } from "../../types";

interface HomePageProps {
  data: Dashboard;
  money: MoneyView;
  onNavigate: (tab: TabId) => void;
  onOpenContract: (contractId: string) => void;
  isPublic?: boolean;
}

export function HomePage({
  data,
  money,
  onNavigate,
  onOpenContract,
  isPublic = false,
}: HomePageProps) {
  const summaryCards = [
    {
      label: "Collected this month",
      value: formatMoney(data.income.collectedCents, money),
      note: `${data.income.payingCustomers} active customers`,
    },
    {
      label: "Still to collect",
      value: formatMoney(data.income.stillDueCents, money),
      note: `${data.income.stillDueContracts} active contracts`,
    },
    {
      label: "Signed contracts",
      value: `${data.income.signedCount}`,
      note: formatMoney(data.income.signedValueCents, money),
    },
    {
      label: "At-risk collections",
      value: `${data.collections.buckets
        .filter((bucket) => ["overdue", "at_risk"].includes(bucket.status))
        .reduce((total, bucket) => total + bucket.contracts, 0)}`,
      note: "Review this month's receivables",
    },
  ];

  const priorityContracts = data.collections.worklist.slice(0, 3);

  return (
    <section className="panel active home-page">
      <div className="home-hero card">
        <div>
          <p className="home-eyebrow">Home</p>
          <h2>Operations overview</h2>
          <p className="home-subtitle">
            {isPublic
              ? "Public operations overview. Sign-in is required to access records and management tools."
              : "Everything you need to manage operations, all in one place."}
          </p>
        </div>

        <div className="home-actions">
          <button type="button" className="btn-primary" onClick={() => onNavigate("contracts")}>
            View contracts
          </button>
          <button type="button" className="btn-secondary" onClick={() => onNavigate("lots")}>
            Review lots
          </button>
        </div>
      </div>

      <div className="home-grid">
        {summaryCards.map((card) => (
          <div key={card.label} className="card home-stat">
            <span className="home-stat-label">{card.label}</span>
            <strong>{card.value}</strong>
            <small>{card.note}</small>
          </div>
        ))}
      </div>

      <div className="home-columns">
        <div className="card home-panel">
          <div className="card-head">
            <h3>Needs attention</h3>
          </div>

          {priorityContracts.length === 0 ? (
            <p className="state-message">No contracts need review right now.</p>
          ) : (
            <ul className="home-list">
              {priorityContracts.map((item) => (
                <li key={item.contractId}>
                  <div>
                    <strong>{item.contractCode}</strong>
                    <span>
                      {item.customerName} · {item.projectName}
                    </span>
                  </div>
                  <button type="button" className="link-button" onClick={() => onOpenContract(item.contractId)}>
                    Open
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card home-panel">
          <div className="card-head">
            <h3>Quick access</h3>
          </div>

          <div className="home-links">
            <button type="button" className="home-link" onClick={() => onNavigate("projects")}>
              Projects
            </button>
            <button type="button" className="home-link" onClick={() => onNavigate("lots")}>
              Inventory
            </button>
            <button type="button" className="home-link" onClick={() => onNavigate("customers")}>
              Customers
            </button>
            <button type="button" className="home-link" onClick={() => onNavigate("receipts")}>
              Receipts
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
