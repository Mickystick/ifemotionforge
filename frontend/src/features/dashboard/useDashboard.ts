import { useCallback, useEffect, useRef, useState } from "react";

import type { Dashboard } from "./api";
import { fetchDashboard } from "./api";

type DashboardState =
  | { status: "loading" }
  | { status: "ready"; data: Dashboard }
  | { status: "error"; message: string };

/**
 * Loads the Panel General for one month, and hands back a `reload`.
 *
 * The month lives here rather than in App, because it is this screen's own
 * state and nothing else in the app has an opinion about it. `undefined` means
 * "whatever month the server thinks it is", which is the right default: a
 * browser left open past midnight on the 31st must not keep asking for last
 * month because it decided what "now" was at page load.
 */
export function useDashboard(enabled: boolean) {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [state, setState] = useState<DashboardState>({ status: "loading" });

  /*
   * Which request is the current one.
   *
   * Paging through months is a click away, so two requests are genuinely in
   * flight at once here in a way they never are on the other screens — and
   * without this, a slow answer for July landing after a fast one for August
   * would leave August selected with July's figures under it, with nothing on
   * screen admitting the mismatch.
   */
  const latestRequest = useRef(0);

  const reload = useCallback(async () => {
    const request = (latestRequest.current += 1);

    try {
      const data = await fetchDashboard(month);

      if (request === latestRequest.current) {
        setState({ status: "ready", data });
      }
    } catch (caught) {
      if (request !== latestRequest.current) {
        return;
      }

      const message =
        caught instanceof Error ? caught.message : "Could not load the dashboard.";

      /*
       * A failed REFRESH leaves what is on screen alone, exactly as the other
       * list hooks do: this reload also runs on its own when a teammate writes
       * and when the tab comes back to the front, and blanking a working screen
       * because one background request lost the wifi for a second is a worse
       * bug than the staleness it replaces.
       *
       * The first load has nothing to keep, so it still reports the failure —
       * which is the case the error card and its Reintentar button are for.
       */
      setState((current) => (current.status === "ready" ? current : { status: "error", message }));
    }
  }, [month]);

  useEffect(() => {
    if (enabled) {
      void reload();
    }
  }, [enabled, reload]);

  return { state, reload, month, setMonth };
}
