import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../../lib/api";
import { fetchProjects } from "./api";
import type { Project } from "../../types";

type ProjectsState =
  | { status: "loading" }
  | { status: "ready"; projects: Project[] }
  | { status: "error"; message: string };

/**
 * Loads the projects and hands back a `reload`.
 *
 * Like `useLots`, this re-reads after every write rather than patching the
 * local array: the counts on each project are computed server-side, so only the
 * server knows what they are after a change. A 401 on refresh goes to
 * `onSessionExpired`, not the error card.
 */
export function useProjects(enabled: boolean, onSessionExpired: () => void) {
  const [state, setState] = useState<ProjectsState>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      setState({ status: "ready", projects: await fetchProjects() });
    } catch (caught) {
      if (caught instanceof ApiError && caught.isUnauthenticated) {
        onSessionExpired();
        return;
      }

      const message = caught instanceof Error ? caught.message : "Could not load the projects.";

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
