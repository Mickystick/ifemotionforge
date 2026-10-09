import { useEffect, useMemo, useState } from "react";

import type { Capability } from "../../lib/permissions";
import type { PermissionsData } from "./api";
import { fetchPermissions, savePermissions } from "./api";

/**
 * How each capability reads to a person, grouped the way somebody thinks about
 * the work rather than the way the code is organised.
 *
 * Every entry says what the associate would be able to DO, in the words used
 * elsewhere in the interface — "Archivar lotes", not "lot:archive".
 */
const GROUPS: Array<{
  title: string;
  description: string;
  items: Array<{ capability: Capability; label: string; hint?: string }>;
}> = [
  {
    title: "Lots",
    description: "The land inventory.",
    items: [
      { capability: "lot:create", label: "Create lots" },
      { capability: "lot:edit", label: "Edit lots" },
      {
        capability: "lot:archive",
        label: "Archive lots",
        hint: "Removes them from active inventory; nothing is deleted.",
      },
    ],
  },
  {
    title: "Projects",
    description: "Developments that group lots together.",
    items: [
      { capability: "project:create", label: "Create projects" },
      { capability: "project:edit", label: "Edit projects and their area unit" },
      { capability: "project:archive", label: "Archive projects" },
    ],
  },
  {
    title: "Customers and contracts",
    description: "Day-to-day work.",
    items: [
      { capability: "customer:create", label: "Add customers" },
      { capability: "customer:edit", label: "Edit customers" },
      {
        capability: "customer:delete",
        label: "Delete customers",
        hint: "Only customers who have never had a contract. Requires a reason.",
      },
      { capability: "contract:create", label: "Create contracts and reservations" },
      {
        capability: "contract:edit",
        label: "Edit contract terms",
        hint:
          "Term, payment amount, due day, dates, and notes. Always requires a reason because " +
          "it changes what was signed. Sale price is managed separately.",
      },
      {
        capability: "contract:reprice",
        label: "Change a contract's sale price",
        hint:
          "Changes what the customer owes. You can grant “Edit contract terms” without this: " +
          "moving a due date and changing a balance require different levels of trust.",
      },
      {
        capability: "contract:reassign_lot",
        label: "Correct a contract's lot",
        hint:
          "Only for a lot entered incorrectly: the contract moves to another lot and keeps its " +
          "payments. This isn't for selling a different lot—that requires a new contract. " +
          "Requires a reason.",
      },
      {
        capability: "contract:amend",
        label: "Record amendments",
        hint:
          "A new agreement for active contracts: closes them as “Replaced,” keeping their " +
          "payments and receipts intact, and opens new contracts with the new price and term. " +
          "Requires a reason.",
      },
      {
        capability: "contract:cancel",
        label: "Cancel contracts",
        hint: "Frees the lot and keeps the contract in the history.",
      },
    ],
  },
  {
    title: "Payments",
    description: "Actions that affect balances. Think carefully before granting these.",
    items: [
      { capability: "payment:record", label: "Record payments" },
      {
        capability: "payment:reverse",
        label: "Reverse payments and void receipts",
        hint:
          "Records a reversal: the original payment remains visible but no longer counts. " +
          "Doesn't allow changing the amount—that's a separate action.",
      },
      {
        capability: "payment:edit",
        label: "Correct a recorded transaction",
        hint:
          "Replaces a payment's amount or date instead of reversing it. The previous value " +
          "remains only in the history, so this requires more trust than reversing. Requires a reason.",
      },
      {
        capability: "price:change",
        label: "Change the price of a lot with a contract",
        hint: "Requires a reason, which is kept in the history.",
      },
      {
        capability: "rate:edit",
        label: "Change the exchange rate",
        hint: "Only affects what's shown on screen, never a balance.",
      },
    ],
  },
  {
    title: "Control",
    description: "See what has happened in the system.",
    items: [
      {
        capability: "audit:view",
        label: "View history",
        hint: "Who changed what, when, and why.",
      },
    ],
  },
];

interface PermissionsPageProps {
  /** Called after a successful save, so the app can re-read its own session. */
  onSaved: () => void;
}

/**
 * The supervisor's switchboard for what the associate role may do.
 *
 * Per ROLE, not per person: every associate account follows these switches, so
 * a new hire is governed by the same rules without anybody configuring them.
 */
export function PermissionsPage({ onSaved }: PermissionsPageProps) {
  const [data, setData] = useState<PermissionsData | null>(null);
  const [granted, setGranted] = useState<Set<Capability>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    fetchPermissions()
      .then((loaded) => {
        setData(loaded);
        setGranted(
          new Set(loaded.capabilities.filter((row) => row.enabled).map((row) => row.capability)),
        );
      })
      .catch((caught: unknown) =>
        setLoadError(
          caught instanceof Error ? caught.message : "Unable to load permissions.",
        ),
      );
  }, []);

  // The saved set, for comparison — so the Guardar button can tell the
  // supervisor whether anything is actually pending.
  const savedSet = useMemo(
    () => new Set(data?.capabilities.filter((row) => row.enabled).map((row) => row.capability)),
    [data],
  );

  const isDirty =
    granted.size !== savedSet.size || [...granted].some((capability) => !savedSet.has(capability));

  const toggle = (capability: Capability) => {
    setSavedAt(null);
    setGranted((current) => {
      const next = new Set(current);
      if (next.has(capability)) {
        next.delete(capability);
      } else {
        next.add(capability);
      }
      return next;
    });
  };

  const handleSave = async () => {
    setSaveError(null);
    setSaving(true);

    try {
      const result = await savePermissions([...granted]);

      setData((current) =>
        current
          ? {
              ...current,
              capabilities: current.capabilities.map((row) => ({
                ...row,
                enabled: result.capabilities.includes(row.capability),
              })),
            }
          : current,
      );
      setSavedAt(Date.now());
      onSaved();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Unable to save changes.");
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <section className="panel active">
        <div className="card">
          <p className="form-error">{loadError}</p>
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="panel active">
        <div className="card">
          <p className="state-message">Loading permissions…</p>
        </div>
      </section>
    );
  }

  const offered = new Set(data.capabilities.map((row) => row.capability));

  /*
   * Anything the server offers that the list above has never heard of.
   *
   * `GROUPS` is written by hand, and the failure it invites is silent: add a
   * capability to the server and forget the entry here, and the switch simply
   * does not exist. Nobody sees a gap — they see a complete-looking page — and
   * the new power stays permanently off for the associate while appearing to
   * nobody as a decision. That is the same class of bug as a permission that
   * looks granted and is not.
   *
   * So an undescribed capability is shown rather than dropped. It reads badly
   * on purpose — a raw `payment:edit` next to a plea for a proper label is
   * exactly the nudge needed — but the supervisor can still grant it, and it
   * cannot go missing.
   */
  const described = new Set(GROUPS.flatMap((group) => group.items.map((item) => item.capability)));
  const undescribed = data.capabilities.filter((row) => !described.has(row.capability));

  const groups =
    undescribed.length === 0
      ? GROUPS
      : [
          ...GROUPS,
          {
            title: "Other permissions",
            description:
              "Permissions offered by the server that this screen doesn't know how to describe yet. " +
              "They work normally; they just need a label.",
            items: undescribed.map((row) => ({
              capability: row.capability,
              label: row.capability,
              hint: undefined,
            })),
          },
        ];

  return (
    <section className="panel active">
      <div className="card permissions-intro">
        <h3>What staff can do</h3>
        <p>
          These switches apply to <strong>all staff accounts</strong>. Changes take effect
          immediately, even if a staff member already has the app open, and are recorded in the
          history with your name.
        </p>
      </div>

      {groups.map((group) => {
        const items = group.items.filter((item) => offered.has(item.capability));

        if (items.length === 0) {
          return null;
        }

        return (
          <div key={group.title} className="card permission-group">
            <header className="permission-group-head">
              <h3>{group.title}</h3>
              <p className="field-hint">{group.description}</p>
            </header>

            <ul className="permission-list">
              {items.map((item) => {
                const isOn = granted.has(item.capability);

                return (
                  <li key={item.capability}>
                    <label className="permission-row">
                      <input
                        type="checkbox"
                        className="permission-switch"
                        checked={isOn}
                        onChange={() => toggle(item.capability)}
                      />
                      <span className="permission-text">
                        <span className="permission-label">{item.label}</span>
                        {item.hint && <span className="field-hint">{item.hint}</span>}
                      </span>
                      <span className={isOn ? "stamp success" : "stamp neutral"}>
                        {isOn ? "Allowed" : "Blocked"}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}

      <div className="card permission-locked">
        <h3>Owner-only permissions</h3>
        <p className="field-hint">
          User management and permission editing can't be delegated. If staff could edit
          permissions, they could grant themselves everything else—including the ability to
          remove it.
        </p>
      </div>

      <div className="permission-actions">
        {saveError && <p className="form-error">{saveError}</p>}
        {savedAt !== null && !isDirty && <p className="field-hint">Changes saved.</p>}
        <button
          type="button"
          className="btn-primary"
          disabled={!isDirty || isSaving}
          onClick={() => void handleSave()}
        >
          {isSaving ? "Saving…" : "Save permissions"}
        </button>
      </div>
    </section>
  );
}
