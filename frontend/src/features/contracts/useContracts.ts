import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../../lib/api";
import type { Contract } from "../../types";
import { fetchContracts } from "./api";

type ContractsState =
  | { status: "loading" }
  | { status: "ready"; contracts: Contract[] }
  | { status: "error"; message: string };

/**
 * Loads the contracts from the API and hands back a `reload` function.
 *
 * After any write, call `reload()` rather than patching the local array. Almost
 * everything on this screen — the balance, the arrears, the payment health, the
 * next due date — is computed by the server at the moment of the request, so
 * re-reading is the only way the numbers stay true. A 401 on refresh goes to
 * `onSessionExpired`, not the error card.
 */
export function useContracts(enabled: boolean, onSessionExpired: () => void) {
  const [state, setState] = useState<ContractsState>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      setState({ status: "ready", contracts: await fetchContracts() });
    } catch (caught) {
      if (caught instanceof ApiError && caught.isUnauthenticated) {
        onSessionExpired();
        return;
      }

      const message = caught instanceof Error ? caught.message : "Could not load contracts.";

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
