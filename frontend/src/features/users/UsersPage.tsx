import { useState } from "react";
import { useRememberedState } from "../../lib/viewMemory";

import { IconEdit, IconPermissions, IconRestore, IconArchive } from "../../components/Icons";
import { businessTimeZone, calendarDaysBetween } from "../../lib/businessTime";
import { getInitials } from "../../lib/initials";
import { ROLE_LABELS } from "../../lib/permissions";
import { parseTimestamp } from "../../lib/time";
import type { UserAccount } from "./api";

interface UsersPageProps {
  users: UserAccount[];
  onCreate: () => void;
  onEdit: (account: UserAccount) => void;
  onResetPassword: (account: UserAccount) => void;
  onDeactivate: (account: UserAccount) => void;
  onReactivate: (account: UserAccount) => Promise<void>;
}

/**
 * When somebody last signed in, said the way a person would say it.
 *
 * "Hace 3 días" answers the question a supervisor is actually asking — is this
 * account still in use — which an exact timestamp makes them work out for
 * themselves. Anything past a month is old enough that the date is the more
 * useful answer again.
 *
 * Never having signed in is handled by the caller, since it is not a date at
 * all: it is what a brand new account looks like, and how a supervisor spots
 * the hire who never got in because the password was mistyped when it was
 * handed over.
 */
function describeSignIn(value: string): string {
  const then = parseTimestamp(value);

  if (Number.isNaN(then)) {
    return value;
  }

  /*
   * CALENDAR days in the office, not elapsed twenty-four-hour blocks.
   *
   * `(Date.now() - then) / 86_400_000` is the obvious spelling and it answers a
   * different question: somebody who signed in at nine last night is fifteen
   * hours ago, so it says "Hoy" until nine tonight. A supervisor asking when an
   * account was last used means yesterday, and being told "today" about an
   * account nobody has touched since yesterday evening is exactly the wrong
   * answer for the thing this column is read for.
   */
  const days = calendarDaysBetween(new Date(then), new Date());

  if (days <= 0) {
    return "Today";
  }
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 30) {
    return `${days} days ago`;
  }

  // The office's clock, for the same reason as the Historial screen.
  return new Date(then).toLocaleDateString("en-US", {
    timeZone: businessTimeZone(),
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * The accounts that can sign in: who exists, what role they hold, and whether
 * they still have a way in.
 *
 * This screen is about PEOPLE. What the associate role is allowed to do is the
 * Permisos screen's question, and the two are kept apart deliberately — hiring
 * is a weekly job, while deciding what an associate is trusted with is a rare
 * decision that deserves its own screen.
 */
export function UsersPage({
  users,
  onCreate,
  onEdit,
  onResetPassword,
  onDeactivate,
  onReactivate,
}: UsersPageProps) {
  // Deactivated accounts are kept off the working list by default, exactly like
  // archived projects — but one click away, since a rehire is a real thing.
  const [showDeactivated, setShowDeactivated] = useRememberedState(
    "users.showDeactivated",
    false,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = users.filter((account) => account.deactivatedAt === null);
  const deactivated = users.filter((account) => account.deactivatedAt !== null);
  const visible = showDeactivated ? deactivated : active;

  const handleReactivate = async (account: UserAccount) => {
    setError(null);
    setBusyId(account.id);

    try {
      await onReactivate(account);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : `Unable to reactivate ${account.name}.`,
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="panel active">
      <div className="card users-intro">
        <h3>Who can sign in</h3>
        <p>
          Everyone who uses Lindero needs their own account. Sharing one account makes the
          history unreliable: all activity appears under the same name, leaving the question
          “who recorded this payment?” unanswered.
        </p>
        <p className="field-hint">
          What a staff member <strong>can do</strong> is set on the Permissions screen, not here,
          and applies equally to all staff accounts.
        </p>
      </div>

      <div className="toolbar">
        <button
          type="button"
          className={showDeactivated ? "chip" : "chip active"}
          onClick={() => setShowDeactivated(false)}
        >
          Active ({active.length})
        </button>
        <button
          type="button"
          className={showDeactivated ? "chip active" : "chip"}
          onClick={() => setShowDeactivated(true)}
        >
          Deactivated ({deactivated.length})
        </button>
      </div>

      {error && (
        <div className="card">
          <p className="form-error">{error}</p>
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Email</th>
                <th>Rol</th>
                <th>Last sign-in</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((account) => {
                const isDeactivated = account.deactivatedAt !== null;
                const isBusy = busyId === account.id;

                return (
                  <tr key={account.id}>
                    <td>
                      <span className="holder-btn is-static">
                        <span className="holder-avatar">{getInitials(account.name)}</span>
                        <span className="holder-text">
                          <span className="holder-name">{account.name}</span>
                          <span className="holder-contract">
                            {account.isSelf ? "Your account" : ROLE_LABELS[account.role]}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="mono">{account.email}</td>
                    <td>
                      <span
                        className={
                          isDeactivated
                            ? "stamp neutral"
                            : account.role === "owner"
                              ? "stamp clay"
                              : "stamp success"
                        }
                      >
                        {isDeactivated ? "Deactivated" : ROLE_LABELS[account.role]}
                      </span>
                    </td>
                    <td>
                      {account.lastSignInAt === null ? (
                        // Not blank: an empty cell reads as data that failed to
                        // load rather than an account nobody has used yet.
                        <span className="holder-empty">Never signed in</span>
                      ) : (
                        describeSignIn(account.lastSignInAt)
                      )}
                    </td>
                    <td>
                      <span className="row-actions">
                        {isDeactivated ? (
                          <button
                            type="button"
                            className="row-action"
                            disabled={isBusy}
                            onClick={() => void handleReactivate(account)}
                            title={`Reactivate ${account.name}'s account`}
                            aria-label={`Reactivate ${account.name}'s account`}
                          >
                            <IconRestore />
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="row-action"
                              onClick={() => onEdit(account)}
                              title={`Edit ${account.name}'s account`}
                              aria-label={`Edit ${account.name}'s account`}
                            >
                              <IconEdit />
                            </button>
                            <button
                              type="button"
                              className="row-action"
                              onClick={() => onResetPassword(account)}
                              title={`Change ${account.name}'s password`}
                              aria-label={`Change ${account.name}'s password`}
                            >
                              <IconPermissions />
                            </button>
                            {/* Hidden on your own row rather than shown and
                                refused: the server says no, but a button that
                                locks you out of the app on the next click is
                                not one to offer in the first place. */}
                            {!account.isSelf && (
                              <button
                                type="button"
                                className="row-action danger"
                                onClick={() => onDeactivate(account)}
                                title={`Deactivate ${account.name}'s account`}
                                aria-label={`Deactivate ${account.name}'s account`}
                              >
                                <IconArchive />
                              </button>
                            )}
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}

              {visible.length === 0 && (
                <tr>
                  <td colSpan={5} className="table-empty">
                    {showDeactivated ? (
                      "No deactivated accounts."
                    ) : (
                      <>
                        <p>There are no active accounts besides yours yet.</p>
                        <button type="button" className="link-btn" onClick={onCreate}>
                          Create the first account
                        </button>
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
