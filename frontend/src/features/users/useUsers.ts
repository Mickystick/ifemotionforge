import { useCallback, useEffect, useState } from "react";

import type { UserAccount } from "./api";
import { fetchUsers } from "./api";

type UsersState =
  | { status: "loading" }
  | { status: "ready"; users: UserAccount[] }
  | { status: "error"; message: string };

/**
 * Loads the accounts and hands back a `reload`.
 *
 * Same shape as `useCustomers`, and a failed REFRESH leaves what is on screen
 * alone for the same reason: this reloads on its own when a teammate writes,
 * and blanking a working screen because one background request lost the wifi
 * would be worse than the staleness it replaced. The first load has nothing to
 * keep, so it still reports the failure.
 */
export function useUsers(enabled: boolean) {
  const [state, setState] = useState<UsersState>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      setState({ status: "ready", users: await fetchUsers() });
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Unable to load accounts.";

      setState((current) => (current.status === "ready" ? current : { status: "error", message }));
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      void reload();
    }
  }, [enabled, reload]);

  return { state, reload };
}
