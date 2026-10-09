import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../../lib/api";
import { fetchTransactions } from "./api";
import type { Transaction } from "../../types";

type TransactionsState =
  | { status: "loading" }
  | { status: "ready"; transactions: Transaction[] }
  | { status: "error"; message: string };

/**
 * Loads every posted transaction and hands back a `reload`.
 *
 * Like `useCustomers` and `useContracts`, this re-reads after every write
 * rather than patching the local array — and here it matters more than anywhere
 * else in the app. Every balance on a receipt is derived from the whole ledger,
 * so issuing, correcting or voiding ONE transaction changes the figures on
 * every receipt after it. Only the server knows the state afterwards.
 *
 * One request feeds both views of the screen. Grouping by customer happens in
 * `transactionSort.ts`, from this same array, so the two can never disagree
 * about what exists. A 401 on refresh goes to `onSessionExpired`, not the error
 * card.
 */
export function useTransactions(enabled: boolean, onSessionExpired: () => void) {
  const [state, setState] = useState<TransactionsState>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      setState({ status: "ready", transactions: await fetchTransactions() });
    } catch (caught) {
      if (caught instanceof ApiError && caught.isUnauthenticated) {
        onSessionExpired();
        return;
      }

      const message = caught instanceof Error ? caught.message : "Could not load transactions.";

      /*
       * A failed REFRESH leaves what is on screen alone.
       *
       * This used to be unconditional, and it was safe while `reload` only ever
       * ran because somebody pressed something — an error then was an answer to
       * a question they had just asked. Since lib/liveUpdates.ts, it also runs
       * on its own, when a teammate writes and when the tab comes back to the
       * front. Blanking a working screen into an error card because one
       * background request lost the wifi for a second would be a worse bug than
       * the staleness it replaced.
       *
       * The first load has nothing to keep, so it still reports the failure —
       * which is the case the error card and its Reintentar button are for.
       */
      setState((current) =>
        current.status === "ready" ? current : { status: "error", message },
      );
    }
  }, [onSessionExpired]);

  useEffect(() => {
    if (enabled) {
      void reload();
    }
  }, [enabled, reload]);

  return { state, reload };
}
