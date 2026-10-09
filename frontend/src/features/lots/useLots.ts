import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../../lib/api";
import type { LotsData } from "./api";
import { fetchLots } from "./api";

type LotsState =
  | { status: "loading" }
  | { status: "ready"; data: LotsData }
  | { status: "error"; message: string };

/**
 * Loads the inventory from the API and hands back a `reload` function.
 *
 * After any write — an edit, an archive — call `reload()` rather than patching
 * the local array by hand. The server is the authority on derived values like
 * lot status and paid-to-date, so re-reading it is how the screen stays honest.
 *
 * A 401 on refresh is passed to `onSessionExpired` rather than shown as a load
 * error: once the session is gone the only useful move is the login screen, and
 * a "reintentar" button that can only 401 again is not it.
 */
export function useLots(enabled: boolean, onSessionExpired: () => void) {
  const [state, setState] = useState<LotsState>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      setState({ status: "ready", data: await fetchLots() });
    } catch (caught) {
      if (caught instanceof ApiError && caught.isUnauthenticated) {
        onSessionExpired();
        return;
      }

      const message = caught instanceof Error ? caught.message : "Could not load the inventory.";

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
